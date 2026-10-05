import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import type { Mat3 } from '../core/orientation';
import { MAP_GLSL } from './planets';
import { latLonSphere } from './sky';

/**
 * The Sun: the photosphere from an SDO/HMI image (sunspots and faculae, see
 * pipeline/build_sun.py) rotating with the IAU model, with limb darkening put back
 * (Neckel and Labs 1994 fit at 550 nm); the white-light corona, which only shows once
 * the photosphere is covered; and a glow standing in for glare in the eye, which fades
 * with the fraction of the disc in view.
 *
 * Brightness is in the same units as the planets: a white Lambertian surface 1 AU from
 * the Sun, lit face on, has radiance `intensity`; the Sun's disc is pi / (solid angle
 * of the Sun at 1 AU) = 46,200 times brighter.
 */
export const SUN_SURFACE_BRIGHTNESS = 1 / (695700 / 149597870.7) ** 2;

const vertexShader = /* glsl */ `
uniform float uRadius;
varying vec3 vBody;
varying vec3 vRel;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vBody = position * uRadius;
  vRel = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uMap;
uniform float uMapScale;
uniform mat3 uSceneToBody;
uniform float uBrightness;
varying vec3 vBody;
varying vec3 vRel;
#include <common>
#include <logdepthbuf_pars_fragment>
${MAP_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vBody);
  float mu = clamp(dot(n, -normalize(uSceneToBody * vRel)), 0.0, 1.0);
  // Limb darkening, I(mu)/I(1) = 0.30 + 0.93 mu - 0.23 mu^2 (green light).
  float limb = 0.30 + 0.93 * mu - 0.23 * mu * mu;
  float relative = sampleMap(uMap, vBody).r * uMapScale;
  // Photosphere colour (5772 K blackbody, linear sRGB, brightest channel 1).
  vec3 color = vec3(1.0, 0.89, 0.79) * limb * relative * uBrightness;
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const coronaVertex = /* glsl */ `
varying vec2 vXY;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vXY = position.xy;
  // A billboard: offsets in view space, so it always faces the camera.
  vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
  gl_Position = projectionMatrix * (centre + vec4(position.xy * scale, 0.0, 0.0));
  #include <logdepthbuf_vertex>
}
`;

const coronaFragment = /* glsl */ `
uniform float uBrightness;
varying vec2 vXY;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float rho = length(vXY); // in solar radii
  if (rho < 1.0 || rho > 8.0) discard;
  // Baumbach (1937) K + F corona, in units of the disc-centre brightness.
  float k = 1e-6 * (0.0532 * pow(rho, -2.5) + 1.425 * pow(rho, -7.0) + 2.565 * pow(rho, -17.0));
  vec3 color = vec3(1.0, 0.95, 0.9) * k * uBrightness * smoothstep(8.0, 5.0, rho);
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class SunView {
  readonly group = new THREE.Group();
  private readonly sphere: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly corona: THREE.Mesh;
  private readonly coronaMaterial: THREE.ShaderMaterial;
  private readonly glow: THREE.Sprite;
  private readonly m4 = new THREE.Matrix4();

  constructor(readonly radius: number, map: THREE.Texture | undefined, mapScale: number) {
    const blank = new THREE.DataTexture(new Uint8Array([204, 204, 204, 255]), 1, 1);
    blank.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uMap: { value: map ?? blank },
        uMapScale: { value: map ? mapScale : 1 / 0.8 },
        uRadius: { value: radius },
        uSceneToBody: { value: new THREE.Matrix3() },
        uBrightness: { value: 1 },
      },
    });
    this.sphere = new THREE.Mesh(latLonSphere(128, 64), this.material);
    this.sphere.scale.setScalar(radius);
    this.group.add(this.sphere);

    this.coronaMaterial = new THREE.ShaderMaterial({
      vertexShader: coronaVertex,
      fragmentShader: coronaFragment,
      uniforms: { uBrightness: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.corona = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), this.coronaMaterial);
    this.corona.scale.setScalar(radius);
    this.corona.frustumCulled = false;
    this.corona.renderOrder = 1;
    this.group.add(this.corona);

    this.glow = makeGlow();
    this.group.add(this.glow);
    this.group.name = 'Sun';
  }

  /**
   * @param rel Sun centre minus camera, scene axes, km.
   * @param visible Fraction of the photosphere the camera sees (0 in totality).
   * @param exposure Scale applied to every brightness this frame.
   * @param sky How much the daytime sky drowns the corona out (0 in space).
   */
  update(rel: Vec3, bodyToScene: Mat3, visible: number, exposure: number, sky: number): void {
    const b = bodyToScene;
    this.group.position.set(rel[0], rel[1], rel[2]);
    this.m4.set(b[0], b[1], b[2], 0, b[3], b[4], b[5], 0, b[6], b[7], b[8], 0, 0, 0, 0, 1);
    this.sphere.quaternion.setFromRotationMatrix(this.m4);
    this.material.uniforms.uSceneToBody.value.set(b[0], b[3], b[6], b[1], b[4], b[7], b[2], b[5], b[8]);
    const disc = 7 * SUN_SURFACE_BRIGHTNESS * exposure;
    this.material.uniforms.uBrightness.value = disc;
    // The corona is a millionth of the disc: lost in glare and sky light until the disc is covered.
    const glare = Math.min(1, visible * 300) + sky;
    this.coronaMaterial.uniforms.uBrightness.value = disc * Math.max(0, 1 - glare);
    this.corona.visible = glare < 1;
    // Glare: at least a few percent of the view wide, so the Sun stays findable from the
    // outer planets, where its true disc is under a pixel.
    // It fades once the disc is large enough to look at (close to the Sun).
    const d = Math.hypot(rel[0], rel[1], rel[2]);
    this.glow.scale.setScalar(Math.max(this.radius * 12, d * 0.06));
    const resolved = THREE.MathUtils.smoothstep(this.radius / d, 0.01, 0.05);
    (this.glow.material as THREE.SpriteMaterial).opacity = Math.min(1, visible) * (1 - resolved);
    this.glow.visible = visible * (1 - resolved) > 1e-4;
  }
}

function makeGlow(): THREE.Sprite {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,248,230,1)');
  g.addColorStop(0.12, 'rgba(255,236,200,0.55)');
  g.addColorStop(0.35, 'rgba(255,210,150,0.12)');
  g.addColorStop(1, 'rgba(255,200,140,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  sprite.renderOrder = 1;
  return sprite;
}
