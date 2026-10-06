import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { icrfToScene } from '../core/frames';
import type { GalaxyModelSpec, ModelAxes } from '../core/galaxymodel';

/** Where a model is and how bright, worked out by the caller (DeepSky). */
export interface ModelPlacement {
  /** Barycentric ICRS centre, Mpc. */
  centre: Vec3;
  axes: ModelAxes;
  /** Apparent magnitude of the whole galaxy seen from the Sun (its catalogue light). */
  magnitudeFromSun: () => number;
  /** Scale radius (Mpc) where the catalogue's own point hands over to the model. */
  handover: number;
}

const vertexShader = /* glsl */ `
uniform vec3 uRel;
uniform vec3 uX;
uniform vec3 uY;
uniform vec3 uZ;
uniform vec3 uHalf;
uniform float uShrink;
uniform mat3 uIcrfToScene;
varying vec3 vLocal;
void main() {
  vLocal = position * uHalf;
  // Model frame (kpc) to camera-relative ICRS (Mpc), shrunk toward the camera (the
  // picture is unchanged) to stay inside the projection's range.
  vec3 rel = uRel + (uX * vLocal.x + uY * vLocal.y + uZ * vLocal.z) * 1e-3;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(uIcrfToScene * (rel * uShrink), 1.0);
  gl_Position.z = gl_Position.w * 0.999999;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uFace;
uniform sampler2D uDust;
uniform vec3 uCam;
uniform vec3 uHalf;
uniform float uLight;
uniform float uTauMax;
uniform float uDisc;
uniform float uZ0;
uniform float uZd;
uniform float uTau0;
uniform float uHd;
uniform float uZy;
uniform float uDh;
uniform vec2 uTexels;
uniform vec4 uBulge;      // rho0, re, n, q0
uniform vec2 uBulgePB;    // p, b
uniform vec3 uBulgeColour;
uniform float uScale;
uniform float uGain;
uniform float uPixelAngle;
uniform int uSteps;
varying vec3 vLocal;

float sech2(float x) {
  float e = exp(-2.0 * min(abs(x), 30.0));
  return 4.0 * e / ((1.0 + e) * (1.0 + e));
}

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

void main() {
  vec3 o = uCam;
  vec3 d = normalize(vLocal - uCam);
  // Where the ray is inside the box.
  vec3 inv = 1.0 / sign(d) / max(abs(d), vec3(1e-9));
  vec3 ta = (-uHalf - o) * inv, tb = (uHalf - o) * inv;
  vec3 tmin = min(ta, tb), tmax = max(ta, tb);
  float t0 = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
  float t1 = min(min(tmax.x, tmax.y), tmax.z);
  if (t1 <= t0) discard;
  float rho0 = uBulge.x, re = uBulge.y, sn = uBulge.z, q0 = uBulge.w;
  vec3 light = vec3(0.0);
  float trans = 1.0;
  float t = t0;
  float jitter = hash(gl_FragCoord.xy);
  float dz = max(abs(d.z), 0.02);
  float texel = 2.0 * uHalf.x / uTexels.x;
  float span = t1 - t0;
  float dxy = max(length(d.xy), 1e-3);
  float minStep = span / float(uSteps - 12);
  for (int k = 0; k < 256; k++) {
    if (k >= uSteps || t >= t1 || trans < 0.004) break;
    // Steps short enough to resolve the disc's thickness, the bulge's core and, across
    // the disc, the detail one pixel shows.
    vec3 p = o + d * t;
    float pix = max(t, 1e-6) * uPixelAngle;
    float zs = uDisc > 0.5 ? 0.3 * max(abs(p.z), min(uZd, uZy)) / dz : 1e9;
    float xs = uDisc > 0.5 && abs(p.z) < 3.0 * uZ0 ? 1.5 * max(pix, texel) / dxy : 1e9;
    float m = length(vec3(p.xy, p.z / q0));
    float bs = 0.3 * max(m, 0.03 * re);
    float ds = clamp(min(min(zs, xs), bs), minStep, span / 8.0);
    ds = min(ds, t1 - t);
    vec3 q = o + d * (t + ds * jitter);
    float s = max(length(vec3(q.xy, q.z / q0)) / re, 1e-3);
    vec3 j = uBulgeColour * rho0 * pow(s, -uBulgePB.x) * exp(-uBulgePB.y * pow(s, 1.0 / sn));
    float kappa = 0.0;
    if (uDisc > 0.5) {
      vec2 uv = q.xy / uHalf.xy * 0.5 + 0.5;
      // Blur the maps to what this step and this pixel cover.
      float footprint = max(0.5 * ds * dxy, pix);
      float lod = log2(max(footprint / texel, 1.0));
      vec3 face = textureLod(uFace, uv, lod).rgb;
      // Knots and fine structure in the thin layer, the smooth light in the thick one.
      float young = textureLod(uDust, uv, lod).g;
      j += face * face * uLight * ((1.0 - young) * sech2(q.z / uZ0) / (2.0 * uZ0) + young * sech2(q.z / uZy) / (2.0 * uZy));
      float lane = textureLod(uDust, uv, max(lod - 1.0, 0.0)).r;
      float rr = length(q.xy);
      float tau = lane * lane * uTauMax + uTau0 * exp(-rr / uHd) * (uDh > 0.0 ? 1.0 - exp(-rr * rr / (uDh * uDh)) : 1.0);
      kappa = tau * sech2(q.z / uZd) / (2.0 * uZd);
    }
    float a = kappa * ds;
    light += trans * j * ds * (a > 1e-4 ? (1.0 - exp(-a)) / a : 1.0);
    trans *= exp(-a);
    t += ds;
  }
  // A photograph's response: linear when faint, rolling off instead of clipping, with a
  // longer exposure once the galaxy fills the view (as its pictures are taken).
  vec3 c = 1.0 - exp(-light * uScale * uGain);
  if (max(c.r, max(c.g, c.b)) < 1.0 / 2048.0) discard;
  gl_FragColor = vec4(mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)), 1.0);
}
`;

interface Item {
  spec: GalaxyModelSpec;
  place: ModelPlacement;
  mesh: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  onReady?: () => void;
}

/**
 * The nearest galaxies as volumes: bulge, disc and dust ray-marched through a box in the
 * galaxy's own frame, so they keep their shape from every side and can be flown through.
 * Light is scaled so that, seen from Earth, the whole galaxy has its catalogue magnitude.
 */
export class GalaxyModelLayer {
  readonly group = new THREE.Group();
  private readonly items: Item[] = [];
  private readonly geometry = new THREE.BoxGeometry(2, 2, 2);
  private readonly icrfToScene = new THREE.Matrix3();
  private readonly loader = new THREE.TextureLoader();
  private readonly blank: THREE.DataTexture;

  /** @param steps most samples along a ray (fewer on phones). */
  constructor(private readonly baseUrl: string, private readonly anisotropy: number, private readonly pixelRatio: number,
    private readonly steps = 160) {
    const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => icrfToScene(v as Vec3, [0, 0, 0]));
    this.icrfToScene.set(cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]);
    this.blank = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    this.blank.needsUpdate = true;
    this.group.renderOrder = -11;
  }

  add(spec: GalaxyModelSpec, place: ModelPlacement, onReady?: () => void): void {
    const b = spec.bulge;
    const uniforms: Record<string, THREE.IUniform> = {
      uRel: { value: new THREE.Vector3() },
      uX: { value: new THREE.Vector3(...place.axes.x) },
      uY: { value: new THREE.Vector3(...place.axes.y) },
      uZ: { value: new THREE.Vector3(...place.axes.z) },
      uHalf: { value: new THREE.Vector3(spec.R, spec.R, spec.H) },
      uShrink: { value: 1 },
      uIcrfToScene: { value: this.icrfToScene },
      uCam: { value: new THREE.Vector3() },
      uFace: { value: this.blank },
      uDust: { value: this.blank },
      uLight: { value: spec.light ?? 0 },
      uTauMax: { value: spec.tauMax ?? 0 },
      uDisc: { value: spec.kind === 'disc' && spec.file ? 1 : 0 },
      uZ0: { value: spec.z0 ?? 1 },
      uZd: { value: spec.zd ?? 1 },
      uTau0: { value: spec.tau0 ?? 0 },
      uHd: { value: spec.hd ?? 1 },
      uZy: { value: spec.zy ?? spec.zd ?? 1 },
      uDh: { value: spec.dh ?? 0 },
      uTexels: { value: new THREE.Vector2(...(spec.size ?? [1, 1])) },
      uBulge: { value: new THREE.Vector4(b.rho0, b.re, b.n, b.q0) },
      uBulgePB: { value: new THREE.Vector2(b.p, b.b) },
      uBulgeColour: { value: new THREE.Vector3(...b.colour) },
      uScale: { value: 0 },
      uGain: { value: 1 },
      uPixelAngle: { value: 1e-3 },
      uSteps: { value: this.steps },
    };
    const material = new THREE.ShaderMaterial({
      uniforms, vertexShader, fragmentShader,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: false,
      // Back faces: from outside they cover the box once, and from inside too.
      side: THREE.BackSide,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -11;
    mesh.visible = false;
    this.group.add(mesh);
    this.items.push({ spec, place, mesh, uniforms, state: 'idle', onReady });
  }

  /**
   * @param camera barycentric ICRS camera position, Mpc.
   * @param msat magnitude of a point that just saturates (the galaxy layer's).
   * @param pointLight a saturating point's total light in device-pixel values (2 pi sigma^2).
   */
  update(camera: Vec3, msat: number, pixelsPerRadian: number, brightness: number, pointLight: number): void {
    const ppr = pixelsPerRadian * this.pixelRatio;
    for (const item of this.items) {
      const { place, uniforms: u, spec } = item;
      const rel: Vec3 = [place.centre[0] - camera[0], place.centre[1] - camera[1], place.centre[2] - camera[2]];
      const d = Math.hypot(rel[0], rel[1], rel[2]);
      const handover = smoothstep(0.6, 1.6, (place.handover / d) * ppr);
      const fromSun = Math.hypot(place.centre[0], place.centre[1], place.centre[2]);
      const flux = 10 ** (-0.4 * (place.magnitudeFromSun() - msat)) * brightness;
      // Surface brightness is the same from any distance: light per pixel is the model's
      // light per kpc^2 times the pixel's solid angle times the Sun's distance squared.
      const scale = (flux * pointLight * (fromSun * 1e3) ** 2 * handover) / (ppr * ppr);
      const wanted = handover > 0 && scale > 1e-9;
      if (wanted && item.state === 'idle') this.load(item);
      item.mesh.visible = wanted && item.state === 'ready';
      if (!item.mesh.visible) continue;
      u.uRel.value.set(rel[0], rel[1], rel[2]);
      // The camera in the model's frame (kpc).
      const { x, y, z } = place.axes;
      const c: Vec3 = [-rel[0] * 1e3, -rel[1] * 1e3, -rel[2] * 1e3];
      u.uCam.value.set(dot(c, x), dot(c, y), dot(c, z));
      u.uShrink.value = 1e6 / Math.max(d, spec.R * 2e-3);
      u.uScale.value = scale;
      // Exposure: the galaxy's own light, once it spans more than a few dozen pixels.
      const sizePx = ((spec.R * 2e-3) / d) * ppr;
      u.uGain.value = 1 + (PHOTO_GAIN - 1) * smoothstep(30, 300, sizePx);
      u.uPixelAngle.value = 1 / ppr;
    }
  }

  private load(item: Item): void {
    item.state = 'loading';
    const { spec } = item;
    const files = [spec.file, spec.dust].map((f) => (f ? this.texture(f) : Promise.resolve(this.blank)));
    Promise.all(files).then(([face, dust]) => {
      item.uniforms.uFace.value = face;
      item.uniforms.uDust.value = dust;
      item.state = 'ready';
      item.onReady?.();
    }).catch((err) => {
      item.state = 'failed';
      console.warn(`galaxy model ${spec.name}:`, err);
    });
  }

  private texture(file: string): Promise<THREE.Texture> {
    return this.loader.loadAsync(`${this.baseUrl}${file}`).then((tex) => {
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = this.anisotropy;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      return tex;
    });
  }
}

/**
 * How much longer than the eye's the exposure is on a galaxy that fills the view. Its
 * pictures are long exposures: the eye at the telescope sees little more than the core.
 */
const PHOTO_GAIN = 4;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
