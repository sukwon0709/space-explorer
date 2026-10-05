import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { icrfToScene } from '../core/frames';
import { KMS_TO_PCYR, REDDENING, decodeBlock, type StarBlock, type StarIndex } from '../core/stars';

/** Radius of the Sun in parsecs. */
const SUN_RADIUS_PC = 695700 / 3.0856775814913673e13;

/**
 * Bolometric correction (Flower 1996 / Torres 2010) and the star's radius, shared by
 * the star and constellation shaders. Matches bolometricCorrection() in core/stars.ts.
 */
const STAR_GLSL = /* glsl */ `
float bolometricCorrection(float t) {
  float lt = log2(t) * 0.30102999566;
  if (lt < 3.7) return -19053.7291496456 + lt * (15514.4866764412 + lt * (-4212.78819301717 + lt * 381.476328422343));
  if (lt < 3.9) return -37051.0203809015 + lt * (38567.2629965804 + lt * (-15065.1486316025 + lt * (2617.24637119416 + lt * -170.623810323864)));
  return -118115.450538963 + lt * (137145.973583929 + lt * (-63623.3812100225 + lt * (14741.2923562646 + lt * (-1705.87278406872 + lt * 78.8731721804990))));
}
vec3 kelvinToRgb(float kelvin) {
  float t = clamp(kelvin, 1000.0, 40000.0) / 100.0;
  float r = t <= 66.0 ? 255.0 : 329.698727446 * pow(t - 60.0, -0.1332047592);
  float g = t <= 66.0 ? 99.4708025861 * log(t) - 161.1195681661 : 288.1221695283 * pow(t - 60.0, -0.0755148492);
  float b = t >= 66.0 ? 255.0 : (t <= 19.0 ? 0.0 : 138.5177312231 * log(t - 10.0) - 305.0447927307);
  vec3 srgb = clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
  vec3 lin = mix(srgb / 12.92, pow((srgb + 0.055) / 1.055, vec3(2.4)), step(0.04045, srgb));
  return lin / max(lin.r, max(lin.g, lin.b));
}
`;

const vertexShader = /* glsl */ `
attribute vec3 velocity;
attribute float absMag;
attribute float teffCode;
attribute float avCode;

uniform vec3 uCamHigh;
uniform vec3 uCamLow;
uniform float uYears;
uniform mat3 uIcrfToScene;
uniform float uMsat;
uniform float uCull;
uniform float uSigma;
uniform float uMaxSigma;
uniform float uPixelsPerRadian;
uniform float uPixelRatio;
uniform float uBrightness;
uniform vec2 uTeff;
uniform float uAvStep;
uniform float uDustBlend;
uniform sampler3D uDust;
uniform mat3 uIcrfToGal;
uniform vec3 uDustLo;
uniform vec3 uDustSize;
uniform float uDustScale;
uniform float uHideWithin;

varying vec3 vColor;
varying float vPeak;
varying float vSigma;
varying float vDisc;
varying float vSize;

${STAR_GLSL}

// A_V along the line of sight through the 3D dust grid (Galactic axes, heliocentric).
float dustBetween(vec3 cam, vec3 rel) {
  vec3 a = uIcrfToGal * cam;
  vec3 dir = uIcrfToGal * rel;
  vec3 inv = 1.0 / dir;
  vec3 t0 = (uDustLo - a) * inv;
  vec3 t1 = (uDustLo + uDustSize - a) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float enter = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float leave = min(min(tmax.x, tmax.y), min(tmax.z, 1.0));
  if (leave <= enter) return 0.0;
  float sum = 0.0;
  for (int i = 0; i < 16; i++) {
    float t = mix(enter, leave, (float(i) + 0.5) / 16.0);
    float v = texture(uDust, (a + dir * t - uDustLo) / uDustSize).r;
    sum += v * v;
  }
  return sum * uDustScale * length(dir) * (leave - enter) / 16.0;
}

void main() {
  // Floating origin in parsecs: the camera is split into a float32 high part and the
  // remainder, so the subtraction stays exact for stars near the camera.
  vec3 rel = (position - uCamHigh) + (velocity * (uYears * ${KMS_TO_PCYR.toExponential(10)}) - uCamLow);
  float d = length(rel);
  float m = absMag * 0.001 + 5.0 * log2(d * 0.1) * 0.30102999566;
  // 10^(-0.4 (m - uMsat)): 1 is a star whose peak just reaches full brightness.
  float flux = exp2(-1.3287712 * (m - uMsat)) * uBrightness;
  float av = avCode * uAvStep;
  if (uDustBlend > 0.0 && flux > uCull) av = mix(av, dustBetween(uCamHigh + uCamLow, rel), uDustBlend);
  flux *= exp2(-1.3287712 * av);
  vec3 color = kelvinToRgb(uTeff.x * exp(teffCode * uTeff.y)) * exp2(-1.3287712 * av * (vec3(${REDDENING.join(', ')}) - 1.0));
  // Normalised so a star's luminance carries its V flux.
  color /= dot(color, vec3(0.2126, 0.7152, 0.0722));

  float teff = uTeff.x * exp(teffCode * uTeff.y);
  float lum = exp2(-1.3287712 * (absMag * 0.001 + bolometricCorrection(teff) - 4.74));
  float discPx = sqrt(lum) * (5772.0 / teff) * (5772.0 / teff) * ${SUN_RADIUS_PC.toExponential(8)} / d * uPixelsPerRadian * uPixelRatio;

  vec3 dir = uIcrfToScene * (rel / d);
  vec4 view = modelViewMatrix * vec4(dir, 0.0);
  gl_Position = projectionMatrix * vec4(view.xyz, 1.0);
  gl_Position.z = gl_Position.w * 0.999999; // far plane

  float sigma = uSigma * uPixelRatio;
  float peak = min(flux, 1.0);
  // Bright stars spread like glare in the eye or a photograph: from 3.8 magnitudes
  // below saturation they grow instead of only brightening.
  sigma *= min(pow(max(flux * 33.0, 1.0), 0.3), uMaxSigma);
  vDisc = discPx > 0.5 * uSigma * uPixelRatio ? discPx : 0.0;
  if (peak < uCull || d < uHideWithin) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vColor = color;
  vPeak = peak;
  vSigma = sigma;
  vSize = min(2.0 * ceil(max(3.0 * sigma, vDisc * 1.2 + 2.0)) + 1.0, 1023.0);
  gl_PointSize = vSize;
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vColor;
varying float vPeak;
varying float vSigma;
varying float vDisc;
varying float vSize;
void main() {
  vec2 p = (gl_PointCoord - 0.5) * vSize;
  float r2 = dot(p, p);
  float glow = vPeak * exp(-0.5 * r2 / (vSigma * vSigma));
  if (vDisc > 0.0) {
    // A resolved disc, limb-darkened, saturated: brighter than any display.
    float rho2 = r2 / (vDisc * vDisc);
    float mu = sqrt(max(0.0, 1.0 - rho2));
    float limb = rho2 < 1.0 ? 0.3 + 0.93 * mu - 0.23 * mu * mu : 0.0;
    glow = max(glow, 4.0 * limb);
  }
  vec3 c = vColor * glow;
  if (max(c.r, max(c.g, c.b)) < 1.0 / 2048.0) discard;
  // Encoded for display like the rest of the scene (linear to sRGB).
  c = min(c, 1.0);
  gl_FragColor = vec4(mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)), 1.0);
}
`;

export interface DustGrid {
  texture: THREE.Data3DTexture;
  lo: Vec3;
  size: Vec3;
  /** A_V per parsec for a stored value of 1. */
  scale: number;
}

const ICRS_TO_GAL = new THREE.Matrix3().set(
  -0.0548755604162154, -0.8734370902348850, -0.4838350155487132,
  0.4941094278755837, -0.4448296299600112, 0.7469822444972189,
  -0.8676661490190047, -0.1980763734312015, 0.4559837761750669,
);

/**
 * The star octree: streams nodes of stars in as the camera needs them, and draws them
 * with true positions (proper motion and parallax included), brightness from distance
 * and dust, and colour from temperature.
 */
export class StarField {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  /** Stars that load: every node whose most luminous star could beat this magnitude. */
  loadLimit = 8;
  private readonly points = new Map<number, THREE.Points>();
  private readonly packs = new Map<number, ArrayBuffer | 'loading' | 'failed'>();
  readonly blocks = new Map<number, StarBlock>();
  private needed = new Set<number>();
  pending = 0;

  constructor(readonly index: StarIndex, private readonly packUrl: (pack: number) => string, pixelRatio: number, dust?: DustGrid) {
    const icrfToScene = new THREE.Matrix3();
    const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => icrfToScene3(v as Vec3));
    icrfToScene.set(cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]);
    const empty = new THREE.Data3DTexture(new Uint8Array(1), 1, 1, 1);
    empty.format = THREE.RedFormat;
    empty.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCamHigh: { value: new THREE.Vector3() },
        uCamLow: { value: new THREE.Vector3() },
        uYears: { value: 0 },
        uIcrfToScene: { value: icrfToScene },
        uMsat: { value: 2 },
        uCull: { value: 1 / 1600 },
        uSigma: { value: 0.75 },
        uMaxSigma: { value: 8 },
        uPixelsPerRadian: { value: 800 },
        uPixelRatio: { value: pixelRatio },
        uBrightness: { value: 1 },
        uTeff: { value: new THREE.Vector2(index.teff[0], Math.log(index.teff[1]) / 255) },
        uAvStep: { value: index.avStep },
        uDustBlend: { value: 0 },
        uDust: { value: dust?.texture ?? empty },
        uIcrfToGal: { value: ICRS_TO_GAL },
        uDustLo: { value: new THREE.Vector3(...(dust?.lo ?? [0, 0, 0])) },
        uDustSize: { value: new THREE.Vector3(...(dust?.size ?? [1, 1, 1])) },
        uDustScale: { value: dust?.scale ?? 0 },
        uHideWithin: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      transparent: false,
    });
    this.group.renderOrder = -10;
  }

  /** Uniforms shared with the constellation lines. */
  get uniforms() {
    return this.material.uniforms;
  }

  /** Stars nearer the camera than this (pc) are not drawn. */
  set hideWithin(pc: number) {
    this.material.uniforms.uHideWithin.value = pc;
  }

  /**
   * @param camera barycentric ICRS position of the camera, parsecs (float64).
   * @param years years since J2016.0.
   */
  update(camera: Vec3, years: number): void {
    const u = this.material.uniforms;
    const high = camera.map((c) => Math.fround(c)) as Vec3;
    u.uCamHigh.value.set(high[0], high[1], high[2]);
    u.uCamLow.value.set(camera[0] - high[0], camera[1] - high[1], camera[2] - high[2]);
    u.uYears.value = years;
    // Dust is integrated per star once the camera is away from the Sun; from the Sun
    // the catalogue's A_V is used as is.
    const fromSun = Math.hypot(camera[0], camera[1], camera[2]);
    u.uDustBlend.value = u.uDustScale.value > 0 ? THREE.MathUtils.smoothstep(fromSun, 2, 10) : 0;

    // Which nodes are needed: the root, then any child whose most luminous star could
    // be brighter than the load limit from here (dust only makes stars fainter).
    const nodes = this.index.nodes;
    const needed = new Set<number>();
    const stack = [0];
    while (stack.length) {
      const i = stack.pop()!;
      needed.add(i);
      for (const c of nodes[i].children) {
        const n = nodes[c];
        let d2 = 0;
        for (let a = 0; a < 3; a++) {
          const d = Math.max(0, Math.abs(camera[a] - n.center[a]) - n.half - 0.2);
          d2 += d * d;
        }
        const m = n.minM + 5 * Math.log10(Math.max(Math.sqrt(d2), 1e-6) / 10);
        if (m < this.loadLimit) stack.push(c);
      }
    }
    this.needed = needed;
    let pending = 0;
    for (const i of needed) {
      const pack = this.packs.get(nodes[i].pack);
      if (pack === undefined) this.requestPack(nodes[i].pack);
      if (pack === undefined || pack === 'loading') pending++;
      else if (pack !== 'failed' && !this.points.has(i)) this.makePoints(i, pack);
    }
    this.pending = pending;
    for (const [i, p] of this.points) p.visible = needed.has(i);
  }

  /** Nodes currently drawn. */
  get drawn(): number[] {
    return [...this.needed].filter((i) => this.points.has(i));
  }

  private requestPack(pack: number): void {
    this.packs.set(pack, 'loading');
    fetch(this.packUrl(pack))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
      .then((buffer) => this.packs.set(pack, buffer))
      .catch((err) => {
        console.warn(`star pack ${pack}:`, err);
        this.packs.set(pack, 'failed');
      });
  }

  private makePoints(i: number, buffer: ArrayBuffer): void {
    const node = this.index.nodes[i];
    const block = decodeBlock(buffer, node.offset, node.count);
    this.blocks.set(i, block);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(block.position, 3));
    g.setAttribute('velocity', new THREE.Float16BufferAttribute(block.velocity, 3));
    g.setAttribute('absMag', new THREE.BufferAttribute(block.absMag, 1));
    g.setAttribute('teffCode', new THREE.BufferAttribute(block.teffCode, 1));
    g.setAttribute('avCode', new THREE.BufferAttribute(block.avCode, 1));
    const p = new THREE.Points(g, this.material);
    p.frustumCulled = false;
    p.renderOrder = -10;
    this.points.set(i, p);
    this.group.add(p);
  }
}

function icrfToScene3(v: Vec3): Vec3 {
  return icrfToScene(v, [0, 0, 0]);
}

/**
 * A single star drawn with the star field's shader (the Sun seen from afar), with its
 * own position.
 */
export function makeSingleStar(material: THREE.ShaderMaterial, absMag: number, teffCode: number): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  g.setAttribute('velocity', new THREE.Float16BufferAttribute(new Uint16Array(3), 3));
  g.setAttribute('absMag', new THREE.BufferAttribute(new Int16Array([Math.round(absMag * 1000)]), 1));
  g.setAttribute('teffCode', new THREE.BufferAttribute(new Uint8Array([teffCode]), 1));
  g.setAttribute('avCode', new THREE.BufferAttribute(new Uint8Array(1), 1));
  const p = new THREE.Points(g, material);
  p.frustumCulled = false;
  p.renderOrder = -10;
  return p;
}

export { STAR_GLSL };
