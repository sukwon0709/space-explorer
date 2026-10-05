import type { Vec3 } from './ephemeris';

/**
 * The galaxy catalogue (pipeline/build_galaxies.py): galaxies from the Updated Nearby
 * Galaxy Catalog, Cosmicflows-4, 2MRS, 6dFGS and SDSS, at measured distances where they
 * exist and redshift distances otherwise, plus the Milky Way's globular clusters.
 * Positions are barycentric ICRS in comoving Mpc.
 */

export const MPC_KM = 3.0856775814913673e19;
export const MPC_PC = 1e6;
export const C_KMS = 299792.458;

export interface GalaxyBlock {
  count: number;
  /** x, y, z per galaxy: barycentric ICRS, Mpc. */
  position: Float32Array;
  /** Absolute V magnitude code: M = -26 + code / 10. */
  absMag: Uint8Array;
  /** Radius code: disc scale length or spheroid half-light radius = 0.05 kpc * 10^(code / 60). */
  radius: Uint8Array;
  /** Axis ratio b/a, code / 255. */
  axis: Uint8Array;
  /** Position angle east of north, code * 180 / 256 degrees. */
  angle: Uint8Array;
  /** B-V colour, code / 200. */
  colour: Uint8Array;
  /** Milky Way E(B-V) in front of it, code / 100. */
  ebv: Uint8Array;
  /** Bits 0-3 distance method, bit 4 spheroid, bit 5 drawn from an image, bit 6 globular cluster. */
  flags: Uint8Array;
}

export const FLAG_SPHEROID = 16;
export const FLAG_IMAGE = 32;
export const FLAG_GLOBULAR = 64;

export function decodeGalaxies(buffer: ArrayBuffer, count: number): GalaxyBlock {
  let o = 0;
  const take = <T>(make: (b: ArrayBuffer, o: number, n: number) => T, bytes: number, n: number): T => {
    const v = make(buffer, o, n);
    o += bytes * n;
    return v;
  };
  const position = take((b, off, n) => new Float32Array(b, off, n), 4, count * 3);
  const u8 = (b: ArrayBuffer, off: number, n: number) => new Uint8Array(b, off, n);
  return {
    count,
    position,
    absMag: take(u8, 1, count),
    radius: take(u8, 1, count),
    axis: take(u8, 1, count),
    angle: take(u8, 1, count),
    colour: take(u8, 1, count),
    ebv: take(u8, 1, count),
    flags: take(u8, 1, count),
  };
}

export const galaxyAbsMag = (code: number) => -26 + code / 10;
export const galaxyRadiusKpc = (code: number) => 0.05 * 10 ** (code / 60);

/** A named galaxy or globular cluster (galaxies/index.json). */
export interface NamedGalaxy {
  name: string;
  aka: string[];
  /** Index in local.bin. */
  i: number;
  /** Distance method (index into GalaxyIndex.methods). */
  method: number;
  /** Luminosity distance, Mpc. */
  dist: number;
  /** Heliocentric velocity, km/s. */
  v?: number | null;
  pgc?: number | null;
  /** The galaxy's own distance where the group distance is used instead, Mpc. */
  own?: number;
  kind?: 'globular';
}

export interface GalaxyCluster {
  name: string;
  centre: string;
  i: number;
  dist: number;
  /** Radius, Mpc. */
  radius: number;
  members: number;
}

export interface GalaxyIndex {
  methods: string[];
  local: number;
  deep: number;
  galaxies: number;
  H0: number;
  omegaM: number;
  named: NamedGalaxy[];
  clusters: GalaxyCluster[];
}

export function galaxyPosition(block: GalaxyBlock, i: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = block.position[i * 3];
  out[1] = block.position[i * 3 + 1];
  out[2] = block.position[i * 3 + 2];
  return out;
}

/** Right ascension and declination (degrees) and distance (Mpc) of an ICRS position. */
export function raDecDistance(p: Vec3): [number, number, number] {
  const d = Math.hypot(p[0], p[1], p[2]);
  const ra = ((Math.atan2(p[1], p[0]) * 180) / Math.PI + 360) % 360;
  return [ra, (Math.asin(p[2] / d) * 180) / Math.PI, d];
}

/** A disc galaxy's axes in ICRS: the normal (toward Earth's side) and the major axis. */
export function discAxes(b: GalaxyBlock, i: number): { normal: Vec3; major: Vec3; cosI: number } {
  const { s, east, north } = skyBasis(galaxyPosition(b, i));
  const pa = (b.angle[i] * Math.PI) / 256;
  const major: Vec3 = [0, 1, 2].map((k) => Math.cos(pa) * north[k] + Math.sin(pa) * east[k]) as Vec3;
  const minor: Vec3 = [0, 1, 2].map((k) => -Math.sin(pa) * north[k] + Math.cos(pa) * east[k]) as Vec3;
  const q = b.axis[i] / 255;
  const cosI = Math.sqrt(Math.min(1, Math.max(0, (q * q - 0.04) / 0.96)));
  const sinI = Math.sqrt(1 - cosI * cosI);
  return { normal: [0, 1, 2].map((k) => -cosI * s[k] + sinI * minor[k]) as Vec3, major, cosI };
}

/** The sky at a position as seen from the Sun: the direction to it, east and north. */
export function skyBasis(p: Vec3): { s: Vec3; east: Vec3; north: Vec3 } {
  const s = unit(p);
  const east = unit([-s[1] + 1e-12, s[0], 0]);
  return { s, east, north: cross(s, east) };
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Flat Lambda-CDM (with radiation): redshift for a comoving distance, and the light's travel time. */
export class Cosmology {
  private readonly z: Float64Array;
  private readonly dc: Float64Array;
  private readonly lookback: Float64Array;

  constructor(readonly H0: number, readonly omegaM: number) {
    const n = 6001;
    this.z = new Float64Array(n);
    this.dc = new Float64Array(n);
    this.lookback = new Float64Array(n);
    // Radiation (photons and neutrinos, 4.15e-5 / h^2) matters only near the CMB.
    const omegaR = 4.15e-5 / (H0 / 100) ** 2;
    const e = (z: number) => Math.sqrt(omegaM * (1 + z) ** 3 + omegaR * (1 + z) ** 4 + 1 - omegaM - omegaR);
    // Hubble time in years.
    const tH = (977.792 / H0) * 1e9;
    for (let k = 1; k < n; k++) {
      const z0 = ((k - 1) / (n - 1)) * 1100, z1 = (k / (n - 1)) * 1100;
      // Finer steps at low z: integrate in log(1 + z).
      this.z[k] = z1;
      const steps = 8;
      let dc = 0, lb = 0;
      for (let s = 0; s < steps; s++) {
        const za = z0 + ((z1 - z0) * (s + 0.5)) / steps;
        dc += (1 / e(za)) * ((z1 - z0) / steps);
        lb += (1 / ((1 + za) * e(za))) * ((z1 - z0) / steps);
      }
      this.dc[k] = this.dc[k - 1] + (dc * C_KMS) / H0;
      this.lookback[k] = this.lookback[k - 1] + lb * tH;
    }
  }

  private interp(x: number, xs: Float64Array, ys: Float64Array): number {
    let lo = 0, hi = xs.length - 1;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[hi]) return ys[hi];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] > x) hi = mid;
      else lo = mid;
    }
    return ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / (xs[hi] - xs[lo]);
  }

  /** Redshift of an object at a comoving distance (Mpc). */
  redshift(comovingMpc: number): number {
    // Near objects: the table's first step is too coarse; use the Hubble law.
    if (comovingMpc < 50) return (comovingMpc * this.H0) / C_KMS;
    return this.interp(comovingMpc, this.dc, this.z);
  }

  /** Years the light from a comoving distance (Mpc) has travelled. */
  lightTravelYears(comovingMpc: number): number {
    if (comovingMpc < 50) return comovingMpc * 3.261563777e6;
    return this.interp(this.redshift(comovingMpc), this.z, this.lookback);
  }

  /** Comoving distance (Mpc) of the CMB's last-scattering surface (z = 1090). */
  get lastScattering(): number {
    return this.interp(1090, this.z, this.dc);
  }
}
