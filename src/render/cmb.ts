import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { sceneToIcrf } from '../core/frames';
import { ICRS_TO_GAL } from '../core/milkyway';
import { T_CMB, V_BAND_K } from '../core/relativity';
import { RELATIVITY_GLSL, relativityUniforms } from './relativity';
import { STAR_GLSL } from './stars';

const vertexShader = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
varying vec2 vNdc;
uniform sampler2D uMap;
uniform mat3 uRay;
uniform vec2 uTan;
uniform vec3 uCam;
uniform float uRadius;
uniform float uOpacity;
// Display value of the Sun's surface brightness in V, for the background's real light.
uniform float uLight;
// The background squeezed into a point ahead (when its patch is under a pixel): peak
// value, blur (device pixels), colour temperature, and device pixels per radian.
uniform float uPoint;
uniform float uPointSigma;
uniform float uPointT;
uniform float uPpr;
${STAR_GLSL}
${RELATIVITY_GLSL}

// False colour for the temperature difference t (-1 cold to +1 hot, i.e. +-500 uK), after
// the Planck team's maps: deep blue through pale cream to red. sRGB.
vec3 palette(float t) {
  vec3 c0 = vec3(0.00, 0.03, 0.40), c1 = vec3(0.10, 0.45, 0.95), c2 = vec3(0.98, 0.94, 0.86);
  vec3 c3 = vec3(1.00, 0.55, 0.12), c4 = vec3(0.55, 0.02, 0.00);
  float x = clamp(t, -1.0, 1.0) * 2.0;
  if (x < -1.0) return mix(c0, c1, x + 2.0);
  if (x < 0.0) return mix(c1, c2, x + 1.0);
  if (x < 1.0) return mix(c2, c3, x);
  return mix(c3, c4, x - 1.0);
}

void main() {
  // From a ship near light speed: aberration and Doppler shift (core/relativity.ts).
  vec3 ray = normalize(vec3(vNdc * uTan, -1.0));
  vec3 seen = restDir(ray);
  float D = dopplerRest(seen);
  vec3 dir = normalize(uRay * seen);
  // The last-scattering surface as the sphere we see it on, centred on the Sun: from
  // elsewhere the ray meets that same shell (from outside, its near side, as a globe).
  vec3 point = vec3(0.0);
  if (uPoint > 0.0) {
    float off = length(cross(ray, normalize(uBetaView))) * uPpr;
    vec3 lin = kelvinToRgb(min(uPointT, 40000.0));
    lin = min(lin / dot(lin, vec3(0.2126, 0.7152, 0.0722)) * uPoint * exp(-0.5 * off * off / (uPointSigma * uPointSigma)), 1.0);
    if (dot(ray, uBetaView) > 0.0) point = mix(lin * 12.92, 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, lin));
  }
  float b = dot(uCam, dir);
  float c = dot(uCam, uCam) - uRadius * uRadius;
  float disc = b * b - c;
  float t = c > 0.0 ? -b - sqrt(max(disc, 0.0)) : -b + sqrt(max(disc, 0.0));
  if (disc < 0.0 || t < 0.0) {
    if (max(point.r, max(point.g, point.b)) <= 0.0) discard;
    gl_FragColor = vec4(point, 1.0);
    return;
  }
  vec3 p = normalize(uCam + dir * t);
  float l = atan(p.y, p.x);
  float lat = asin(clamp(p.z, -1.0, 1.0));
  vec2 uv = vec2(0.5 - l / 6.28318531, 0.5 + lat / 3.14159265);
  // Mip level from the derivatives of whichever longitude is continuous here (the map's
  // seam at l = 180 deg would otherwise pick the coarsest level along a line).
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec2 uvSeam = vec2(fract(uv.x + 0.5), uv.y);
  vec2 dx2 = dFdx(uvSeam), dy2 = dFdy(uvSeam);
  if (abs(dx2.x) + abs(dy2.x) < abs(dx.x) + abs(dy.x)) { dx.x = dx2.x; dy.x = dy2.x; }
  float v = textureGrad(uMap, uv, dx, dy).r * 2.0 - 1.0;
  // The temperature this way, with the map's +-500 uK, Doppler shifted: the false colour
  // shows the difference from ${T_CMB} K (the motion's dipole swamps the map's ripples).
  float temp = (${T_CMB} + v * 5e-4) * D;
  vec3 col = palette(clamp((temp - ${T_CMB}) / 5e-4, -1.0, 1.0)) * uOpacity;
  // Its real light, a blackbody at that temperature: invisible until D is in the hundreds.
  if (uLight > 0.0 && temp > 300.0) {
    float x = ${V_BAND_K.toFixed(1)};
    float gain = min(exp(min(log(uLight) + logExpm1(x / 5772.0) - logExpm1(x / temp), 30.0)), 1e6);
    vec3 lin = kelvinToRgb(temp);
    lin = min(lin / dot(lin, vec3(0.2126, 0.7152, 0.0722)) * gain, 1.0);
    col += mix(lin * 12.92, 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, lin));
  }
  gl_FragColor = vec4(col + point, 1.0);
}
`;

/**
 * The cosmic microwave background (Planck), drawn in false colour on the sphere of last
 * scattering: the light is microwaves, invisible to the eye, so this is a layer to turn
 * on rather than part of the visible sky.
 */
export class CmbLayer {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly sceneToGal = new THREE.Matrix3();
  private readonly rot = new THREE.Matrix3();

  /** @param radiusMpc comoving distance of last scattering. */
  constructor(map: THREE.Texture, radiusMpc: number) {
    map.colorSpace = THREE.NoColorSpace;
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.ClampToEdgeWrapping;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map },
        uRay: { value: new THREE.Matrix3() },
        uTan: { value: new THREE.Vector2(1, 1) },
        uCam: { value: new THREE.Vector3() },
        uRadius: { value: radiusMpc },
        uOpacity: { value: 0 },
        uLight: { value: 0 },
        uPoint: { value: 0 },
        uPointSigma: { value: 1 },
        uPointT: { value: 3 },
        uPpr: { value: 1 },
        ...relativityUniforms,
      },
      vertexShader,
      fragmentShader,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -30;
    this.mesh.visible = false;
    const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => toGalactic(sceneToIcrf(v as Vec3)));
    this.sceneToGal.set(cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]);
  }

  /**
   * @param cameraMpc barycentric ICRS camera position, Mpc.
   * @param opacity of the false-colour map; 0 hides it.
   * @param light display value of the Sun's surface brightness in V: the background's
   *   own light, which only shows from a ship fast enough to blueshift it into view.
   * @param point the same light squeezed into a point ahead, once its patch is smaller
   *   than a pixel: peak value, blur and pixels per radian (device pixels).
   */
  update(camera: THREE.PerspectiveCamera, cameraMpc: Vec3, opacity: number, light = 0, point?: { peak: number; sigma: number; ppr: number }): void {
    const gamma = relativityUniforms.uGamma.value;
    const shifted = gamma > 50;
    this.mesh.visible = opacity > 0.002 || (shifted && light > 0);
    if (!this.mesh.visible) return;
    const u = this.material.uniforms;
    u.uLight.value = shifted ? light : 0;
    u.uPoint.value = shifted && point ? point.peak : 0;
    u.uPointSigma.value = point?.sigma ?? 1;
    u.uPointT.value = 2 * gamma * T_CMB;
    u.uPpr.value = point?.ppr ?? 1;
    const g = toGalactic(cameraMpc);
    u.uCam.value.set(g[0], g[1], g[2]);
    u.uOpacity.value = opacity;
    const tanY = Math.tan((camera.fov * Math.PI) / 360);
    u.uTan.value.set(tanY * camera.aspect, tanY);
    this.rot.setFromMatrix4(camera.matrixWorld);
    (u.uRay.value as THREE.Matrix3).multiplyMatrices(this.sceneToGal, this.rot);
  }
}

function toGalactic(v: Vec3): Vec3 {
  const g = ICRS_TO_GAL;
  return [0, 1, 2].map((r) => g[r * 3] * v[0] + g[r * 3 + 1] * v[1] + g[r * 3 + 2] * v[2]) as Vec3;
}
