import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { kelvinToRgb } from '../core/stars';
import { SUN_SURFACE_BRIGHTNESS } from './sun';
import { latLonSphere } from './sky';

const vertexShader = /* glsl */ `
uniform mat3 uSceneToBody;
varying vec3 vBody;
varying vec3 vView;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vBody = uSceneToBody * normalize(mat3(modelMatrix) * position);
  vView = uSceneToBody * world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
  #include <logdepthbuf_vertex>
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uColor;
uniform float uBrightness;
uniform float uLimb;
uniform float uFreq;
uniform float uContrast;
uniform float uSpots;
uniform float uTime;
uniform float uSeed;
varying vec3 vBody;
varying vec3 vView;
#include <common>
#include <logdepthbuf_pars_fragment>

vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash3(i).x, n100 = hash3(i + vec3(1, 0, 0)).x, n010 = hash3(i + vec3(0, 1, 0)).x, n110 = hash3(i + vec3(1, 1, 0)).x;
  float n001 = hash3(i + vec3(0, 0, 1)).x, n101 = hash3(i + vec3(1, 0, 1)).x, n011 = hash3(i + vec3(0, 1, 1)).x, n111 = hash3(i + vec3(1, 1, 1)).x;
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float fbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; }
  return s;
}
// Cellular pattern: the convection cells (granules) are bright, the lanes between dark.
// Feature points drift with time, so cells grow, split and fade.
vec2 worley(vec3 p, float t) {
  vec3 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 h = hash3(i + g);
    vec3 o = 0.5 + 0.4 * sin(t * (0.6 + h.yzx) + 6.2831 * h);
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return vec2(d1, d2);
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vBody);
  float mu = clamp(dot(n, -normalize(vView)), 0.0, 1.0);
  // Limb darkening: the Sun's (Neckel and Labs, 550 nm) scaled by uLimb for the star's
  // temperature.
  float x = 1.0 - mu;
  float limb = 1.0 - uLimb * (0.47 * x + 0.23 * x * x);

  float bright = 1.0;
  vec3 p = n * uFreq;
  // Cells smaller than a pixel average out: fade the pattern as they shrink.
  float px = length(fwidth(p));
  float resolved = 1.0 - smoothstep(0.25, 0.9, px);
  if (uContrast > 0.0 && resolved > 0.0) {
    vec2 w = worley(p + uSeed, uTime);
    float cell = smoothstep(0.0, 0.45, w.y - w.x);
    float g = (cell - 0.55) * 2.0 + 0.25 * (fbm(p * 2.0) - 0.5);
    // Seen at a slant near the limb the pattern loses contrast.
    bright *= 1.0 + uContrast * g * resolved * (0.35 + 0.65 * mu);
  }
  if (uContrast > 0.0) {
    // The supergranulation network, faintly, at 30 cells' scale.
    float sg = fbm(n * max(uFreq / 30.0, 2.0) + uSeed * 0.37);
    bright *= 1.0 + 0.04 * uContrast * (sg - 0.5);
  }
  if (uSpots > 0.0) {
    // Starspots in bands either side of the equator, umbra and penumbra; bright
    // faculae around them show near the limb.
    float band = smoothstep(0.75, 0.1, abs(n.z));
    float s = fbm(n * 5.0 + uSeed * 1.7 + vec3(0.0, 0.0, uTime * 0.0003)) * band;
    float threshold = 0.66 - uSpots;
    float umbra = smoothstep(threshold + 0.035, threshold + 0.06, s);
    float penumbra = smoothstep(threshold, threshold + 0.03, s);
    float faculae = smoothstep(threshold - 0.06, threshold, s) * (1.0 - penumbra) * pow(1.0 - mu, 2.0);
    bright *= (1.0 - 0.35 * penumbra) * (1.0 - 0.45 * umbra) * (1.0 + 0.6 * faculae);
  }
  gl_FragColor = vec4(uColor * limb * bright * uBrightness, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** What a star's surface looks like up close. */
export interface StarLook {
  /** Effective temperature, K. */
  teff: number;
  /** Radius, km. */
  radius: number;
  /** Surface brightness in V relative to the Sun's. */
  surface: number;
  /** Surface gravity relative to the Sun's. */
  gravity: number;
  /** For per-star patterns. */
  seed: number;
  /** A white dwarf: no visible convection, no spots. */
  degenerate?: boolean;
}

/** Linear-sRGB colour of a blackbody with the Sun's luminance for 5,772 K (see sun.ts). */
export function starColor(teff: number): THREE.Color {
  const rgb = kelvinToRgb(teff);
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return new THREE.Color(rgb[0], rgb[1], rgb[2]).multiplyScalar(0.906 / lum);
}

/**
 * Granulation of a star like this one: cells per stellar radius, and their contrast.
 * Granules are about ten pressure scale heights across, and the scale height goes as
 * T / g: the Sun's are 1,300 km wide, a red dwarf's a few hundred km, a red giant's a
 * sizeable part of the star. Above about 7,000 K the convection zone thins to nothing
 * and the pattern fades out.
 */
export function granulation(look: StarLook): { freq: number; contrast: number; spots: number } {
  if (look.degenerate) return { freq: 1, contrast: 0, spots: 0 };
  const size = 1300 * (look.teff / 5772) / look.gravity;
  const freq = Math.min(4000, Math.max(3, look.radius / size));
  const contrast = 0.16 * THREE.MathUtils.smoothstep(7400, 6200, look.teff) * Math.min(1.3, (look.teff / 5772) ** 1.5);
  // Spots: cool stars with deep convection zones are spottier than the Sun.
  const spots = look.teff > 6500 ? 0 : look.teff > 5300 ? 0.03 : look.teff > 4000 ? 0.06 : 0.09;
  return { freq, contrast, spots };
}

/** Limb darkening relative to the Sun's: stronger in cooler stars, weaker in hot ones. */
function limbScale(teff: number): number {
  return Math.min(1.25, Math.max(0.5, 1 - 0.55 * Math.log(teff / 5772)));
}

/**
 * A star seen up close: a limb-darkened sphere of the star's radius and colour, with
 * convection cells (granulation) and spots sized from its temperature and gravity, and
 * glare while its disc is small. The pattern is typical of such a star, not a map of it.
 * Brightness is in the units sun.ts uses, so the exposure that shows the Sun's surface
 * shows any star's.
 */
export class StarGlobe {
  readonly group = new THREE.Group();
  private readonly sphere: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly glow: THREE.Sprite;
  private readonly glowMaterial: THREE.SpriteMaterial;
  private readonly halo: THREE.Sprite;
  private readonly haloMaterial: THREE.SpriteMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uColor: { value: new THREE.Color() },
        uBrightness: { value: 1 },
        uLimb: { value: 1 },
        uFreq: { value: 500 },
        uContrast: { value: 0 },
        uSpots: { value: 0 },
        uTime: { value: 0 },
        uSeed: { value: 0 },
        uSceneToBody: { value: new THREE.Matrix3() },
      },
      extensions: { derivatives: true } as never,
    });
    this.sphere = new THREE.Mesh(latLonSphere(128, 64), this.material);
    this.glowMaterial = new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    this.glow = new THREE.Sprite(this.glowMaterial);
    this.glow.renderOrder = 1;
    // Bloom around a disc too bright to look at, as in the eye or a camera lens.
    this.haloMaterial = new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    this.halo = new THREE.Sprite(this.haloMaterial);
    this.halo.renderOrder = 1;
    this.group.add(this.sphere, this.glow, this.halo);
    this.group.visible = false;
  }

  /**
   * @param rel star centre minus camera, scene axes, km.
   * @param exposure the scene's exposure this frame.
   * @param tdb for the turning and evolving surface.
   * @param spin body-to-scene rotation (row-major); the star's pole is body z.
   */
  update(rel: Vec3, look: StarLook, exposure: number, tdb: number, spin: Float64Array): void {
    this.group.visible = true;
    this.group.position.set(rel[0], rel[1], rel[2]);
    this.sphere.scale.setScalar(look.radius);
    const u = this.material.uniforms;
    u.uColor.value.copy(starColor(look.teff));
    // Capped: a disc far brighter than the exposure would tone-map to plain white and
    // lose its colour; the glare around it says how bright it is.
    u.uBrightness.value = Math.min(4, 7 * SUN_SURFACE_BRIGHTNESS * look.surface * exposure);
    u.uLimb.value = look.degenerate ? 0.6 : limbScale(look.teff);
    const g = granulation(look);
    u.uFreq.value = g.freq;
    u.uContrast.value = g.contrast;
    u.uSpots.value = g.spots;
    // Granules live about ten minutes on the Sun; the pattern's clock runs with the
    // scale height over the sound speed, roughly T^0.5 / g.
    const life = 600 * Math.sqrt(look.teff / 5772) / look.gravity;
    u.uTime.value = ((tdb / life) % 1e4);
    u.uSeed.value = (look.seed % 1000) * 0.731;
    const b = spin;
    u.uSceneToBody.value.set(b[0], b[3], b[6], b[1], b[4], b[7], b[2], b[5], b[8]);
    // Glare: the star stays findable while its disc is small, and fades once it is large.
    const d = Math.hypot(rel[0], rel[1], rel[2]);
    this.glowMaterial.color.copy(starColor(look.teff)).multiplyScalar(0.8);
    this.glow.scale.setScalar(Math.max(look.radius * 12, d * 0.05));
    const resolved = THREE.MathUtils.smoothstep(look.radius / d, 0.01, 0.06);
    this.glowMaterial.opacity = Math.min(1, u.uBrightness.value) * (1 - resolved);
    this.glow.visible = this.glowMaterial.opacity > 1e-3;
    this.haloMaterial.color.copy(this.glowMaterial.color);
    this.halo.scale.setScalar(look.radius * 3.2);
    this.haloMaterial.opacity = 0.35 * Math.min(1, u.uBrightness.value) * resolved;
    this.halo.visible = this.haloMaterial.opacity > 1e-3;
  }

  hide(): void {
    this.group.visible = false;
  }
}

let sharedGlow: THREE.Texture | undefined;
function glowTexture(): THREE.Texture {
  if (sharedGlow) return sharedGlow;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.1, 'rgba(255,255,255,0.5)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  sharedGlow = new THREE.CanvasTexture(canvas);
  sharedGlow.colorSpace = THREE.SRGBColorSpace;
  return sharedGlow;
}
