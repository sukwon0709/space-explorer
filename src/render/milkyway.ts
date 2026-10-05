import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { REDDENING, kelvinToRgb } from '../core/stars';
import { ICRS_TO_GAL, LIGHT_FUNCTION, MODEL, NORM, R0, Z_SUN, armField, discHole } from '../core/milkyway';
import { sceneToIcrf } from '../core/frames';
import type { DustGrid } from './stars';

/** Width of the face-on arm map, kpc (centred on the Galactic Centre). */
const ARM_MAP_KPC = 40;
const ARM_MAP_SIZE = 512;
const STEPS = 96;

/** Colour of a component's light, linear RGB normalised to unit luminance. */
function tint(kelvin: number): THREE.Vector3 {
  const c = kelvinToRgb(kelvin);
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return new THREE.Vector3(c[0] / y, c[1] / y, c[2] / y);
}

const vertexShader = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp sampler3D;
varying vec2 vNdc;
uniform vec3 uCam;
uniform mat3 uRay;
uniform vec2 uTan;
uniform sampler2D uArms;
uniform sampler3D uDust;
uniform vec3 uDustLo;
uniform vec3 uDustSize;
uniform float uDustScale;
uniform vec3 uNorm;
uniform float uLimit;
uniform float uLf[${LIGHT_FUNCTION.cum.length}];
uniform float uScale;
uniform vec3 uThin;
uniform vec3 uYoung;
uniform vec3 uBulge;

const float R0 = ${R0.toFixed(4)};
const float ZSUN = ${Z_SUN.toFixed(4)};
const vec3 RED = vec3(${REDDENING.join(', ')});

float hole(float r) { return 1.0 - exp(-pow(r / 3.2, 3.0)); }

// Fraction of the light of stars at distance d (pc) behind A_V = a that is too faint
// to be drawn as points: those stars' light belongs to the glow.
float unresolved(float d, float a) {
  float m = uLimit - 5.0 * log2(max(d, 1.0) * 0.1) * 0.30102999566 - a;
  float f = (m - ${LIGHT_FUNCTION.m0.toFixed(1)}) / ${LIGHT_FUNCTION.step.toFixed(2)};
  if (f <= 0.0) return 1.0;
  if (f >= ${(LIGHT_FUNCTION.cum.length - 1).toFixed(1)}) return 0.0;
  int i = int(f);
  return 1.0 - mix(uLf[i], uLf[i + 1], fract(f));
}

vec2 barFrame(vec2 p) {
  const vec2 ax = vec2(${(-Math.cos((28 * Math.PI) / 180)).toFixed(6)}, ${Math.sin((28 * Math.PI) / 180).toFixed(6)});
  return vec2(dot(p, ax), -p.x * ax.y + p.y * ax.x);
}

// Hash for a per-pixel offset of the samples (turns banding into fine noise).
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

bool slab(vec3 o, vec3 d, out float t0, out float t1) {
  // Cylinder of radius 24 kpc and half-height 4 kpc.
  const float RC = 24.0, HZ = 4.0;
  float a = dot(d.xy, d.xy), b = dot(o.xy, d.xy), c = dot(o.xy, o.xy) - RC * RC;
  float disc = b * b - a * c;
  if (disc <= 0.0 || a < 1e-12) { if (c > 0.0) return false; t0 = 0.0; t1 = 1e9; }
  else { float s = sqrt(disc); t0 = (-b - s) / a; t1 = (-b + s) / a; }
  if (abs(d.z) > 1e-9) {
    float za = (-HZ - o.z) / d.z, zb = (HZ - o.z) / d.z;
    t0 = max(t0, min(za, zb)); t1 = min(t1, max(za, zb));
  } else if (abs(o.z) > HZ) return false;
  t0 = max(t0, 0.0);
  return t1 > t0;
}

void main() {
  vec3 dir = normalize(uRay * vec3(vNdc * uTan, -1.0));
  float t0, t1;
  if (!slab(uCam, dir, t0, t1)) { gl_FragColor = vec4(0.0); return; }
  float a = max(t0, 0.002);
  float ratio = t1 / a;
  float jitter = hash(gl_FragCoord.xy);
  vec3 light = vec3(0.0);
  float tau = 0.0;
  float prev = a;
  for (int i = 0; i < ${STEPS}; i++) {
    float t = a * pow(ratio, (float(i) + jitter) / ${STEPS}.0);
    float ds = t - prev;
    prev = t;
    vec3 p = uCam + dir * t;
    float r = length(p.xy);
    float az = abs(p.z);
    vec2 uv = p.xy / ${ARM_MAP_KPC.toFixed(1)} + 0.5;
    vec3 arms = texture2D(uArms, uv).rgb;
    float h = hole(r);
    // Stars (solar V luminosities per pc^3).
    float thin = exp(-(r - R0) / ${MODEL.thin.hR.toFixed(2)} - az / ${MODEL.thin.hz.toFixed(3)}) * (${(1 - MODEL.arms.old / 2).toFixed(3)} + ${MODEL.arms.old.toFixed(3)} * arms.r);
    float thick = ${MODEL.thick.ratio.toFixed(3)} * exp(-(r - R0) / ${MODEL.thick.hR.toFixed(2)} - az / ${MODEL.thick.hz.toFixed(3)});
    float young = ${MODEL.arms.amplitude.toFixed(3)} * arms.r * exp(-(r - R0) / ${MODEL.arms.hR.toFixed(2)} - az / ${MODEL.arms.hz.toFixed(3)});
    vec2 q = barFrame(p.xy);
    float bulge = uNorm.y * exp(-0.5 * sqrt(pow(pow(q.x / ${MODEL.bulge.x0.toFixed(2)}, 2.0) + pow(q.y / ${MODEL.bulge.y0.toFixed(2)}, 2.0), 2.0) + pow(p.z / ${MODEL.bulge.z0.toFixed(2)}, 4.0)))
      + uNorm.z * exp(-pow(q.x / ${MODEL.bar.x0.toFixed(2)}, 4.0) - 0.5 * pow(q.y / ${MODEL.bar.y0.toFixed(2)}, 2.0) - az / ${MODEL.bar.z0.toFixed(2)});
    // Dust (A_V per kpc): the model disc, or the Edenhofer map near the Sun.
    float dust = ${MODEL.dust.local.toFixed(2)} * exp(-(r - R0) / ${MODEL.dust.hR.toFixed(2)} - az / ${MODEL.dust.hz.toFixed(3)}) * h * (0.4 + ${MODEL.dust.arms.toFixed(2)} * arms.g);
    if (uDustScale > 0.0) {
      vec3 g = vec3(p.x + R0, p.y, p.z - ZSUN) * 1000.0;
      vec3 c = (g - uDustLo) / uDustSize;
      vec3 edge = min(c, 1.0 - c);
      float inside = smoothstep(0.0, 0.06, min(edge.x, min(edge.y, edge.z)));
      if (inside > 0.0) {
        float v = texture(uDust, c).r;
        dust = mix(dust, v * v * uDustScale * 1000.0, inside);
      }
    }
    float dt = dust * ds;
    // Light emitted in this step, dimmed by the dust in front (half the step's own).
    float seen = unresolved(t * 1000.0, tau);
    vec3 att = exp2(-1.3287712 * (tau + 0.5 * dt) * RED);
    light += (uNorm.x * h * (thin * uThin + thick * uBulge + young * uYoung) + bulge * uBulge) * att * (seen * ds * 1000.0);
    tau += dt;
    if (tau > 40.0) break;
  }
  gl_FragColor = vec4(light * uScale, 1.0);
}
`;

const compositeShader = /* glsl */ `
uniform sampler2D uGlow;
varying vec2 vNdc;
void main() {
  vec3 c = min(texture2D(uGlow, vNdc * 0.5 + 0.5).rgb, 1.0);
  gl_FragColor = vec4(mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)), 1.0);
}
`;

/** Face-on map of the spiral arms: red the young stars, green the dust lanes. */
function armMap(): THREE.DataTexture {
  const n = ARM_MAP_SIZE;
  const data = new Uint8Array(n * n * 4);
  // Arms are clumpy: star-forming complexes along them, from a fixed-seed value noise.
  const noise = valueNoise(7);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n - 0.5) * ARM_MAP_KPC;
      const y = ((j + 0.5) / n - 0.5) * ARM_MAP_KPC;
      const { arm } = armField(x, y);
      const clump = 0.35 + 0.65 * noise(x * 1.6, y * 1.6) ** 2;
      // Dust lanes sit on the arms' inner (concave) edges.
      const r = Math.hypot(x, y) || 1;
      const inner = armField(x * (1 + 0.25 / r), y * (1 + 0.25 / r)).arm;
      const k = (j * n + i) * 4;
      data[k] = Math.round(255 * Math.min(1, arm * clump));
      data[k + 1] = Math.round(255 * Math.min(1, inner * (0.5 + 0.5 * noise(x * 3 + 17, y * 3))));
      data[k + 2] = Math.round(255 * discHole(r));
      data[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

function valueNoise(seed: number): (x: number, y: number) => number {
  const hash = (i: number, j: number) => {
    let h = (i * 374761393 + j * 668265263 + seed * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const octave = (x: number, y: number) => {
    const i = Math.floor(x), j = Math.floor(y);
    const fx = smooth(x - i), fy = smooth(y - j);
    const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  return (x, y) => (octave(x, y) * 0.6 + octave(x * 2.3 + 5, y * 2.3) * 0.3 + octave(x * 5.1, y * 5.1 + 9) * 0.1);
}

/**
 * The Milky Way's diffuse light, ray-marched through the model of core/milkyway.ts from
 * wherever the camera is: from the Sun it is the band across the sky (with the real 3D
 * dust map's dark lanes); from outside, the whole barred spiral (modelled). Drawn at
 * half resolution and added behind the stars.
 */
export class MilkyWayGlow {
  readonly composite: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private target: THREE.WebGLRenderTarget;
  private readonly ray = new THREE.Matrix3();
  private readonly sceneToGal = new THREE.Matrix3();
  private readonly rot = new THREE.Matrix3();
  /** Scale of the drawing target relative to the canvas. */
  resolution = 0.5;

  constructor(dust?: DustGrid) {
    const empty = new THREE.Data3DTexture(new Uint8Array(1), 1, 1, 1);
    empty.format = THREE.RedFormat;
    empty.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCam: { value: new THREE.Vector3(-R0, 0, Z_SUN) },
        uRay: { value: this.ray },
        uTan: { value: new THREE.Vector2(1, 1) },
        uArms: { value: armMap() },
        uDust: { value: dust?.texture ?? empty },
        uDustLo: { value: new THREE.Vector3(...(dust?.lo ?? [0, 0, 0])) },
        uDustSize: { value: new THREE.Vector3(...(dust?.size ?? [1, 1, 1])) },
        uDustScale: { value: dust?.scale ?? 0 },
        uNorm: { value: new THREE.Vector3(NORM.disc, NORM.bulge, NORM.bar) },
        uLimit: { value: 7.5 },
        uLf: { value: LIGHT_FUNCTION.cum },
        uScale: { value: 0 },
        uThin: { value: tint(6000) },
        uYoung: { value: tint(11000) },
        uBulge: { value: tint(4700) },
      },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    const compositeMaterial = new THREE.ShaderMaterial({
      uniforms: { uGlow: { value: this.target.texture } },
      vertexShader,
      fragmentShader: compositeShader,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.composite = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compositeMaterial);
    this.composite.frustumCulled = false;
    this.composite.renderOrder = -20;
    // Scene axes to Galactic: ICRS_TO_GAL times sceneToIcrf.
    const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => {
      const icrs = sceneToIcrf(v as Vec3);
      const g = ICRS_TO_GAL;
      return [0, 1, 2].map((r) => g[r * 3] * icrs[0] + g[r * 3 + 1] * icrs[1] + g[r * 3 + 2] * icrs[2]);
    });
    this.sceneToGal.set(cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]);
  }

  get uniforms() {
    return this.material.uniforms;
  }

  /**
   * @param cameraKpc the camera in the galactocentric model frame (kpc).
   * @param limit faintest magnitude drawn as a star (their light is left out of the glow).
   * @param scale display value of a line-of-sight luminosity of 1 Lsun/pc^2.
   * @param square side of a square render target (a cube map face) instead of the canvas.
   */
  update(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, cameraKpc: Vec3, limit: number, scale: number, square?: number): void {
    const size = square ? new THREE.Vector2(square, square) : renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, Math.round(size.x * this.resolution)), h = Math.max(1, Math.round(size.y * this.resolution));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    const u = this.material.uniforms;
    u.uCam.value.set(cameraKpc[0], cameraKpc[1], cameraKpc[2]);
    u.uLimit.value = limit;
    u.uScale.value = scale;
    const tanY = Math.tan((camera.fov * Math.PI) / 360);
    u.uTan.value.set(tanY * camera.aspect, tanY);
    this.rot.setFromMatrix4(camera.matrixWorld);
    this.ray.multiplyMatrices(this.sceneToGal, this.rot);
    this.composite.visible = scale > 0;
    if (scale <= 0) return;
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previous);
  }
}
