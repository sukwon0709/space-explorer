import type { Vec3 } from './ephemeris';

/**
 * The star catalogue: an octree of Gaia DR3 and Hipparcos stars (pipeline/build_stars.py).
 * Positions are barycentric ICRS at J2016.0 in parsecs with space velocities in km/s,
 * so a star's position at any time is a straight-line extrapolation (as in SOFA's
 * pmsafe). Magnitudes are absolute V with extinction removed; the apparent magnitude is
 * recomputed from wherever the camera is.
 */

export const PC_KM = 3.0856775814913673e13;
/** 1 km/s in parsecs per Julian year. */
export const KMS_TO_PCYR = 1.0227121650537077e-6;
/** J2016.0 (TDB) in seconds past J2000. */
export const J2016_TDB = (2457389.0 - 2451545.0) * 86400;
export const JULIAN_YEAR = 365.25 * 86400;
/** Extinction in each colour channel relative to V (Cardelli et al. 1989, R_V = 3.1, at ~610, 545 and 450 nm). */
export const REDDENING: Vec3 = [0.748, 1.0, 1.324];

export interface StarNode {
  level: number;
  center: Vec3;
  half: number;
  count: number;
  /** Absolute V of the node's most and least luminous star. */
  minM: number;
  maxM: number;
  pack: number;
  offset: number;
  parent: number;
  children: number[];
}

export interface StarIndex {
  epoch: number;
  count: number;
  packs: number;
  teff: [number, number];
  avStep: number;
  nodes: StarNode[];
}

interface RawIndex {
  epoch: number;
  count: number;
  packs: number;
  teff: [number, number];
  avStep: number;
  nodes: Array<[number, number, number, number, number, number, number, number, number, number, number, number[]]>;
}

export function parseStarIndex(raw: RawIndex): StarIndex {
  return {
    ...raw,
    nodes: raw.nodes.map(([level, cx, cy, cz, half, count, minM, maxM, pack, offset, parent, children]) => ({
      level, center: [cx, cy, cz], half, count, minM, maxM, pack, offset, parent, children,
    })),
  };
}

/** One octree node's stars, as stored (see build_stars.py for the layout). */
export interface StarBlock {
  count: number;
  /** x, y, z per star: barycentric ICRS at J2016.0, pc. */
  position: Float32Array;
  /** vx, vy, vz per star as IEEE half floats, km/s. */
  velocity: Uint16Array;
  /** Absolute V magnitude, millimag, extinction removed. */
  absMag: Int16Array;
  teffCode: Uint8Array;
  avCode: Uint8Array;
}

export function decodeBlock(buffer: ArrayBuffer, offset: number, count: number): StarBlock {
  return {
    count,
    position: new Float32Array(buffer, offset, count * 3),
    velocity: new Uint16Array(buffer, offset + 12 * count, count * 3),
    absMag: new Int16Array(buffer, offset + 18 * count, count),
    teffCode: new Uint8Array(buffer, offset + 20 * count, count),
    avCode: new Uint8Array(buffer, offset + 21 * count, count),
  };
}

export function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

/** Years since the catalogue epoch J2016.0 for a TDB time (seconds past J2000). */
export function yearsSinceEpoch(tdb: number): number {
  return (tdb - J2016_TDB) / JULIAN_YEAR;
}

/** A star's barycentric ICRS position (pc) `years` after J2016.0. */
export function starPosition(block: StarBlock, i: number, years: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const k = years * KMS_TO_PCYR;
  for (let a = 0; a < 3; a++) out[a] = block.position[i * 3 + a] + halfToFloat(block.velocity[i * 3 + a]) * k;
  return out;
}

export function teffFromCode(code: number, index: Pick<StarIndex, 'teff'>): number {
  return index.teff[0] * Math.pow(index.teff[1], code / 255);
}

/** Apparent V at `distancePc` with `av` magnitudes of extinction. */
export function apparentMagnitude(absMag: number, distancePc: number, av: number): number {
  return absMag + 5 * Math.log10(distancePc / 10) + av;
}

/**
 * Bolometric correction BC_V for an effective temperature (Flower 1996 as corrected by
 * Torres 2010). M_bol = M_V + BC_V; the Sun's M_bol is 4.74.
 */
export function bolometricCorrection(teff: number): number {
  const lt = Math.log10(teff);
  if (lt < 3.7) return -0.190537291496456e5 + lt * (0.155144866764412e5 + lt * (-0.421278819301717e4 + lt * 0.381476328422343e3));
  if (lt < 3.9) {
    return -0.370510203809015e5 + lt * (0.385672629965804e5 + lt * (-0.150651486316025e5 + lt * (0.261724637119416e4 + lt * -0.170623810323864e3)));
  }
  return -0.118115450538963e6 + lt * (0.137145973583929e6 + lt * (-0.636233812100225e5 + lt * (0.147412923562646e5 + lt * (-0.170587278406872e4 + lt * 0.788731721804990e2))));
}

/** Radius in solar radii from absolute V and temperature (Stefan-Boltzmann). */
export function starRadius(absMag: number, teff: number): number {
  const lum = Math.pow(10, -0.4 * (absMag + bolometricCorrection(teff) - 4.74));
  return Math.sqrt(lum) * (5772 / teff) ** 2;
}

/** Blackbody temperature to linear RGB, normalised so the brightest channel is 1 (Planck fit, 1,000-40,000 K). */
export function kelvinToRgb(kelvin: number): Vec3 {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const srgb = [r, g, b].map((c) => Math.min(255, Math.max(0, c)) / 255);
  const linear = srgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  const max = Math.max(...linear);
  return [linear[0] / max, linear[1] / max, linear[2] / max];
}

/** A star in the named-star index (stars/named.json). */
export interface NamedStar {
  name: string;
  desig?: string;
  /** The name the exoplanet archive uses, if different. */
  host?: string;
  /** Other common names. */
  aka?: string[];
  hip?: number;
  gaia?: string;
  pos: Vec3;
  vel: Vec3;
  M: number;
  V: number;
  teff: number;
  av: number;
  /** Solar radii. */
  radius: number;
  planets?: Exoplanet[];
}

export interface Exoplanet {
  name: string;
  /** Orbital period, days. */
  period?: number;
  /** Semi-major axis, AU. */
  a?: number;
  e?: number;
  /** Inclination to the sky plane, degrees. */
  incl?: number;
  /** Earth radii and Earth masses (mass may be a minimum mass). */
  radius?: number;
  mass?: number;
  /** Equilibrium temperature, K. */
  teq?: number;
  method?: string;
  year?: number;
}

/** A named star's position (pc) `years` after J2016.0. */
export function namedStarPosition(star: NamedStar, years: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const k = years * KMS_TO_PCYR;
  for (let a = 0; a < 3; a++) out[a] = star.pos[a] + star.vel[a] * k;
  return out;
}
