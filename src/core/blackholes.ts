import type { Vec3 } from './ephemeris';

/** GM/c^2 of the Sun, km. */
export const SUN_GM_KM = 1.476625;
const DEG = Math.PI / 180;
const AU_KM = 149597870.7;
const RSUN_KM = 695700;
const JD_J2000 = 2451545.0;

/**
 * A Keplerian orbit on the sky, in the visual-binary convention: Omega is the position
 * angle of the ascending node (from north through east), omega the argument of
 * periastron of the body being placed, i > 90 deg runs clockwise on the sky.
 */
export interface SkyOrbit {
  /** Semi-major axis of the relative orbit, AU. */
  a: number;
  e: number;
  i: number;
  Omega: number;
  omega: number;
  /** Time of periastron, Julian date. */
  tp: number;
  /** Period, days. */
  period: number;
}

export interface Companion {
  name: string;
  mass: number;
  teff: number;
  /** Radius, solar radii. */
  radius: number;
  /** Absolute V magnitude. */
  absMag: number;
  orbit: SkyOrbit;
  source: string;
}

export type Flow = 'hot' | 'thin' | 'none';

export interface BlackHole {
  name: string;
  aliases: string[];
  /** Mass, solar masses. */
  mass: number;
  massSource: string;
  /** ICRS direction and distance (pc) from the Solar System barycentre. */
  ra: number;
  dec: number;
  dist: number;
  distSource: string;
  /** Dimensionless spin, and whether it is measured. */
  spin: number;
  spinSource: string;
  /** Spin axis (ICRS unit vector). */
  axis: Vec3;
  axisSource: string;
  flow: Flow;
  /** Thin disc: luminosity as a fraction of Eddington, and the outer radius in M. */
  eddington?: number;
  discOuter?: number;
  companion?: Companion;
  /** Event Horizon Telescope ring diameter and 1-sigma error, microarcseconds. */
  eht?: { ring: number; error: number; source: string; image: string; credit: string };
  summary: string;
}

/** Unit vectors toward (ra, dec), and north and east on the sky there. */
export function skyBasis(ra: number, dec: number): { n: Vec3; north: Vec3; east: Vec3 } {
  const a = ra * DEG, d = dec * DEG;
  return {
    n: [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)],
    north: [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)],
    east: [-Math.sin(a), Math.cos(a), 0],
  };
}

/** A direction tilted `incl` degrees from the line of sight (away from Earth) toward position angle `pa`. */
function tilted(ra: number, dec: number, incl: number, pa: number): Vec3 {
  const { n, north, east } = skyBasis(ra, dec);
  const c = Math.cos(incl * DEG), s = Math.sin(incl * DEG);
  const cp = Math.cos(pa * DEG), sp = Math.sin(pa * DEG);
  return [0, 1, 2].map((k) => c * n[k] + s * (cp * north[k] + sp * east[k])) as Vec3;
}

/** Position on an orbit (ICRS offset, AU) at Julian date `jd`, around a body at (ra, dec). */
export function orbitOffset(o: SkyOrbit, ra: number, dec: number, jd: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const M = (2 * Math.PI * (jd - o.tp)) / o.period;
  let E = M;
  for (let k = 0; k < 30; k++) {
    const dE = (E - o.e * Math.sin(E) - M) / (1 - o.e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-13) break;
  }
  const nu = 2 * Math.atan2(Math.sqrt(1 + o.e) * Math.sin(E / 2), Math.sqrt(1 - o.e) * Math.cos(E / 2));
  return orbitAt(o, ra, dec, nu, o.a * (1 - o.e * Math.cos(E)), out);
}

function orbitAt(o: SkyOrbit, ra: number, dec: number, nu: number, r: number, out: Vec3): Vec3 {
  const u = o.omega * DEG + nu, W = o.Omega * DEG, i = o.i * DEG;
  // Thiele-Innes: X north, Y east on the sky, Z along the line of sight, away from Earth.
  const X = r * (Math.cos(W) * Math.cos(u) - Math.sin(W) * Math.sin(u) * Math.cos(i));
  const Y = r * (Math.sin(W) * Math.cos(u) + Math.cos(W) * Math.sin(u) * Math.cos(i));
  const Z = r * Math.sin(u) * Math.sin(i);
  const { n, north, east } = skyBasis(ra, dec);
  for (let k = 0; k < 3; k++) out[k] = X * north[k] + Y * east[k] + Z * n[k];
  return out;
}

/** The orbit's angular momentum direction (ICRS unit vector). */
export function orbitNormal(o: SkyOrbit, ra: number, dec: number): Vec3 {
  const p = orbitAt({ ...o, omega: 0 }, ra, dec, 0, 1, [0, 0, 0]);
  const q = orbitAt({ ...o, omega: 0 }, ra, dec, Math.PI / 2, 1, [0, 0, 0]);
  const c: Vec3 = [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const l = Math.hypot(c[0], c[1], c[2]);
  return [c[0] / l, c[1] / l, c[2] / l];
}

/** Julian date (TDB) from seconds past J2000 TDB. */
export const julianDate = (tdb: number) => JD_J2000 + tdb / 86400;

// ---- the catalogue ---------------------------------------------------------------

const CYG = { ra: 299.59029908, dec: 35.201584843 };
const CYG_ORBIT: SkyOrbit = {
  // Circular (e = 0.019). The O star is nearest Earth (u = 270 deg) at its inferior
  // conjunction, HJD 2452872.788 (Gies et al. 2008).
  a: 0.244, e: 0, i: 152.9, Omega: 64.1, omega: 0, period: 5.599829, tp: 2452872.788 - 5.599829 * 0.75,
};
const BH3 = { ra: 294.8278502301, dec: 14.9309190869 };
const BH3_ORBIT: SkyOrbit = { a: 16.55, e: 0.7291, i: 110.58, Omega: 136.236, omega: 77.34, tp: 2458177.39, period: 4253.1 };
const BH1 = { ra: 262.17120816, dec: -0.58109202 };
const BH1_ORBIT: SkyOrbit = { a: 1.4, e: 0.451, i: 126.6, Omega: 97.8, omega: 12.8, tp: 2457387.9, period: 185.59 };
const BH2 = { ra: 207.56971624, dec: -59.239005 };
const BH2_ORBIT: SkyOrbit = { a: 4.96, e: 0.5176, i: 34.87, Omega: 266.9, omega: 130.9, tp: 2457438.3, period: 1276.7 };
const SGR = { ra: 266.41683708, dec: -29.00781056 };
const M87 = { ra: 187.70593076725, dec: 12.391123246083334 };

/** Absolute V magnitude of a star from its radius (Rsun) and temperature, via the bolometric correction. */
function absV(radius: number, teff: number, bc: number): number {
  return 4.74 - 2.5 * Math.log10(radius * radius * (teff / 5772) ** 4) - bc;
}

export const BLACK_HOLES: BlackHole[] = [
  {
    name: 'Sgr A*', aliases: ['Sagittarius A*', 'Galactic Centre', 'Galactic Center', 'Sgr A'],
    mass: 4.297e6, massSource: 'GRAVITY 2022, from the orbits of S2 and three other stars',
    ...SGR, dist: 8277, distSource: 'GRAVITY 2022',
    spin: 0.9, spinSource: 'assumed (EHT 2022 favours 0.5 to 0.94)',
    axis: tilted(SGR.ra, SGR.dec, 160, 120), axisSource: 'assumed: 20° from our line of sight, pointing away (EHT 2022 favours a near face-on view)',
    flow: 'hot',
    eht: { ring: 51.8, error: 2.3, source: 'EHT 2022, Paper I', image: 'sgra-eht.jpg', credit: 'EHT Collaboration (CC BY 4.0)' },
    summary: 'Supermassive black hole at the centre of the Milky Way',
  },
  {
    name: 'M87*', aliases: ['M87 black hole', 'Pōwehi', 'Powehi'],
    // Stellar dynamics: (6.6 +- 0.4) x 10^9 at 17.9 Mpc (Gebhardt et al. 2011); a dynamical
    // mass scales with the assumed distance, so it is scaled to the galaxy's distance here.
    mass: 6.6e9 * (16.2 / 17.9), massSource: 'stellar orbits, Gebhardt et al. 2011 (6.6 billion at 17.9 Mpc, scaled to 16.2 Mpc)',
    ...M87, dist: 16.2e6, distSource: 'Cosmicflows-4 Virgo Cluster distance (the galaxy alone: 16.9 Mpc)',
    spin: 0.9, spinSource: 'assumed (EHT 2019 favours a spinning hole)',
    // The approaching jet points to PA 288 deg at 17 deg from our line of sight; the spin
    // points away from us (EHT 2019 Paper V), so along the counter-jet.
    axis: tilted(M87.ra, M87.dec, 163, 108), axisSource: 'jet axis (Walker et al. 2018): 17° from our line of sight, pointing away (EHT 2019)',
    flow: 'hot',
    eht: { ring: 42, error: 3, source: 'EHT 2019, Paper I', image: 'm87-eht.jpg', credit: 'EHT Collaboration (CC BY 4.0)' },
    summary: 'Supermassive black hole at the heart of the giant elliptical galaxy M87',
  },
  {
    name: 'Gaia BH3', aliases: ['Gaia DR3 4318465066420528000', 'BH3'],
    mass: 32.7, massSource: 'Gaia astrometry and radial velocities (Gaia Collaboration, Panuzzo et al. 2024)',
    ...BH3, dist: 590, distSource: 'Gaia parallax',
    spin: 0, spinSource: 'unknown (drawn without spin)', axis: orbitNormal(BH3_ORBIT, BH3.ra, BH3.dec), axisSource: 'along the orbit\'s axis',
    flow: 'none',
    companion: {
      name: 'Gaia BH3 companion', mass: 0.76, teff: 5212, radius: 4.936, absMag: absV(4.936, 5212, -0.23),
      orbit: BH3_ORBIT, source: 'very metal-poor giant, 11.6 year orbit (Panuzzo et al. 2024)',
    },
    summary: 'The most massive stellar black hole known in the Milky Way; dormant',
  },
  {
    name: 'Gaia BH1', aliases: ['Gaia DR3 4373465352415301632', 'BH1'],
    mass: 9.62, massSource: 'Gaia astrometry and radial velocities (El-Badry et al. 2023)',
    ...BH1, dist: 480, distSource: 'Gaia parallax',
    spin: 0, spinSource: 'unknown (drawn without spin)', axis: orbitNormal(BH1_ORBIT, BH1.ra, BH1.dec), axisSource: 'along the orbit\'s axis',
    flow: 'none',
    companion: {
      name: 'Gaia BH1 companion', mass: 0.93, teff: 5850, radius: 0.99, absMag: absV(0.99, 5850, -0.06),
      orbit: BH1_ORBIT, source: 'Sun-like star, 186 day orbit (El-Badry et al. 2023)',
    },
    summary: 'The nearest known black hole; dormant',
  },
  {
    name: 'Gaia BH2', aliases: ['Gaia DR3 5870569352746779008', 'BH2'],
    mass: 8.94, massSource: 'Gaia astrometry and radial velocities (El-Badry et al. 2023)',
    ...BH2, dist: 1160, distSource: 'Gaia parallax',
    spin: 0, spinSource: 'unknown (drawn without spin)', axis: orbitNormal(BH2_ORBIT, BH2.ra, BH2.dec), axisSource: 'along the orbit\'s axis',
    flow: 'none',
    companion: {
      name: 'Gaia BH2 companion', mass: 1.07, teff: 4604, radius: 7.77, absMag: absV(7.77, 4604, -0.45),
      orbit: BH2_ORBIT, source: 'red giant, 3.5 year orbit (El-Badry et al. 2023)',
    },
    summary: 'A dormant black hole with a red giant companion',
  },
  {
    name: 'Cygnus X-1', aliases: ['Cyg X-1', 'V1357 Cyg', 'HDE 226868 black hole'],
    mass: 21.2, massSource: 'VLBA orbit and optical spectra (Miller-Jones et al. 2021)',
    ...CYG, dist: 2220, distSource: 'VLBA parallax (Miller-Jones et al. 2021)',
    spin: 0.998, spinSource: 'above 0.9985 from X-ray spectra (Zhao et al. 2021); drawn at 0.998',
    axis: orbitNormal(CYG_ORBIT, CYG.ra, CYG.dec), axisSource: 'disc and spin assumed aligned with the orbit (i = 27.5°)',
    flow: 'thin', eddington: 0.02, discOuter: 2e5,
    companion: {
      name: 'HDE 226868', mass: 40.6, teff: 31138, radius: 22.3, absMag: absV(22.3, 31138, -3.0),
      orbit: CYG_ORBIT, source: 'O9.7 supergiant feeding the black hole, 5.6 day orbit (Miller-Jones et al. 2021)',
    },
    summary: 'The first black hole discovered (1964), fed by a blue supergiant',
  },
];

/** Gravitational radius GM/c^2, km. */
export const gravRadius = (bh: BlackHole) => bh.mass * SUN_GM_KM;

/** Barycentric ICRS position, pc. */
export function blackHolePc(bh: BlackHole, out: Vec3 = [0, 0, 0]): Vec3 {
  const { n } = skyBasis(bh.ra, bh.dec);
  for (let k = 0; k < 3; k++) out[k] = n[k] * bh.dist;
  return out;
}

/** Companion position relative to the black hole (ICRS, km) at Julian date `jd`. */
export function companionOffsetKm(bh: BlackHole, jd: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const c = bh.companion!;
  orbitOffset(c.orbit, bh.ra, bh.dec, jd, out);
  for (let k = 0; k < 3; k++) out[k] *= AU_KM;
  return out;
}

export const companionRadiusKm = (c: Companion) => c.radius * RSUN_KM;

/**
 * Angular diameter (microarcseconds) of the shadow's edge (the critical curve) from
 * Earth, given its size in units of M.
 */
export function microarcsec(bh: BlackHole, sizeM: number): number {
  const rad = (sizeM * gravRadius(bh)) / (bh.dist * 3.0856775814913673e13);
  return rad * 206264.80624709636e6;
}

/** Inclination of the spin axis to our line of sight (radians, 0 = pointing at us). */
export function viewInclination(bh: BlackHole): number {
  const { n } = skyBasis(bh.ra, bh.dec);
  return Math.acos(-(n[0] * bh.axis[0] + n[1] * bh.axis[1] + n[2] * bh.axis[2]));
}

/** Thin-disc temperature scale T* (K): T(r) = T* (F(r) / F-unit)^(1/4), see kerr.discFlux. */
export function discTemperatureScale(bh: BlackHole, efficiency: number): number {
  const G = 6.6743e-11, c = 299792458, sigmaSB = 5.670374419e-8, MSUN = 1.98892e30;
  const M = bh.mass * MSUN;
  const lEdd = 1.2566e31 * bh.mass; // W, for ionised hydrogen
  const mdot = ((bh.eddington ?? 0) * lEdd) / (efficiency * c * c);
  // F_phys = (c^6 / (G^2 M^2)) * Mdot * f, with f the dimensionless discFlux at Mdot = 1.
  const fluxUnit = (c ** 6 / (G * G * M * M)) * mdot;
  return (fluxUnit / sigmaSB) ** 0.25;
}
