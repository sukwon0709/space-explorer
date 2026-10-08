import type { Vec3 } from './ephemeris';
import { skyBasis } from './blackholes';

/**
 * Core-collapse supernovae: how bright, how hot and how big, day by day.
 *
 * The light is the energy the explosion leaves in the ejecta, diffusing out:
 * - the decay of radioactive nickel-56 to cobalt-56 to iron (half-lives 6.075 and 77.24
 *   days), then cobalt-57 (271.7 days) and titanium-44 (58.9 years). Their gamma rays heat
 *   the ejecta, but as the ejecta thin out more of them escape: the fraction kept is
 *   1 - exp(-(T0/t)^2) (Clocchiatti and Wheeler 1997); positrons stay.
 * - that heat leaks out by diffusion, Arnett's (1982) one-zone model: radiation energy E
 *   in homologous ejecta, dE/dt = S - L - E/t (adiabatic losses), L = E/t_d, with the
 *   diffusion time t_d = tau_m^2 / 2t. When the hydrogen recombines the opacity drops and
 *   what is stored comes out (Arnett and Fu 1989): t_d shrinks by exp(-(t - t_rec)/w).
 * - the shock's own heat in the outer envelope, cooling over the first weeks.
 *
 * For SN 1987A the free parameters are fitted to its measured bolometric light curve
 * (Suntzeff et al. 1991): the nickel mass comes out at 0.069 solar masses, as the
 * gamma-ray lines measured (0.071 +- 0.003, Seitenzahl et al. 2014).
 */

export const DAY = 86400;
const YEAR_DAYS = 365.25;
const MSUN_G = 1.98847e33;
const AMU_G = 1.66053907e-24;
const MEV_ERG = 1.602176634e-6;
export const LSUN_ERG = 3.828e33;
const AU_KM = 149597870.7;
const C_KMS = 299792.458;

export const TAU_NI = 6.075 / Math.LN2;
export const TAU_CO = 77.236 / Math.LN2;
const TAU_57 = 271.74 / Math.LN2;
const TAU_44 = (58.9 * YEAR_DAYS) / Math.LN2;
/** Energy released per gram-second by fresh Ni-56 and Co-56 (Nadyozhin 1994), per solar mass. */
const EPS_NI = 6.45e43;
const EPS_CO = 1.45e43;
/** Fraction of Co-56 decay energy carried by positrons (which stay in the ejecta). */
const CO_POSITRON = 0.032;

export interface LightCurveParams {
  /** Radioactive masses, solar masses. */
  ni56: number;
  co57: number;
  ti44: number;
  /** Diffusion time scale (days) and gamma-ray trapping time T0 (days). */
  tauM: number;
  t0: number;
  /** Recombination: when the opacity starts to fall (days), its e-folding (days) and floor. */
  tRec: number;
  wRec: number;
  floorRec: number;
  /** The cooling envelope: luminosity (erg/s) and decay time (days); a plateau ends at tPlateau. */
  lEnv: number;
  tEnv: number;
  tPlateau?: number;
  wPlateau?: number;
  /** The first days' flash (shock cooling of the outermost layers): erg/s and days. */
  lFlash: number;
  tFlash: number;
  /** Photosphere expansion speed v0 (t / 1 d)^-alpha, km/s. */
  v0: number;
  alpha: number;
  /** Hydrogen recombination temperature the photosphere settles at (K). */
  tPhot: number;
}

/** Radioactive heating deposited in the ejecta, erg/s, `day` days after core collapse. */
export function deposition(p: LightCurveParams, day: number): number {
  const t = Math.max(day, 1e-3);
  const fg = 1 - Math.exp(-((p.t0 / t) ** 2));
  const ni = p.ni56 * EPS_NI * Math.exp(-t / TAU_NI);
  const co = p.ni56 * EPS_CO * Math.exp(-t / TAU_CO);
  // Co-57: 122 and 136 keV gamma rays (trapped longer: their cross-section is higher) and
  // 18 keV of X-rays and Auger electrons per decay.
  const n57 = (p.co57 * MSUN_G) / (56.936 * AMU_G) / (TAU_57 * DAY);
  const f57 = 1 - Math.exp(-(((1.7 * p.t0) / t) ** 2));
  const c57 = n57 * Math.exp(-t / TAU_57) * MEV_ERG * (0.018 + 0.124 * f57);
  // Ti-44 -> Sc-44 -> Ca-44: the positrons' 0.56 MeV per decay stays; the gamma rays escape.
  const n44 = (p.ti44 * MSUN_G) / (43.96 * AMU_G) / (TAU_44 * DAY);
  const ti = n44 * Math.exp(-t / TAU_44) * MEV_ERG * 0.561;
  return ni * fg + co * ((1 - CO_POSITRON) * fg + CO_POSITRON) + c57 + ti;
}

/** The opacity, relative to its value before recombination. */
function opacity(p: LightCurveParams, t: number): number {
  return t < p.tRec ? 1 : Math.max(p.floorRec, Math.exp(-(t - p.tRec) / p.wRec));
}

function envelope(p: LightCurveParams, t: number): number {
  const env = p.lEnv * Math.exp(-t / p.tEnv);
  const plateau = p.tPlateau === undefined ? 1 : 1 / (1 + Math.exp(Math.min(50, (t - p.tPlateau) / (p.wPlateau ?? 8))));
  return env * plateau + p.lFlash * Math.exp(-t / p.tFlash);
}

/** A light curve, integrated once on a log-spaced grid of days. */
export class LightCurve {
  readonly params: LightCurveParams;
  private readonly days: Float64Array;
  private readonly logL: Float64Array;

  constructor(p: LightCurveParams, lastDay = 120 * YEAR_DAYS) {
    this.params = p;
    const n = 1400;
    const first = 0.01;
    this.days = new Float64Array(n);
    this.logL = new Float64Array(n);
    let E = 0;
    let t = first;
    for (let i = 0; i < n; i++) {
      const target = first * (lastDay / first) ** (i / (n - 1));
      // Implicitly (the diffusion is stiff once the ejecta turn transparent).
      while (t < target) {
        const h = Math.min(0.02 * Math.max(t, 0.5), target - t);
        const td = ((p.tauM * p.tauM) / (2 * t)) * opacity(p, t);
        E = (E + h * deposition(p, t)) / (1 + h / td + h / t);
        t += h;
      }
      const td = ((p.tauM * p.tauM) / (2 * t)) * opacity(p, t);
      this.days[i] = target;
      this.logL[i] = Math.log10(Math.max(E / td + envelope(p, t), 1));
    }
  }

  /** Bolometric luminosity, erg/s. */
  luminosity(day: number): number {
    if (day <= this.days[0]) return day < 0 ? 0 : 10 ** this.logL[0];
    const n = this.days.length;
    if (day >= this.days[n - 1]) return 10 ** this.logL[n - 1] * Math.exp(-(day - this.days[n - 1]) / TAU_44);
    // Log-spaced grid: the index from the logarithm.
    const x = (Math.log(day / this.days[0]) / Math.log(this.days[n - 1] / this.days[0])) * (n - 1);
    const i = Math.min(n - 2, Math.floor(x));
    const f = x - i;
    return 10 ** (this.logL[i] * (1 - f) + this.logL[i + 1] * f);
  }

  /**
   * The photosphere: radius (km) and temperature (K) where the ejecta are opaque, and how
   * opaque they still are (1 while the photosphere lasts, falling to 0 as they turn nebular).
   * Its speed follows the ejecta's density falling outward (v0 (t/1 d)^-alpha), and its
   * temperature is set by L = 4 pi R^2 sigma T^4, but not below where hydrogen recombines.
   */
  photosphere(day: number): { radius: number; teff: number; opaque: number } {
    const p = this.params;
    const t = Math.max(day, 1e-3);
    const v = p.v0 * Math.max(t, 0.05) ** -p.alpha;
    // The photosphere outlasts the start of recombination: it recedes into the ejecta and
    // is gone a few e-foldings later (SN 1987A's spectrum turned nebular around day 150-200).
    const opaque = 1 - smooth(p.tRec + 2 * p.wRec, p.tRec + 6 * p.wRec, t);
    const radius = v * t * DAY;
    const L = this.luminosity(day);
    const sigma = 5.670374e-5;
    const rCm = radius * 1e5;
    const teff = Math.max(p.tPhot, (L / (4 * Math.PI * sigma * rCm * rCm)) ** 0.25);
    return { radius, teff, opaque };
  }

  /**
   * V-band luminosity in Suns. While the photosphere lasts, a blackbody at its temperature;
   * in the nebular phase most of the light is in emission lines and (after day 450, when
   * dust formed) the infrared: the V share falls to a third, then a tenth of a 5000 K
   * blackbody's (an estimate from the colours measured then).
   */
  luminosityV(day: number): number {
    const ph = this.photosphere(day);
    const bb = vFraction(ph.teff) / vFraction(5772);
    const neb = (vFraction(5000) / vFraction(5772)) * (0.33 - 0.23 * smooth(400, 700, day));
    const share = ph.opaque * bb + (1 - ph.opaque) * neb;
    return (this.luminosity(day) / LSUN_ERG) * share;
  }

  /** Absolute V magnitude. */
  absV(day: number): number {
    return 4.83 - 2.5 * Math.log10(Math.max(this.luminosityV(day), 1e-12));
  }
}

/** A blackbody's share of its light near 545 nm (relative). */
export function vFraction(t: number): number {
  const x = 26400 / t;
  return x ** 4 / (Math.exp(Math.min(x, 700)) - 1) / 1e3;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ---- the explosions ---------------------------------------------------------------------

export interface Ring {
  /** Radius (km) and the offset of its centre along the equatorial ring's normal (km). */
  radius: number;
  offset: number;
  /** Relative brightness of its glow after the flash. */
  glow: number;
}

export interface SupernovaSpec {
  key: string;
  name: string;
  aliases: string[];
  /** ICRS position (degrees) and distance (pc). */
  ra: number;
  dec: number;
  distancePc: number;
  /** Extinction to Earth, magnitudes. */
  av: number;
  /** Core collapse as Earth saw it (the neutrino burst), UTC ms; undefined: set when started. */
  collapse?: number;
  progenitor: { name: string; radiusSun: number; teff: number; absV: number };
  /** Ejecta: mass (solar masses) and kinetic energy (erg); the speed of the bulk of the core's metals (km/s). */
  ejecta: { mass: number; energy: number; coreSpeed: number };
  light: LightCurveParams;
  summary: string;
  /** The equatorial ring: angular radius (arcsec), inclination and position angle of its major axis (degrees). */
  ring?: { arcsec: number; incl: number; pa: number; outer: { radius: number; offset: number } };
}

/**
 * SN 1987A in the Large Magellanic Cloud, the nearest supernova seen since Kepler's.
 * Light-curve parameters: fitted to the bolometric light curve (Suntzeff et al. 1991),
 * as pipeline/../tests/cosmic.test.ts checks. Co-57 and Ti-44 masses: Seitenzahl et al.
 * 2014, Boggs et al. 2015 (NuSTAR). Distance: the LMC's, 49.59 kpc (Pietrzynski et al.
 * 2019). Ring: 0.808" (Panagia 2003), inclined 43 degrees (Tziamtzis et al. 2011), major
 * axis at PA 81 degrees with the north side nearer us. The outer rings: about 3 ring radii
 * from the supernova (Tziamtzis et al. 2011), drawn parallel to the inner one.
 */
export const SN1987A: SupernovaSpec = {
  key: 'sn1987a',
  name: 'SN 1987A',
  aliases: ['sn 1987a', 'supernova 1987a', '1987a', 'sanduleak -69 202', 'sk -69 202'],
  ra: 83.86675, dec: -69.269742,
  distancePc: 49590,
  av: 0.5,
  collapse: Date.UTC(1987, 1, 23, 7, 35, 35),
  progenitor: { name: 'Sanduleak -69° 202', radiusSun: 40, teff: 16000, absV: 12.24 - 18.48 - 0.5 },
  ejecta: { mass: 14, energy: 1.1e51, coreSpeed: 2500 },
  light: {
    ni56: 0.069, co57: 0.0041, ti44: 1.5e-4,
    tauM: 60.25, t0: 520.1, tRec: 64.14, wRec: 24.93, floorRec: 0.1141,
    lEnv: 2.006e41, tEnv: 10.86, lFlash: 1.2e42, tFlash: 1.3,
    v0: 11000, alpha: 0.39, tPhot: 4900,
  },
  summary: 'A blue supergiant in the Large Magellanic Cloud collapsed on 23 Feb 1987; the nearest supernova since 1604',
  ring: { arcsec: 0.808, incl: 43, pa: 81, outer: { radius: 2.1, offset: 2.1 } },
};

/**
 * Betelgeuse, if it exploded now: a red supergiant of 764 solar radii (Joyce et al. 2020)
 * becomes a type II-P supernova. Computed, not observed: the plateau's luminosity and
 * length follow Popov's (1993) formulas for its radius, 14 solar masses of ejecta and 1e51
 * erg; 0.05 solar masses of nickel, typical of such supernovae.
 */
export const BETELGEUSE_SN: SupernovaSpec = {
  key: 'betelgeuse',
  name: 'Betelgeuse supernova',
  aliases: ['betelgeuse supernova', 'betelgeuse explodes', 'betelgeuse sn'],
  ra: 88.7929, dec: 7.4071,
  distancePc: 168,
  av: 0.1,
  progenitor: { name: 'Betelgeuse', radiusSun: 764, teff: 3600, absV: -5.5 },
  ejecta: { mass: 14, energy: 1e51, coreSpeed: 2000 },
  light: {
    ni56: 0.05, co57: 0.0015, ti44: 1e-4,
    tauM: 60, t0: 450, tRec: 126, wRec: 12, floorRec: 0.1,
    lEnv: popovPlateau(764, 14, 1).luminosity, tEnv: 1e9, tPlateau: popovPlateau(764, 14, 1).days, wPlateau: 6,
    lFlash: 8e42, tFlash: 3,
    v0: 9000, alpha: 0.3, tPhot: 5000,
  },
  summary: 'What if Betelgeuse exploded now? A type II-P supernova computed for its size and mass',
};

/** Popov's (1993) plateau of a type II-P supernova: luminosity (erg/s) and length (days). */
export function popovPlateau(radiusSun: number, massSun: number, energy51: number, kappa = 0.34): { luminosity: number; days: number } {
  const r = radiusSun / 500, m = massSun / 10, k = kappa / 0.34;
  return {
    luminosity: 1.64e42 * r ** (2 / 3) * energy51 ** (5 / 6) * m ** -0.5 * k ** (-1 / 3),
    days: 99 * k ** (1 / 6) * m ** 0.5 * r ** (1 / 6) * energy51 ** (-1 / 6),
  };
}

// ---- the rings around SN 1987A -------------------------------------------------------------

/** The rings' geometry in ICRS, km from the supernova. */
export interface RingGeometry {
  /** Unit vectors: the equatorial ring's normal, and two in its plane (a = major axis). */
  normal: Vec3;
  a: Vec3;
  b: Vec3;
  radius: number;
  rings: Ring[];
}

export function ringGeometry(sn: SupernovaSpec): RingGeometry | undefined {
  if (!sn.ring) return undefined;
  const { n, north, east } = skyBasis(sn.ra, sn.dec);
  const pa = (sn.ring.pa * Math.PI) / 180, inc = (sn.ring.incl * Math.PI) / 180;
  const a: Vec3 = [0, 1, 2].map((k) => Math.cos(pa) * north[k] + Math.sin(pa) * east[k]) as Vec3;
  // The minor axis on the sky, toward the north; the ring's north side is nearer to us
  // (along -n), so the in-plane direction tilts toward Earth by the inclination.
  const minorPa = pa - Math.PI / 2;
  const m: Vec3 = [0, 1, 2].map((k) => Math.cos(minorPa) * north[k] + Math.sin(minorPa) * east[k]) as Vec3;
  const b: Vec3 = [0, 1, 2].map((k) => Math.cos(inc) * m[k] - Math.sin(inc) * n[k]) as Vec3;
  const normal: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const radius = sn.ring.arcsec * sn.distancePc * AU_KM;
  const o = sn.ring.outer;
  return {
    normal, a, b, radius,
    rings: [
      { radius, offset: 0, glow: 1 },
      { radius: radius * o.radius, offset: radius * o.offset, glow: 0.25 },
      { radius: radius * o.radius, offset: -radius * o.offset, glow: 0.2 },
    ],
  };
}

/**
 * Extra light-travel time (days) of light from the supernova reaching the observer via a
 * point p (km from the supernova), compared with the direct light. `observer` is the
 * observer's position relative to the supernova (km); far away it tends to
 * |p| (1 - cos theta) / c.
 */
export function echoDelay(p: Vec3, observer: Vec3): number {
  const r = Math.hypot(p[0], p[1], p[2]);
  const d = Math.hypot(observer[0] - p[0], observer[1] - p[1], observer[2] - p[2]);
  const direct = Math.hypot(observer[0], observer[1], observer[2]);
  return (r + d - direct) / C_KMS / DAY;
}

/** The equatorial ring's nearest and farthest points as seen from far along `toObserver` (unit): their echo delays, days. */
export function ringDelays(g: RingGeometry, toObserver: Vec3): [number, number] {
  let lo = Infinity, hi = -Infinity;
  const far = 1e20;
  const obs: Vec3 = [toObserver[0] * far, toObserver[1] * far, toObserver[2] * far];
  for (let k = 0; k < 720; k++) {
    const phi = (k / 720) * 2 * Math.PI;
    const p: Vec3 = [0, 1, 2].map((c) => g.radius * (Math.cos(phi) * g.a[c] + Math.sin(phi) * g.b[c])) as Vec3;
    const d = echoDelay(p, obs);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return [lo, hi];
}

/**
 * Hot spots: where the supernova's blast wave runs into the ring's inner fingers. The
 * times are those HST saw (as seen from Earth, years): the first spot at PA 29 degrees in
 * 1995 (Sonneborn et al. 1998), the rest of the ring by 2004 (Sugerman et al. 2002); the
 * ring was brightest about 2009 and has faded since (Fransson et al. 2015, Larsson et al.
 * 2019), while new spots light up just outside it. Positions after the first are spread
 * round the ring (not the observed ones).
 */
export interface HotSpot {
  /** Angle round the ring from the major axis (radians), radius as a fraction of the ring's. */
  phi: number;
  r: number;
  /** When Earth saw it light up, years (decimal). */
  on: number;
  strength: number;
}

export function hotSpots(g: RingGeometry, sn: SupernovaSpec): HotSpot[] {
  const spots: HotSpot[] = [];
  // Spot 1 at PA 29 degrees on the sky: find the angle round the ring that appears there.
  const { north, east } = skyBasis(sn.ra, sn.dec);
  let best = 0, bestErr = Infinity;
  for (let k = 0; k < 3600; k++) {
    const phi = (k / 3600) * 2 * Math.PI;
    const p = [0, 1, 2].map((c) => Math.cos(phi) * g.a[c] + Math.sin(phi) * g.b[c]);
    const pa = Math.atan2(p[0] * east[0] + p[1] * east[1] + p[2] * east[2], p[0] * north[0] + p[1] * north[1] + p[2] * north[2]);
    const err = Math.abs(Math.atan2(Math.sin(pa - (29 * Math.PI) / 180), Math.cos(pa - (29 * Math.PI) / 180)));
    if (err < bestErr) { bestErr = err; best = phi; }
  }
  spots.push({ phi: best, r: 0.95, on: 1995.4, strength: 1.4 });
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 1; k < 48; k++) {
    const phi = best + (k / 48) * 2 * Math.PI + (rand() - 0.5) * 0.15;
    spots.push({ phi, r: 0.93 + 0.05 * rand(), on: 1997 + 7 * rand(), strength: 0.6 + 0.8 * rand() });
  }
  // Spots outside the ring, seen from 2013 on.
  for (let k = 0; k < 8; k++) spots.push({ phi: rand() * 2 * Math.PI, r: 1.08 + 0.08 * rand(), on: 2013 + 4 * rand(), strength: 0.35 });
  return spots;
}

/** A hot spot's brightness (relative) `years` after it lit up, as seen by the same observer, at calendar year `year`. */
export function hotSpotLight(sinceOn: number, year: number): number {
  if (sinceOn <= 0) return 0;
  const rise = 1 - Math.exp(-sinceOn / 2.5);
  // The whole ring brightened until about 2009, then faded by about 2.5 times by 2018.
  const fade = year < 2009 ? 1 : Math.exp(-(year - 2009) / 9.8);
  return rise * fade;
}

/** The rings' glow after the ultraviolet flash ionised them: rising promptly, fading as the gas recombines. */
export function flashLight(sinceFlash: number): number {
  if (sinceFlash <= 0) return 0;
  return (1 - Math.exp(-sinceFlash / 30)) * Math.exp(-sinceFlash / 1100);
}

/** Calendar year (decimal) of a UTC time. */
export function decimalYear(utcMs: number): number {
  return 1970 + utcMs / (YEAR_DAYS * DAY * 1000);
}

/** The outer edge of the ejecta (km) `day` days after the explosion: the fastest hydrogen, slowed where it meets the ring. */
export function ejectaRadius(sn: SupernovaSpec, day: number, ringRadius = Infinity): number {
  const vOuter = Math.sqrt((10 / 3) * (sn.ejecta.energy / (sn.ejecta.mass * MSUN_G))) * 1e-5 * 2.5;
  return Math.min(vOuter * day * DAY, ringRadius * 0.98);
}
