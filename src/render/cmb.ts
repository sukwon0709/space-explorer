import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { sceneToIcrf } from '../core/frames';
import { ICRS_TO_GAL } from '../core/milkyway';

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
  vec3 dir = normalize(uRay * vec3(vNdc * uTan, -1.0));
  // The last-scattering surface as the sphere we see it on, centred on the Sun: from
  // elsewhere the ray meets that same shell (from outside, its near side, as a globe).
  float b = dot(uCam, dir);
  float c = dot(uCam, uCam) - uRadius * uRadius;
  float disc = b * b - c;
  if (disc < 0.0) discard;
  float t = c > 0.0 ? -b - sqrt(disc) : -b + sqrt(disc);
  if (t < 0.0) discard;
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
  gl_FragColor = vec4(palette(v) * uOpacity, 1.0);
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
   * @param opacity 0 hides the layer.
   */
  update(camera: THREE.PerspectiveCamera, cameraMpc: Vec3, opacity: number): void {
    this.mesh.visible = opacity > 0.002;
    if (!this.mesh.visible) return;
    const u = this.material.uniforms;
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
