import type { Vec3 } from './ephemeris';
import { bulgeTaper, type GalaxyModelSpec } from './galaxymodel';
import { kelvinToRgb } from './stars';

/**
 * Detail below a survey image's resolution, for the 3D galaxy models: individual bright
 * stars, young clusters and the HII regions around them, drawn at random from the
 * model's own light. Where the image puts more light (and more young light) there are more
 * stars, so seen from afar they add up to the same picture; up close they break the
 * smooth glow into points as a real galaxy's picture does. The renderer takes the share of
 * the light they carry out of the volume (render/galaxymodels.ts).
 */

/**
 * Fraction of each component's light in its brightest stars, the ones a picture resolves
 * (giants and supergiants); the rest is the glow of the many fainter ones.
 */
export const STAR_SHARE = 0.05;
/** Fraction of the young light that is the HII regions' glow. */
const HII_SHARE = 0.05;

export interface GalaxyStars {
  count: number;
  /** Model frame (kpc), xyz per star. */
  position: Float32Array;
  /** Light, in units of the galaxy's total (as the model's). */
  light: Float32Array;
  /** Linear RGB of unit luminance. */
  colour: Float32Array;
  /** Radius of a glowing region (kpc); 0 for a star. */
  size: Float32Array;
  /** Light carried by all of them, as a fraction of the model's. */
  share: number;
}

/**
 * The disc's face-on maps as the renderer has them: luminance per kpc^2 (units of the
 * galaxy's total), its colour (RGB of unit luminance) and the young fraction, row 0 at +y.
 */
export interface DiscMaps {
  width: number;
  height: number;
  light: Float32Array;
  colour: Float32Array;
  young: Float32Array;
}

/** A small, fast seeded generator (mulberry32): the same stars every time. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(name: string): number {
  let h = 2166136261;
  for (let k = 0; k < name.length; k++) h = Math.imul(h ^ name.charCodeAt(k), 16777619);
  return h >>> 0;
}

/** Picks texels in proportion to a weight map: a CDF over rows, then within the row. */
class TexelSampler {
  readonly total: number;
  private readonly rows: Float64Array;
  private readonly within: Float32Array;

  constructor(private readonly w: number, private readonly h: number, weight: (k: number) => number) {
    this.rows = new Float64Array(h + 1);
    this.within = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      let s = 0;
      for (let i = 0; i < w; i++) {
        s += Math.max(weight(j * w + i), 0);
        this.within[j * w + i] = s;
      }
      if (s > 0) for (let i = 0; i < w; i++) this.within[j * w + i] /= s;
      this.rows[j + 1] = this.rows[j] + s;
    }
    this.total = this.rows[h];
  }

  /** A texel index, or -1 when the map is empty. */
  pick(u: number, v: number): number {
    if (!(this.total > 0)) return -1;
    const j = upper(this.rows, u * this.total, 1, this.h + 1) - 1;
    const row = this.within.subarray(j * this.w, (j + 1) * this.w);
    return j * this.w + Math.min(upper(row, v, 0, this.w), this.w - 1);
  }
}

/** First index in [lo, hi) whose value exceeds x (or hi). */
function upper(a: ArrayLike<number>, x: number, lo: number, hi: number): number {
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] > x) hi = m;
    else lo = m + 1;
  }
  return lo;
}

/** A height drawn from a sech^2 layer of scale height z. */
const sech2Height = (u: number, z: number) => z * Math.atanh(Math.min(Math.max(2 * u - 1, -0.999999), 0.999999));

/** A star's light relative to its population's mean: a power law dN/dL ~ L^-a over 1..1000. */
function powerLaw(u: number, a: number): number {
  const lo = 1, hi = 1000, k = 1 - a;
  return (lo ** k + u * (hi ** k - lo ** k)) ** (1 / k);
}

function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

/** Colour of unit luminance. */
function unit(c: Vec3): Vec3 {
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [c[0] / y, c[1] / y, c[2] / y];
}

/** A star's tint relative to its population's mean colour, from its temperature. */
function tint(kelvin: number, mean: number): Vec3 {
  const a = unit(kelvinToRgb(kelvin)), b = unit(kelvinToRgb(mean));
  return [a[0] / b[0], a[1] / b[1], a[2] / b[2]];
}

/** Hydrogen-alpha with some H-beta and [O III]: the pink of HII regions in colour pictures. */
const HII_COLOUR = unit([1, 0.3, 0.5]);

/**
 * Draws `count` stars (and the young clusters' HII regions) from a model: the bulge from
 * its Sersic profile, the disc from its face-on maps (old stars in the thick layer, young
 * ones clumped in clusters in the thin one).
 */
export function sampleGalaxyStars(spec: GalaxyModelSpec, maps: DiscMaps | undefined, count: number): GalaxyStars {
  const rand = random(seedOf(spec.name));
  const disc = spec.kind === 'disc' && maps;
  const texelArea = disc ? ((2 * spec.R) / maps.width) * ((2 * spec.R) / maps.height) : 0;
  const old = disc ? new TexelSampler(maps.width, maps.height, (k) => maps.light[k] * (1 - maps.young[k])) : undefined;
  const young = disc ? new TexelSampler(maps.width, maps.height, (k) => maps.light[k] * maps.young[k]) : undefined;
  const Lo = (old?.total ?? 0) * texelArea, Ly = (young?.total ?? 0) * texelArea;
  const Lb = spec.bulge.L > 0 && spec.bulge.rho0 > 0 ? spec.bulge.L : 0;
  // Young stars are brighter one by one: fewer of them for their light.
  const sumL = Lb + Lo + Ly;
  const weights = [Lb, Lo, 0.5 * Ly];
  const sumW = weights[0] + weights[1] + weights[2];
  if (!(sumW > 0)) return empty();
  const nb = Math.round((count * weights[0]) / sumW), no = Math.round((count * weights[1]) / sumW);
  const ny = Math.max(count - nb - no, 0);
  const nh = Ly > 0 ? Math.min(Math.round(ny / 40), 6000) : 0;
  const n = nb + no + ny + nh;
  const position = new Float32Array(3 * n), light = new Float32Array(n), colour = new Float32Array(3 * n), size = new Float32Array(n);
  let k = 0;
  const put = (p: Vec3, l: number, c: Vec3, r = 0) => {
    position.set(p, 3 * k);
    light[k] = l;
    colour.set(c, 3 * k);
    size[k] = r;
    k++;
  };
  // Each population's light is shared out by a power law, then scaled to its share.
  const scaleFrom = (start: number, total: number) => {
    let s = 0;
    for (let i = start; i < k; i++) s += light[i];
    if (s > 0) for (let i = start; i < k; i++) light[i] *= total / s;
  };
  const texelCentre = (t: number): Vec3 => {
    const i = t % maps!.width, j = Math.floor(t / maps!.width);
    // Anywhere in the texel: the detail the image could not show.
    return [((i + rand()) / maps!.width * 2 - 1) * spec.R, -((j + rand()) / maps!.height * 2 - 1) * spec.R, 0];
  };
  const mapColour = (t: number): Vec3 => [maps!.colour[3 * t], maps!.colour[3 * t + 1], maps!.colour[3 * t + 2]];
  const mul = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];

  // The bulge: radii from the deprojected Sersic profile (inverse CDF on a grid fine at the
  // centre), directions at random, flattened by its axis ratio.
  if (nb > 0) {
    const b = spec.bulge;
    const smax = Math.hypot(spec.R, spec.H) / b.re;
    const K = 4096;
    const s = new Float64Array(K + 1), cdf = new Float64Array(K + 1);
    for (let i = 1; i <= K; i++) {
      s[i] = smax * (i / K) ** 3;
      const mid = 0.5 * (s[i] + s[i - 1]);
      cdf[i] = cdf[i - 1] + mid * mid * mid ** -b.p * Math.exp(-b.b * mid ** (1 / b.n)) * (s[i] - s[i - 1]);
    }
    const start = k;
    for (let tries = 0; k - start < nb && tries < 20 * nb; tries++) {
      const u = rand() * cdf[K];
      const i = Math.min(upper(cdf, u, 1, K + 1), K);
      const r = (s[i - 1] + (s[i] - s[i - 1]) * ((u - cdf[i - 1]) / Math.max(cdf[i] - cdf[i - 1], 1e-300))) * b.re;
      const cz = 2 * rand() - 1, phi = 2 * Math.PI * rand(), sz = Math.sqrt(1 - cz * cz);
      const p: Vec3 = [r * sz * Math.cos(phi), r * sz * Math.sin(phi), r * cz * b.q0];
      if (rand() > bulgeTaper(spec, p)) continue;
      put(p, powerLaw(rand(), 2.5), mul(b.colour, tint(3600 + 1600 * rand(), 4300)));
    }
    scaleFrom(start, STAR_SHARE * Lb);
  }
  if (disc && old && no > 0) {
    const start = k;
    for (let i = 0; i < no; i++) {
      const t = old.pick(rand(), rand());
      const p = texelCentre(t);
      p[2] = sech2Height(rand(), spec.z0!);
      put(p, powerLaw(rand(), 2.5), mul(mapColour(t), tint(3600 + 1600 * rand(), 4300)));
    }
    scaleFrom(start, STAR_SHARE * Lo);
  }
  if (disc && young && ny > 0) {
    // Young stars are born in clusters: centres drawn from the young light, members around.
    const zy = spec.zy ?? spec.zd!;
    const clusters = Math.max(Math.round(ny / 12), 1);
    const centres = new Float32Array(4 * clusters);
    const tex = new Int32Array(clusters);
    for (let c = 0; c < clusters; c++) {
      const t = young.pick(rand(), rand());
      const p = texelCentre(t);
      centres.set([p[0], p[1], sech2Height(rand(), zy), 0.015 * 8 ** rand()], 4 * c);
      tex[c] = t;
    }
    const start = k;
    for (let i = 0; i < ny; i++) {
      const c = Math.floor(rand() * clusters);
      const rc = centres[4 * c + 3];
      const p: Vec3 = [centres[4 * c] + gaussian(rand) * rc, centres[4 * c + 1] + gaussian(rand) * rc,
        centres[4 * c + 2] + gaussian(rand) * rc * 0.5];
      // Mostly hot blue stars, some red supergiants.
      const kelvin = rand() < 0.12 ? 3500 + 800 * rand() : 9000 * 3 ** rand();
      put(p, powerLaw(rand(), 2.0), mul(mapColour(tex[c]), tint(kelvin, 12000)));
    }
    scaleFrom(start, STAR_SHARE * Ly);
    // The gas lit by the biggest clusters glows around them.
    const hStart = k;
    for (let i = 0; i < nh; i++) {
      const c = Math.floor(rand() * clusters);
      const r = 0.02 * 10 ** rand();
      put([centres[4 * c], centres[4 * c + 1], centres[4 * c + 2]], r * r * (0.5 + rand()), HII_COLOUR, r);
    }
    scaleFrom(hStart, HII_SHARE * Ly);
  }
  let total = 0;
  for (let i = 0; i < k; i++) total += light[i];
  return {
    count: k, position: position.subarray(0, 3 * k), light: light.subarray(0, k), colour: colour.subarray(0, 3 * k),
    size: size.subarray(0, k), share: total / sumL,
  };
}

function empty(): GalaxyStars {
  return { count: 0, position: new Float32Array(0), light: new Float32Array(0), colour: new Float32Array(0), size: new Float32Array(0), share: 0 };
}
