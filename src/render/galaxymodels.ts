import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { icrfToScene } from '../core/frames';
import { integrateRay, type GalaxyModelSpec, type ModelAxes } from '../core/galaxymodel';
import { sampleGalaxyStars, type DiscMaps } from '../core/galaxystars';
import { RELATIVITY_GLSL, relativityUniforms } from './relativity';

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

// Brightness raised to a power (by its luminance, keeping the colour), before the roll-off.
const STRETCH = /* glsl */ `
vec3 stretch(vec3 x, float p) {
  float y = dot(x, vec3(0.2126, 0.7152, 0.0722));
  return y > 0.0 ? x * (pow(y, p) / y) : x;
}
`;

const vertexShader = /* glsl */ `
uniform vec3 uRel;
uniform vec3 uX;
uniform vec3 uY;
uniform vec3 uZ;
uniform vec3 uHalf;
uniform float uShrink;
uniform mat3 uIcrfToScene;
varying vec3 vLocal;
varying float vD;
${RELATIVITY_GLSL}
void main() {
  vLocal = position * uHalf;
  // Model frame (kpc) to camera-relative ICRS (Mpc), shrunk toward the camera (the
  // picture is unchanged) to stay inside the projection's range.
  vec3 rel = uRel + (uX * vLocal.x + uY * vLocal.y + uZ * vLocal.z) * 1e-3;
  vec4 mv = modelViewMatrix * vec4(uIcrfToScene * (rel * uShrink), 1.0);
  vD = dopplerRest(normalize(mv.xyz));
  gl_Position = projectionMatrix * relativistic(mv);
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
uniform float uShare;
uniform float uDetail;
uniform float uDetailScale;
uniform float uTone;
${STRETCH}
varying vec3 vLocal;
varying float vD;
${RELATIVITY_GLSL}

float sech2(float x) {
  float e = exp(-2.0 * min(abs(x), 30.0));
  return 4.0 * e / ((1.0 + e) * (1.0 + e));
}

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float hash3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

// Turbulent structure (about -1..1) at wavelengths from 1 down to 1/16, leaving out those
// finer than 'fine' (the step's and pixel's footprint, same units) so it doesn't shimmer.
float fbm(vec3 p, float fine) {
  float s = 0.0, a = 0.5;
  for (int o = 0; o < 5; o++) {
    s += a * (1.0 - smoothstep(0.5, 1.0, fine)) * (2.0 * vnoise(p) - 1.0);
    p = p * 2.03 + 17.0;
    fine *= 2.03;
    a *= 0.55;
  }
  return s;
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
    // The bulge fades out in an ellipsoid inside the box (core/galaxymodel.ts bulgeTaper).
    float taper = 1.0 - smoothstep(0.7, 1.0, length(q / uHalf));
    vec3 j = uBulgeColour * rho0 * pow(s, -uBulgePB.x) * exp(-uBulgePB.y * pow(s, 1.0 / sn)) * taper;
    float kappa = 0.0;
    if (uDisc > 0.5) {
      vec2 uv = q.xy / uHalf.xy * 0.5 + 0.5;
      // Blur the maps to what this step and this pixel cover.
      float footprint = max(0.5 * ds * dxy, pix);
      float lod = log2(max(footprint / texel, 1.0));
      // Off the midplane the face-on structure blurs out (stars and dust above the disc
      // are spread over a kpc, not stacked over the arms), else it would be drawn out
      // into columns as tall as the disc is thick when seen at a slant.
      float lodz = max(lod, log2(max(abs(q.z) / texel, 1.0)));
      vec3 face = textureLod(uFace, uv, lodz).rgb;
      // Knots and fine structure in the thin layer, the smooth light in the thick one.
      float young = textureLod(uDust, uv, lodz).g;
      float lane = textureLod(uDust, uv, max(lodz - 1.0, 0.0)).r;
      float rr = length(q.xy);
      float tau = lane * lane * uTauMax + uTau0 * exp(-rr / uHd) * (uDh > 0.0 ? 1.0 - exp(-rr * rr / (uDh * uDh)) : 1.0);
      // Below the image's resolution: turbulent dust in clouds and filaments, with the
      // young light clumped between them. Both average to the maps' values, so from afar
      // nothing changes; only where a pixel covers less than the image's detail.
      float yMod = 1.0, oMod = 1.0;
      float amp = uDetail * (1.0 - smoothstep(1.0, 3.0, footprint / uDetailScale));
      if (amp > 0.0 && abs(q.z) < 4.0 * uZ0) {
        float nz = fbm(vec3(q.xy, 2.5 * q.z) / uDetailScale, footprint / uDetailScale);
        float sd = 2.6 * amp;
        tau *= exp(sd * nz - 0.5 * sd * sd * 0.07);
        yMod = exp(-1.6 * amp * nz - 0.5 * 2.56 * amp * amp * 0.07);
        oMod = exp(-0.4 * amp * nz);
      }
      j += face * face * uLight * ((1.0 - young) * oMod * sech2(q.z / uZ0) / (2.0 * uZ0) + young * yMod * sech2(q.z / uZy) / (2.0 * uZy));
      kappa = tau * sech2(q.z / uZd) / (2.0 * uZd);
    }
    j *= uShare;
    float a = kappa * ds;
    light += trans * j * ds * (a > 1e-4 ? (1.0 - exp(-a)) / a : 1.0);
    trans *= exp(-a);
    t += ds;
  }
  // A photograph's response: linear when faint, rolling off instead of clipping, with a
  // longer exposure once the galaxy fills the view (as its pictures are taken).
  // From a ship near light speed: shifted as a 5,500 K blackbody's light would be.
  vec3 c = 1.0 - exp(-stretch(light * uScale * uGain * dopplerTint(vD, 5500.0), uTone));
  if (max(c.r, max(c.g, c.b)) < 1.0 / 2048.0) discard;
  gl_FragColor = vec4(mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)), 1.0);
}
`;


// Resolved stars and HII regions (core/galaxystars.ts), in the model's frame like the volume.
const starVertex = /* glsl */ `
attribute float light;
attribute vec3 colour;
attribute float size;
uniform vec3 uRel;
uniform vec3 uX;
uniform vec3 uY;
uniform vec3 uZ;
uniform float uShrink;
uniform mat3 uIcrfToScene;
uniform vec3 uCam;
uniform float uStarScale;
uniform float uPpr;
uniform float uSigma;
uniform float uNear;
uniform sampler2D uDust;
uniform float uDisc;
uniform float uR;
uniform float uTauMax;
uniform float uTau0;
uniform float uHd;
uniform float uDh;
uniform float uZd;
varying vec3 vColour;
varying float vPeak;
varying float vSigma;
varying float vSize;
${RELATIVITY_GLSL}

void main() {
  vec3 toCam = uCam - position;
  float d = length(toCam);
  // Light summed over its pixels (as a point of the galaxy layer's), fading out when the
  // camera is closer than the stars' spacing: each stands for a crowd, not one star.
  float sum = light * uStarScale / max(d * d, 1e-12) * smoothstep(0.5 * uNear, 2.0 * uNear, d);
  if (uDisc > 0.5) {
    // Dust between it and the camera: the lanes' depth where the sight line is nearest the
    // mid-plane, times the share of the dust layer (sech^2, as the volume's) it crosses.
    float f = abs(toCam.z) > 1e-9 ? clamp(-position.z / toCam.z, 0.0, 1.0) : 0.0;
    vec2 c = position.xy + toCam.xy * f;
    float lane = textureLod(uDust, c / uR * 0.5 + 0.5, 1.0).r;
    float rr = length(c);
    float column = lane * lane * uTauMax + uTau0 * exp(-rr / uHd) * (uDh > 0.0 ? 1.0 - exp(-rr * rr / (uDh * uDh)) : 1.0);
    float dz = abs(toCam.z);
    float zc = clamp(uCam.z / uZd, -15.0, 15.0), zp = clamp(position.z / uZd, -15.0, 15.0);
    float e = exp(-2.0 * abs(zp));
    float through = dz > 0.01 * uZd ? 0.5 * abs(tanh(zc) - tanh(zp)) * d / dz : 4.0 * e / ((1.0 + e) * (1.0 + e)) / (2.0 * uZd) * min(d, 2.0 * uR);
    sum *= exp(-column * through);
  }
  float sigma = uSigma;
  float peak;
  if (size > 0.0) {
    // A glowing cloud: its own size once it is bigger than a point, fading out as it
    // grows to fill the view (by then the camera is inside the volume's own glow).
    float grown = size / d * uPpr;
    sigma = max(sigma, min(grown, 40.0));
    peak = sum / (6.2831853 * sigma * sigma) * (1.0 - smoothstep(10.0, 30.0, grown));
  } else {
    // A star: one that would saturate spreads into a bigger disc (keeping its light, so a
    // crowd of them adds up to the glow it was taken from).
    peak = sum / (6.2831853 * sigma * sigma);
    sigma *= min(sqrt(sqrt(max(peak, 1.0))), 4.0);
    peak = min(sum / (6.2831853 * sigma * sigma), 1.0);
  }
  if (peak < 1.0 / 2048.0) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 rel = uRel + (uX * position.x + uY * position.y + uZ * position.z) * 1e-3;
  vec4 mv = modelViewMatrix * vec4(uIcrfToScene * (rel * uShrink), 1.0);
  float D = dopplerRest(normalize(mv.xyz));
  gl_Position = projectionMatrix * relativistic(mv);
  gl_Position.z = gl_Position.w * 0.999999;
  vColour = colour * dopplerTint(D, 5500.0) / (D * D);
  vPeak = peak;
  vSigma = sigma;
  vSize = min(2.0 * ceil(3.0 * sigma) + 1.0, 511.0);
  gl_PointSize = vSize;
}
`;

const starFragment = /* glsl */ `
uniform float uTone;
varying vec3 vColour;
varying float vPeak;
varying float vSigma;
varying float vSize;
${STRETCH}
void main() {
  vec2 p = (gl_PointCoord - 0.5) * vSize;
  vec3 c = 1.0 - exp(-stretch(vColour * vPeak * exp(-0.5 * dot(p, p) / (vSigma * vSigma)), uTone));
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
  /** Resolved stars: made from the maps the first time they are needed. */
  stars?: THREE.Points;
  starUniforms?: Record<string, THREE.IUniform>;
  starState: 'idle' | 'ready';
  starCount: number;
  /** The share of the model's light they carry. */
  starShare: number;
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

  /** @param steps most samples along a ray (fewer on phones, and fewer stars). */
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
      uShare: { value: 1 },
      uTone: { value: 1 },
      uDetail: { value: spec.kind === 'disc' && spec.file ? 1 : 0 },
      // The finest detail the image holds: two of its coarser texels.
      uDetailScale: { value: (4 * spec.R) / Math.max(1, Math.min(...(spec.size ?? [1, 1]))) },
      ...relativityUniforms,
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
    this.items.push({ spec, place, mesh, uniforms, state: 'idle', onReady, starState: 'idle', starCount: this.steps >= 160 ? 200_000 : 60_000, starShare: 0 });
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
      // Exposure: the galaxy's own light, once it spans more than a few dozen pixels, as
      // its pictures are taken.
      const sizePx = ((spec.R * 2e-3) / d) * ppr;
      let gain = 1 + (PHOTO_GAIN - 1) * smoothstep(30, 300, sizePx);
      // Up close, exposed for what fills the view, as a camera there would be: the bulge
      // 1.5 effective radii out or the disc's mean light, whichever is brighter (the core
      // still burns out, as in pictures), with a gentler curve so both show.
      const near = smoothstep(3, 1.5, (d * 1e3) / spec.R);
      u.uTone.value = 1 - (1 - NEAR_TONE) * near;
      if (near > 0) {
        const o: Vec3 = [u.uCam.value.x, u.uCam.value.y, u.uCam.value.z];
        const r = Math.hypot(...o);
        let key = 0;
        if (spec.bulge.rho0 > 0) {
          // A sight line passing 1.5 effective radii from the centre.
          const side = Math.abs(o[2]) < 0.9 * r ? [0, 0, 1] : [1, 0, 0];
          const off = normalize(cross(o, side as Vec3));
          const aim: Vec3 = [0, 1, 2].map((k) => off[k] * 1.5 * spec.bulge.re - o[k]) as Vec3;
          key = integrateRay(spec, undefined, o, normalize(aim), 200);
        }
        if (spec.kind === 'disc' && spec.discL && spec.h) {
          key = Math.max(key, spec.discL / (Math.PI * (2 * spec.h) ** 2) / Math.max(Math.abs(o[2]) / r, 0.3));
        }
        if (key > 0) gain = Math.min(gain, gain * (1 - near) + (near * NEAR_EXPOSURE) / (key * scale));
      }
      u.uGain.value = gain;
      u.uPixelAngle.value = 1 / ppr;
      // Resolved stars once they would be more than a pixel or so apart; until then (and
      // from Earth) the volume carries all of the light.
      const fade = smoothstep(1, 3, sizePx / Math.sqrt(item.starCount));
      if (fade > 0 && item.starState === 'idle') this.makeStars(item);
      const su = item.starUniforms;
      const shown = fade > 0 && !!item.stars;
      u.uShare.value = shown ? 1 - item.starShare * fade : 1;
      if (item.stars) item.stars.visible = shown;
      if (!shown || !su) continue;
      su.uRel.value.copy(u.uRel.value);
      su.uCam.value.copy(u.uCam.value);
      su.uShrink.value = u.uShrink.value;
      su.uStarScale.value = flux * pointLight * (fromSun * 1e3) ** 2 * handover * u.uGain.value * fade;
      su.uPpr.value = ppr;
      su.uSigma.value = Math.sqrt(pointLight / (2 * Math.PI));
    }
  }

  /** Draws the galaxy's resolved stars from its maps (once). */
  private makeStars(item: Item): void {
    item.starState = 'ready';
    const { spec, uniforms: u } = item;
    const maps = spec.kind === 'disc' && spec.file ? discMaps(spec, u.uFace.value as THREE.Texture, u.uDust.value as THREE.Texture) : undefined;
    if (spec.kind === 'disc' && spec.file && !maps) return;
    const stars = sampleGalaxyStars(spec, maps, item.starCount);
    if (stars.count === 0) return;
    item.starShare = stars.share;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(stars.position, 3));
    geometry.setAttribute('light', new THREE.BufferAttribute(stars.light, 1));
    geometry.setAttribute('colour', new THREE.BufferAttribute(stars.colour, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(stars.size, 1));
    const su: Record<string, THREE.IUniform> = {
      uRel: { value: new THREE.Vector3() },
      uX: u.uX, uY: u.uY, uZ: u.uZ,
      uShrink: { value: 1 },
      uIcrfToScene: u.uIcrfToScene,
      uCam: { value: new THREE.Vector3() },
      uStarScale: { value: 0 },
      uPpr: { value: 1 },
      uSigma: { value: 1 },
      // About the stars' spacing in the disc.
      uNear: { value: (2 * spec.R) / Math.sqrt(stars.count) },
      uTone: u.uTone,
      uDust: u.uDust, uDisc: u.uDisc, uR: { value: spec.R }, uTauMax: u.uTauMax, uTau0: u.uTau0, uHd: u.uHd, uDh: u.uDh, uZd: u.uZd,
      ...relativityUniforms,
    };
    const material = new THREE.ShaderMaterial({
      uniforms: su, vertexShader: starVertex, fragmentShader: starFragment,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: false,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = -10;
    points.visible = false;
    this.group.add(points);
    item.stars = points;
    item.starUniforms = su;
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
/** Value (before the photographic roll-off) of what fills the view when close. */
const NEAR_EXPOSURE = 0.3;
/** Power on the brightness before the roll-off when close: faint parts lifted, as pictures are stretched. */
const NEAR_TONE = 1;

/** The face-on maps as numbers, read back from the decoded images. */
function discMaps(spec: GalaxyModelSpec, face: THREE.Texture, dust: THREE.Texture): DiscMaps | undefined {
  const a = pixels(face.image), b = pixels(dust.image);
  if (!a || !b || a.width !== b.width || a.height !== b.height) return undefined;
  const n = a.width * a.height;
  const light = new Float32Array(n), colour = new Float32Array(3 * n), young = new Float32Array(n);
  const peak = spec.light ?? 0;
  const bc = spec.bulge.colour;
  for (let k = 0; k < n; k++) {
    const r = (a.data[4 * k] / 255) ** 2, g = (a.data[4 * k + 1] / 255) ** 2, bl = (a.data[4 * k + 2] / 255) ** 2;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    light[k] = y * peak;
    if (y > 1e-6) colour.set([r / y, g / y, bl / y], 3 * k);
    else colour.set(bc, 3 * k);
    young[k] = b.data[4 * k + 1] / 255;
  }
  return { width: a.width, height: a.height, light, colour, young };
}

function pixels(source: unknown): ImageData | undefined {
  const image = source as CanvasImageSource & { width: number; height: number } | undefined;
  if (!image?.width) return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height);
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
