import type { Ephemeris, Vec3 } from './ephemeris';
import type { Mat3, Orientation } from './orientation';
import { bodyToGeodetic, WGS84 } from './geodesy';
import { iauIcrfToBody } from './iau';
import { C_KM_S, SUN_ECLIPSE_RADIUS } from './eclipse';

/**
 * Searches for sky events over a TDB range, from the ephemeris alone: solar and lunar
 * eclipses, transits of Mercury and Venus seen from Earth's centre, and transits of
 * Phobos seen from a place on Mars.
 *
 * Directions are barycentric differences with light time applied to the source (the
 * Sun as it was 8.3 minutes earlier, the Moon 1.3 s earlier), as in eclipse.ts; lunar
 * eclipses need the aberrated Sun instead (see geocentric()). Earth's rotation is the
 * orientation file's (IERS UT1 and polar motion), or a precession-nutation model with
 * extrapolated Delta T outside it (before February 1962).
 * Conventions follow NASA's catalogues (Espenak and Meeus) so results compare with them:
 * - Solar eclipses use Besselian geometry: the shadow cones of a Moon of radius
 *   k1 = 0.272488 (penumbra) or k2 = 0.272281 (umbra) Earth radii, lit by a Sun of
 *   959.63" at 1 AU, cut by the fundamental plane through Earth's centre normal to the
 *   shadow axis. Greatest eclipse is the instant the axis passes closest to Earth's
 *   centre; gamma is that distance in Earth radii (negative when the axis passes south).
 * - Lunar eclipses use Danjon's shadow enlargement, as the Five Millennium Canon does:
 *   Earth's radius (and so the Moon's parallax) grows by 1/85 for the opaque lower
 *   atmosphere, less 1/594 for its oblateness at 45 degrees, so the umbral and penumbral
 *   radii are 1.01 Pm -+ Ss + Ps.
 */

const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;
const DAY = 86400;
const EARTH_A = WGS84.a;
/** Moon radius over Earth's equatorial radius: penumbral (mean limb) and umbral (limb valleys). */
const K1 = 0.272488;
const K2 = 0.272281;
/** Lunar eclipses: Earth's shadow enlargement (Danjon) and the Moon's radius over Earth's. */
const DANJON = 1.01;
const MOON_K_LUNAR = 0.272488;
/** Earth's rotation rate, rad per second of UT1. */
const OMEGA_EARTH = 7.2921150e-5;
const SYNODIC_MONTH = 29.530588861 * DAY;
/** A mean new moon (Meeus, Astronomical Algorithms 49.1), TDB seconds past J2000. */
const NEW_MOON_EPOCH = 5.09766 * DAY;
/**
 * Radii (km) of the planets that transit the Sun as seen from Earth: the semidiameters
 * at 1 AU of the Explanatory Supplement that NASA's transit predictions use (Mercury
 * 3.36", Venus 8.41", which takes in Venus's cloud deck; the IAU solid radius would
 * make Venus's ingress 10 s shorter).
 */
const PLANET_RADIUS: Record<number, number> = { 199: 3.36 * ARCSEC * 149597870.7, 299: 8.41 * ARCSEC * 149597870.7 };
/** Phobos: volumetric mean radius (Archinal et al. 2018), km. */
export const PHOBOS_RADIUS = 11.08;

export type SolarType = 'total' | 'annular' | 'hybrid' | 'partial';
export type LunarType = 'total' | 'partial' | 'penumbral';

export interface SolarEclipse {
  type: SolarType;
  /** Greatest eclipse, TDB seconds past J2000. */
  tdb: number;
  gamma: number;
  /** Moon/Sun diameter ratio for central eclipses, else the fraction of the Sun's diameter covered. */
  magnitude: number;
  /** Greatest-eclipse point (degrees): on the central line, or the point of Earth nearest the axis. */
  lat: number;
  lon: number;
  /** The Sun's altitude there, degrees. */
  sunAlt: number;
  /** Whether the shadow axis meets the Earth. */
  central: boolean;
  /** Totality or annularity at the greatest-eclipse point, s (central eclipses). */
  duration?: number;
}

export interface LunarEclipse {
  type: LunarType;
  tdb: number;
  gamma: number;
  umbral: number;
  penumbral: number;
  /** Phase durations, s: penumbral (P1-P4), partial (U1-U4) and total (U2-U3). */
  penumbralDuration: number;
  partialDuration?: number;
  totalDuration?: number;
  /** Where the Moon is in the zenith at greatest eclipse, degrees. */
  lat: number;
  lon: number;
}

export interface Transit {
  body: number;
  /** Greatest transit (closest approach to the Sun's centre), TDB. */
  tdb: number;
  /** Minimum separation of the centres, arcseconds. */
  separation: number;
  /** Contacts I, II, III, IV (TDB), or I and IV when the planet never fits inside the disc. */
  contacts: number[];
  /** Sub-solar point at greatest transit (Earth observer only), degrees. */
  lat?: number;
  lon?: number;
}

export interface SkyEventOptions {
  /**
   * TT - UT1 (s) to adopt for Earth's rotation instead of the one the orientation file
   * implies, for comparison with predictions that assumed it (NASA's catalogues).
   */
  deltaT?: (tdb: number) => number;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: ArrayLike<number>) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
function angleBetween(a: Vec3, b: Vec3): number {
  const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), dot(a, b));
}
/** r = m v (row-major m), or m^T v. */
function mul(m: Mat3, v: ArrayLike<number>, out: Vec3): Vec3 {
  const x = v[0], y = v[1], z = v[2];
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[3] * x + m[4] * y + m[5] * z;
  out[2] = m[6] * x + m[7] * y + m[8] * z;
  return out;
}
function mulT(m: Mat3, v: ArrayLike<number>, out: Vec3): Vec3 {
  const x = v[0], y = v[1], z = v[2];
  out[0] = m[0] * x + m[3] * y + m[6] * z;
  out[1] = m[1] * x + m[4] * y + m[7] * z;
  out[2] = m[2] * x + m[5] * y + m[8] * z;
  return out;
}

/** Minimum of a smooth function near t (Newton on central differences of step h). */
function minimize(f: (t: number) => number, t: number, h: number, maxStep: number): number {
  for (let i = 0; i < 30; i++) {
    const fm = f(t - h), f0 = f(t), fp = f(t + h);
    const curvature = fp - 2 * f0 + fm;
    let step = curvature > 0 ? (-(fp - fm) / 2 / curvature) * h : fp < fm ? maxStep : -maxStep;
    step = Math.max(-maxStep, Math.min(maxStep, step));
    t += step;
    if (Math.abs(step) < 1e-3) break;
  }
  return t;
}

/** Distance from a point outside the ellipse x^2 + (y/b)^2 = 1 to it (Newton on the eccentric anomaly). */
function ellipseDistance(px: number, py: number, b: number): number {
  let t = Math.atan2(py / b, px);
  for (let i = 0; i < 8; i++) {
    const c = Math.cos(t), s = Math.sin(t);
    // f = d/dt of half the squared distance, f' its derivative.
    const f = (c - px) * -s + (b * s - py) * b * c;
    const df = s * s - (c - px) * c + b * b * c * c - (b * s - py) * b * s;
    t -= f / df;
  }
  return Math.hypot(Math.cos(t) - px, b * Math.sin(t) - py);
}

/** Root of f between a and b (f(a) and f(b) of opposite sign), to about a millisecond. */
function bisect(f: (t: number) => number, a: number, b: number): number {
  let fa = f(a);
  while (Math.abs(b - a) > 1e-3) {
    const mid = (a + b) / 2, fm = f(mid);
    if (fm === 0) return mid;
    if (fm < 0 === fa < 0) { a = mid; fa = fm; } else b = mid;
  }
  return (a + b) / 2;
}

/** Root of f going outward from t (where f < 0) in steps of `step` (sign gives the direction), or null. */
function exit(f: (t: number) => number, t: number, step: number, maxSteps: number): number | null {
  for (let i = 0; i < maxSteps; i++) {
    if (f(t + step) >= 0) return bisect(f, t, t + step);
    t += step;
  }
  return null;
}

/**
 * Earth orientation from IAU 1976 precession, the four leading nutation terms and
 * Greenwich apparent sidereal time (IAU 1982) for a given TT - UT1: the ICRF to
 * true-of-date Earth-fixed rotation, good to about 0.3" (10 m on the ground). Stands in
 * for the orientation file outside its range and measures the Delta T it implies.
 */
export function earthModel(tdb: number, deltaT: number, out: Mat3 = new Float64Array(9)): Mat3 {
  const T = tdb / (36525 * DAY);
  const zeta = (2306.2181 + (0.30188 + 0.017998 * T) * T) * T * ARCSEC;
  const z = (2306.2181 + (1.09468 + 0.018203 * T) * T) * T * ARCSEC;
  const theta = (2004.3109 - (0.42665 + 0.041833 * T) * T) * T * ARCSEC;
  const eps0 = (84381.448 - 46.815 * T) * ARCSEC;
  const om = (125.04452 - 1934.136261 * T) * DEG;
  const l = (280.4665 + 36000.7698 * T) * DEG;
  const lm = (218.3165 + 481267.8813 * T) * DEG;
  const dpsi = (-17.2 * Math.sin(om) - 1.32 * Math.sin(2 * l) - 0.23 * Math.sin(2 * lm) + 0.21 * Math.sin(2 * om)) * ARCSEC;
  const deps = (9.2 * Math.cos(om) + 0.57 * Math.cos(2 * l) + 0.1 * Math.cos(2 * lm) - 0.09 * Math.cos(2 * om)) * ARCSEC;
  const eps = eps0 + deps;
  const d = (tdb - deltaT) / DAY;
  const gmst = (280.46061837 + 360.98564736629 * d + (0.000387933 - T / 38710000) * T * T) * DEG;
  const gast = gmst + dpsi * Math.cos(eps);
  // R3(gast) R1(-eps) R3(-dpsi) R1(eps0) R3(-z) R2(theta) R3(-zeta), frame rotations.
  out.set(IDENTITY);
  rot(out, 3, -zeta);
  rot(out, 2, theta);
  rot(out, 3, -z);
  rot(out, 1, eps0);
  rot(out, 3, -dpsi);
  rot(out, 1, -eps);
  rot(out, 3, gast);
  return out;
}

const IDENTITY = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** m = R_axis(a) m, with R the frame rotation about axis 1, 2 or 3. */
function rot(m: Mat3, axis: 1 | 2 | 3, a: number): void {
  const c = Math.cos(a), s = Math.sin(a);
  const i = axis === 1 ? 1 : axis === 2 ? 2 : 0, j = axis === 1 ? 2 : axis === 2 ? 0 : 1;
  for (let k = 0; k < 3; k++) {
    const u = m[i * 3 + k], v = m[j * 3 + k];
    m[i * 3 + k] = c * u + s * v;
    m[j * 3 + k] = -s * u + c * v;
  }
}

/** Delta T (s) of Espenak and Meeus's polynomials, used only to extrapolate the orientation file. */
function deltaTPolynomial(tdb: number): number {
  const y = 2000 + tdb / (365.25 * DAY);
  if (y < 1961) { const t = y - 1950; return 29.07 + 0.407 * t - (t * t) / 233 + (t * t * t) / 2547; }
  if (y < 1986) { const t = y - 1975; return 45.45 + 1.067 * t - (t * t) / 260 - (t * t * t) / 718; }
  if (y < 2005) { const t = y - 2000; return 63.86 + 0.3345 * t - 0.060374 * t * t + 0.0017275 * t ** 3 + 0.000651814 * t ** 4 + 0.00002373599 * t ** 5; }
  if (y < 2050) { const t = y - 2000; return 62.92 + 0.32217 * t + 0.005589 * t * t; }
  return -20 + 32 * ((y - 1820) / 100) ** 2 - 0.5628 * (2150 - y);
}

export class SkyEvents {
  private readonly rotation: Mat3 = new Float64Array(9);
  private readonly model: Mat3 = new Float64Array(9);
  // Geocentric Earth, Sun, Moon and a planet (km), and a scratch vector.
  private readonly earth: Vec3 = [0, 0, 0];
  private readonly sun: Vec3 = [0, 0, 0];
  private readonly moon: Vec3 = [0, 0, 0];
  private readonly planet: Vec3 = [0, 0, 0];
  private readonly v: Vec3 = [0, 0, 0];
  private readonly w: Vec3 = [0, 0, 0];
  // Besselian fundamental frame: unit vectors (ICRF) and elements (Earth radii).
  private readonly xh: Vec3 = [0, 0, 0];
  private readonly yh: Vec3 = [0, 0, 0];
  private readonly kh: Vec3 = [0, 0, 0];
  private bx = 0; private by = 0; private bz = 0;
  private l1 = 0; private l2 = 0; private tanF1 = 0; private tanF2 = 0; private rho1 = 1;

  constructor(
    private readonly ephemeris: Ephemeris,
    private readonly orientation: Orientation,
    private readonly options: SkyEventOptions = {},
  ) {}

  /** Position of `id` seen from `observer` (barycentric, km) at tdb, light time applied. */
  private apparent(id: number, tdb: number, observer: Vec3, out: Vec3): Vec3 {
    const p = this.ephemeris.position(id, tdb, out);
    const tau = Math.hypot(p[0] - observer[0], p[1] - observer[1], p[2] - observer[2]) / C_KM_S;
    this.ephemeris.position(id, tdb - tau, out);
    out[0] -= observer[0]; out[1] -= observer[1]; out[2] -= observer[2];
    return out;
  }

  /** Geocentric Sun and Moon (light time applied) at tdb. */
  private sunMoon(tdb: number): void {
    this.ephemeris.position(399, tdb, this.earth);
    this.apparent(10, tdb, this.earth, this.sun);
    this.apparent(301, tdb, this.earth, this.moon);
  }

  /** TT - UT1 (s) that the orientation file implies at tdb (extrapolated outside it). */
  deltaT(tdb: number): number {
    const o = this.orientation;
    if (tdb < o.start || tdb > o.end) {
      const edge = tdb < o.start ? o.start : o.end;
      return this.deltaT(edge) + deltaTPolynomial(tdb) - deltaTPolynomial(edge);
    }
    // The file and the model differ by a turn about the pole (and polar motion, < 0.5").
    const guess = deltaTPolynomial(tdb);
    const r = o.icrfToBody(399, tdb, this.rotation);
    const m = earthModel(tdb, guess, this.model);
    // Q = r m^T; for a turn by delta about z, Q[0] = cos delta and Q[1] = sin delta.
    const q0 = r[0] * m[0] + r[1] * m[1] + r[2] * m[2];
    const q1 = r[0] * m[3] + r[1] * m[4] + r[2] * m[5];
    return guess - Math.atan2(q1, q0) / OMEGA_EARTH;
  }

  /** ICRF -> Earth-fixed rotation at tdb: the orientation file, or the model outside it. */
  earthRotation(tdb: number, out: Mat3 = this.rotation): Mat3 {
    const o = this.orientation;
    const adopt = this.options.deltaT;
    if (tdb < o.start || tdb > o.end) return earthModel(tdb, adopt ? adopt(tdb) : this.deltaT(tdb), out);
    if (!adopt) return o.icrfToBody(399, tdb, out);
    const shift = OMEGA_EARTH * (this.deltaT(tdb) - adopt(tdb));
    o.icrfToBody(399, tdb, out);
    // Turning the Earth further by `shift` is a frame rotation about its pole: R3(shift) R.
    rot(out, 3, shift);
    return out;
  }

  /**
   * Besselian elements at tdb: the fundamental frame (z toward the Sun along the shadow
   * axis, y toward Earth's north pole), the Moon's x, y, z there, and the radii l1, l2
   * of the penumbral and umbral cones where they cross the plane (l2 < 0: umbra).
   */
  private besselian(tdb: number): void {
    this.sunMoon(tdb);
    const s = this.sun, m = this.moon, k = this.kh, x = this.xh, y = this.yh;
    k[0] = s[0] - m[0]; k[1] = s[1] - m[1]; k[2] = s[2] - m[2];
    const g = norm(k);
    k[0] /= g; k[1] /= g; k[2] /= g;
    // Earth's pole: the third row of the ICRF -> Earth-fixed rotation.
    const r = this.earthRotation(tdb);
    const nx = r[6], ny = r[7], nz = r[8];
    x[0] = ny * k[2] - nz * k[1]; x[1] = nz * k[0] - nx * k[2]; x[2] = nx * k[1] - ny * k[0];
    const xl = norm(x);
    x[0] /= xl; x[1] /= xl; x[2] /= xl;
    y[0] = k[1] * x[2] - k[2] * x[1]; y[1] = k[2] * x[0] - k[0] * x[2]; y[2] = k[0] * x[1] - k[1] * x[0];
    this.bx = dot(m, x) / EARTH_A;
    this.by = dot(m, y) / EARTH_A;
    this.bz = dot(m, k) / EARTH_A;
    const sinF1 = (SUN_ECLIPSE_RADIUS + K1 * EARTH_A) / g;
    const sinF2 = (SUN_ECLIPSE_RADIUS - K2 * EARTH_A) / g;
    const cosF1 = Math.sqrt(1 - sinF1 * sinF1), cosF2 = Math.sqrt(1 - sinF2 * sinF2);
    this.tanF1 = sinF1 / cosF1;
    this.tanF2 = sinF2 / cosF2;
    this.l1 = this.bz * this.tanF1 + K1 / cosF1;
    this.l2 = this.bz * this.tanF2 - K2 / cosF2;
    // Earth's outline seen along the axis is an ellipse with semi-minor axis rho1 (in y).
    const sinD = k[0] * nx + k[1] * ny + k[2] * nz;
    this.rho1 = Math.sqrt(1 - (1 - (WGS84.b * WGS84.b) / (EARTH_A * EARTH_A)) * (1 - sinD * sinD));
  }

  /** Squared distance of the shadow axis from Earth's centre, Earth radii. */
  private readonly axisDistance2 = (tdb: number) => {
    this.besselian(tdb);
    return this.bx * this.bx + this.by * this.by;
  };

  /** Positive where the axis misses the Earth's ellipsoid, negative where it hits. */
  private readonly axisMiss = (tdb: number) => {
    this.besselian(tdb);
    const yy = this.by / this.rho1;
    return this.bx * this.bx + yy * yy - 1;
  };

  /** Every solar eclipse with greatest eclipse in [start, end] (TDB). */
  solarEclipses(start: number, end: number): SolarEclipse[] {
    const out: SolarEclipse[] = [];
    const eph = this.ephemeris;
    for (let k = Math.floor((start - NEW_MOON_EPOCH) / SYNODIC_MONTH) - 1; ; k++) {
      const guess = NEW_MOON_EPOCH + k * SYNODIC_MONTH;
      if (guess > end + 2 * DAY) break;
      // True syzygy is within 15 hours of the mean one.
      if (guess - 2 * DAY < eph.start || guess + 2 * DAY > eph.end) continue;
      const tdb = minimize(this.axisDistance2, guess, 60, 6 * 3600);
      // The penumbra is at most 0.58 Earth radii wide where it passes the Earth.
      if (tdb < start || tdb > end || this.axisDistance2(tdb) > 1.6 * 1.6) continue;
      const e = this.solarAt(tdb);
      if (e) out.push(e);
    }
    return out;
  }

  /** Circumstances of greatest eclipse at tdb (the axis's closest approach), or null if none. */
  private solarAt(tdb: number): SolarEclipse | null {
    this.besselian(tdb);
    const x = this.bx, y = this.by;
    const gamma = Math.sign(y) * Math.hypot(x, y);
    const r = this.earthRotation(tdb, new Float64Array(9));
    const k: Vec3 = [...this.kh], xh: Vec3 = [...this.xh], yh: Vec3 = [...this.yh];
    const l1 = this.l1, l2 = this.l2, tanF1 = this.tanF1, tanF2 = this.tanF2;
    const hit = this.axisGround(r);
    let type: SolarType;
    let magnitude: number;
    let point: Vec3; // ICRF, geocentric, km
    if (hit) {
      point = mulT(r, hit, [0, 0, 0]);
      const zeta = dot(point, k) / EARTH_A;
      const L1 = l1 - zeta * tanF1, L2 = l2 - zeta * tanF2;
      magnitude = (L1 - L2) / (L1 + L2);
      if (L2 > 0) type = 'annular';
      else {
        // Total at greatest eclipse, but the umbra shrinks toward the path's ends, where
        // the Sun is on the horizon (zeta = 0): annular there makes it hybrid.
        const before = exit(this.axisMiss, tdb, -1800, 12);
        const lBefore = before === null ? l2 : (this.besselian(before), this.l2);
        const after = exit(this.axisMiss, tdb, 1800, 12);
        const lAfter = after === null ? l2 : (this.besselian(after), this.l2);
        type = lBefore > 0 || lAfter > 0 ? 'hybrid' : 'total';
      }
    } else {
      // The axis misses. NASA's catalogue gives the point of a spherical Earth nearest
      // the axis, on the sunrise or sunset line, and the magnitude where the penumbra
      // reaches furthest over Earth's outline (an ellipse seen along the axis).
      const d = Math.hypot(x, y);
      point = [0, 1, 2].map((i) => (EARTH_A * (x * xh[i] + y * yh[i])) / d) as Vec3;
      const delta = ellipseDistance(x, y, this.rho1);
      magnitude = (l1 - delta) / (l1 + l2);
      if (delta < Math.abs(l2)) type = l2 < 0 ? 'total' : 'annular';
      else if (magnitude > 0) type = 'partial';
      else return null;
    }
    const pb = mul(r, point, [0, 0, 0]);
    let lat: number, lon: number, up: Vec3;
    if (hit) {
      const g = bodyToGeodetic(WGS84, pb);
      lon = g[0]; lat = g[1];
      up = mulT(r, [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)], [0, 0, 0]);
    } else {
      lat = Math.asin(pb[2] / EARTH_A);
      lon = Math.atan2(pb[1], pb[0]);
      up = [point[0] / EARTH_A, point[1] / EARTH_A, point[2] / EARTH_A];
    }
    const eclipse: SolarEclipse = {
      type, tdb, gamma, magnitude, central: hit !== null,
      lat: lat / DEG, lon: lon / DEG, sunAlt: Math.asin(dot(up, k)) / DEG,
    };
    if (hit) eclipse.duration = this.centralDuration(hit, tdb);
    return eclipse;
  }

  /** Where the shadow axis meets the ellipsoid (Earth-fixed, km) for rotation r, or null. */
  private axisGround(r: Mat3): Vec3 | null {
    const o = mul(r, this.moon, this.v);
    const d = mul(r, this.kh, this.w);
    d[0] = -d[0]; d[1] = -d[1]; d[2] = -d[2];
    // Scale z so the ellipsoid becomes a sphere of radius a.
    const f = EARTH_A / WGS84.b;
    const oz = o[2] * f, dz = d[2] * f;
    const a = d[0] * d[0] + d[1] * d[1] + dz * dz;
    const b = 2 * (o[0] * d[0] + o[1] * d[1] + oz * dz);
    const c = o[0] * o[0] + o[1] * o[1] + oz * oz - EARTH_A * EARTH_A;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  }

  /** Duration (s) a fixed Earth-fixed point (km) stays inside the umbra or antumbra around tdb. */
  private centralDuration(ground: Vec3, tdb: number): number {
    const p: Vec3 = [0, 0, 0];
    // Positive inside: the cone's radius at the observer minus its distance from the axis.
    const inside = (t: number) => {
      this.besselian(t);
      mulT(this.earthRotation(t), ground, p);
      const xi = dot(p, this.xh) / EARTH_A, eta = dot(p, this.yh) / EARTH_A, zeta = dot(p, this.kh) / EARTH_A;
      return Math.abs(this.l2 - zeta * this.tanF2) - Math.hypot(this.bx - xi, this.by - eta);
    };
    const outside = (t: number) => -inside(t);
    const a = exit(outside, tdb, -120, 10), b = exit(outside, tdb, 120, 10);
    return a === null || b === null ? 0 : b - a;
  }

  /** Every lunar eclipse with greatest eclipse in [start, end] (TDB). */
  lunarEclipses(start: number, end: number): LunarEclipse[] {
    const out: LunarEclipse[] = [];
    const eph = this.ephemeris;
    for (let k = Math.floor((start - NEW_MOON_EPOCH) / SYNODIC_MONTH) - 1; ; k++) {
      const guess = NEW_MOON_EPOCH + (k + 0.5) * SYNODIC_MONTH;
      if (guess > end + 2 * DAY) break;
      // True syzygy is within 15 hours of the mean one.
      if (guess - 2 * DAY < eph.start || guess + 2 * DAY > eph.end) continue;
      const tdb = minimize(this.shadowDistance2, guess, 60, 6 * 3600);
      if (tdb < start || tdb > end) continue;
      const e = this.lunarAt(tdb);
      if (e) out.push(e);
    }
    return out;
  }

  // Lunar shadow geometry at the last `shadow` call: the Moon's distance from the axis
  // and the shadow and Moon radii, all as angles at Earth's centre.
  private sep = 0; private umbra = 0; private penumbra = 0; private moonRadius = 0;

  /**
   * Sun and Moon relative to Earth's centre for a lunar eclipse. Earth's shadow is cast
   * along the sunlight's direction in Earth's frame, the aberrated (apparent) direction
   * of the Sun; the Moon is where it was when the light left it. Both are differences of
   * positions at the retarded epoch, X(t - tau) - E(t - tau). (Using the light-time
   * corrected barycentric difference for both, as for solar eclipses, would shift the
   * Moon against the shadow by twice the aberration, 41", and greatest eclipse by over a
   * minute: a solar eclipse compares the Sun and Moon, which aberration shifts alike.)
   */
  private geocentric(id: number, tdb: number, out: Vec3): void {
    const e = this.ephemeris.position(399, tdb, this.earth);
    const p = this.ephemeris.position(id, tdb, out);
    const at = tdb - Math.hypot(p[0] - e[0], p[1] - e[1], p[2] - e[2]) / C_KM_S;
    this.ephemeris.position(id, at, out);
    this.ephemeris.position(399, at, this.earth);
    out[0] -= this.earth[0]; out[1] -= this.earth[1]; out[2] -= this.earth[2];
  }

  private shadow(tdb: number): void {
    this.geocentric(10, tdb, this.sun);
    this.geocentric(301, tdb, this.moon);
    const s = this.sun, m = this.moon;
    const ds = norm(s), dm = norm(m);
    this.v[0] = -s[0]; this.v[1] = -s[1]; this.v[2] = -s[2];
    this.sep = angleBetween(m, this.v);
    const pm = Math.asin(EARTH_A / dm), ss = Math.asin(SUN_ECLIPSE_RADIUS / ds), ps = Math.asin(EARTH_A / ds);
    this.umbra = DANJON * pm - ss + ps;
    this.penumbra = DANJON * pm + ss + ps;
    this.moonRadius = Math.asin((MOON_K_LUNAR * EARTH_A) / dm);
  }

  private readonly shadowDistance2 = (tdb: number) => {
    this.shadow(tdb);
    return this.sep * this.sep;
  };

  private lunarAt(tdb: number): LunarEclipse | null {
    this.shadow(tdb);
    const sm = this.moonRadius, sep = this.sep;
    const umbral = (this.umbra + sm - sep) / (2 * sm);
    const penumbral = (this.penumbra + sm - sep) / (2 * sm);
    if (penumbral <= 0) return null;
    // Gamma: the Moon's distance from the axis in Earth radii, negative when south of it.
    const r = this.earthRotation(tdb, new Float64Array(9));
    const moon: Vec3 = [...this.moon];
    // Sign: the Moon's offset from the axis (which points away from the Sun) along the pole.
    const pole: Vec3 = [r[6], r[7], r[8]];
    const north = dot(moon, pole) - (dot(moon, this.sun) * dot(this.sun, pole)) / dot(this.sun, this.sun);
    const gamma = (Math.sign(north) * norm(moon) * Math.sin(sep)) / EARTH_A;
    const pb = mul(r, moon, [0, 0, 0]);
    const phase = (radius: (self: SkyEvents) => number) => {
      const f = (t: number) => (this.shadow(t), this.sep - radius(this));
      const a = exit(f, tdb, -1800, 16), b = exit(f, tdb, 1800, 16);
      return a === null || b === null ? 0 : b - a;
    };
    const e: LunarEclipse = {
      type: umbral >= 1 ? 'total' : umbral > 0 ? 'partial' : 'penumbral',
      tdb, gamma, umbral, penumbral,
      penumbralDuration: phase((s) => s.penumbra + s.moonRadius),
      lat: Math.asin(pb[2] / norm(pb)) / DEG,
      lon: Math.atan2(pb[1], pb[0]) / DEG,
    };
    if (umbral > 0) e.partialDuration = phase((s) => s.umbra + s.moonRadius);
    if (umbral >= 1) e.totalDuration = phase((s) => s.umbra - s.moonRadius);
    return e;
  }

  /** Transits of Mercury (199) or Venus (299) across the Sun seen from Earth's centre. */
  transits(body: 199 | 299, start: number, end: number): Transit[] {
    const out: Transit[] = [];
    const radius = PLANET_RADIUS[body];
    // Angular separation of the planet from the Sun and their angular radii.
    let sunR = 0, planetR = 0;
    const separation = (t: number) => {
      this.ephemeris.position(399, t, this.earth);
      this.apparent(10, t, this.earth, this.sun);
      this.apparent(body, t, this.earth, this.planet);
      sunR = Math.asin(SUN_ECLIPSE_RADIUS / norm(this.sun));
      planetR = Math.asin(radius / norm(this.planet));
      return angleBetween(this.sun, this.planet);
    };
    // Inferior conjunctions: minima of the separation, sampled every day (Mercury moves
    // up to 4 degrees a day relative to the Sun, so the nearest sample is within 2).
    const t0 = Math.max(start, this.ephemeris.start + DAY), t1 = Math.min(end, this.ephemeris.end - DAY);
    let a = separation(t0), b = separation(t0 + DAY);
    for (let t = t0 + DAY; t + DAY <= t1; t += DAY) {
      const c = separation(t + DAY);
      if (b < a && b <= c && b < 3 * DEG) {
        const g = minimize((u) => separation(u) ** 2, t, 60, DAY);
        const min = separation(g);
        // In front of the Sun (inferior conjunction), not behind it.
        const front = norm(this.planet) < norm(this.sun);
        if (front && min < sunR + planetR && g >= start && g <= end) {
          const contact = (outer: boolean) => (u: number) => separation(u) - (outer ? sunR + planetR : sunR - planetR);
          const contacts = [exit(contact(true), g, -1800, 24)!, exit(contact(true), g, 1800, 24)!];
          separation(g);
          if (min < sunR - planetR) contacts.splice(1, 0, exit(contact(false), g, -1800, 24)!, exit(contact(false), g, 1800, 24)!);
          separation(g);
          const pb = mul(this.earthRotation(g), this.sun, this.v);
          out.push({
            body, tdb: g, separation: min / ARCSEC, contacts,
            lat: Math.asin(pb[2] / norm(pb)) / DEG, lon: Math.atan2(pb[1], pb[0]) / DEG,
          });
        }
      }
      a = b; b = c;
    }
    return out;
  }
}

export interface MarsSite {
  name?: string;
  /** Planetocentric latitude and east longitude (degrees, IAU Mars frame) and radius (km). */
  lat: number;
  lon: number;
  radius: number;
}

/**
 * Perseverance's landing site, Octavia E. Butler Landing in Jezero crater, from NAIF's
 * landing-site kernel m2020_ls_ops210303_iau2000_v1.bsp (a fixed vector in IAU_MARS).
 * The kernel's frame used pck00010's Mars rotation; pck00011's differs by about 0.01
 * degree here, a few hundred metres on the ground.
 */
export const PERSEVERANCE: MarsSite = { name: 'Octavia E. Butler Landing, Jezero crater', lat: 18.444627, lon: 77.450886, radius: 3391.937 };

/** The Sun and Phobos seen from a place on Mars: angles in radians. */
export interface PhobosView {
  separation: number;
  sunRadius: number;
  phobosRadius: number;
  /** The Sun's altitude above the plane normal to the site's radius vector. */
  sunAltitude: number;
}

/**
 * The view of the Sun and Phobos from a place on Mars as a function of TDB, from the
 * IAU rotation of Mars and the Phobos ephemeris (moons-mars.bin, added to `ephemeris`).
 * Light time is applied as in eclipse.ts. Phobos is a sphere of its mean radius; its
 * long axis points at Mars, so from the ground it shows roughly its 11.4 x 9.1 km
 * cross-section, which would make the transit about 0.5 s longer and 3 km narrower.
 * The returned object is reused between calls.
 */
export function phobosView(ephemeris: Ephemeris, site: MarsSite): (tdb: number) => PhobosView {
  const local: Vec3 = [
    site.radius * Math.cos(site.lat * DEG) * Math.cos(site.lon * DEG),
    site.radius * Math.cos(site.lat * DEG) * Math.sin(site.lon * DEG),
    site.radius * Math.sin(site.lat * DEG),
  ];
  const m = new Float64Array(9);
  const observer: Vec3 = [0, 0, 0], up: Vec3 = [0, 0, 0], sun: Vec3 = [0, 0, 0], phobos: Vec3 = [0, 0, 0];
  const view: PhobosView = { separation: 0, sunRadius: 0, phobosRadius: 0, sunAltitude: 0 };
  const apparent = (id: number, t: number, o: Vec3) => {
    const p = ephemeris.position(id, t, o);
    const tau = Math.hypot(p[0] - observer[0], p[1] - observer[1], p[2] - observer[2]) / C_KM_S;
    ephemeris.position(id, t - tau, o);
    o[0] -= observer[0]; o[1] -= observer[1]; o[2] -= observer[2];
  };
  return (t: number) => {
    ephemeris.position(499, t, observer);
    mulT(iauIcrfToBody(499, t, m), local, up);
    observer[0] += up[0]; observer[1] += up[1]; observer[2] += up[2];
    apparent(10, t, sun);
    apparent(401, t, phobos);
    const ds = norm(sun);
    view.sunRadius = Math.asin(SUN_ECLIPSE_RADIUS / ds);
    view.phobosRadius = Math.asin(PHOBOS_RADIUS / norm(phobos));
    view.separation = angleBetween(sun, phobos);
    view.sunAltitude = Math.asin(dot(sun, up) / (ds * site.radius));
    return view;
  };
}

/** Transits of Phobos across the Sun seen from a place on Mars, with the Sun up. */
export function phobosTransits(ephemeris: Ephemeris, site: MarsSite, start: number, end: number): Transit[] {
  const out: Transit[] = [];
  const view = phobosView(ephemeris, site);
  const separation = (t: number) => view(t).separation;
  // Phobos crosses the sky at about 0.015 degrees per second from the ground, so
  // minute samples catch every close pass.
  const step = 60;
  const t0 = Math.max(start, ephemeris.start + step), t1 = Math.min(end, ephemeris.end - step);
  let a = separation(t0), b = separation(t0 + step);
  for (let t = t0 + step; t + step <= t1; t += step) {
    const c = separation(t + step);
    if (b < a && b <= c && b < 2 * DEG) {
      const g = minimize((u) => separation(u) ** 2, t, 0.5, step);
      const v = view(g);
      const min = v.separation, outer = v.sunRadius + v.phobosRadius, inner = v.sunRadius - v.phobosRadius;
      if (v.sunAltitude > 0 && min < outer && g >= start && g <= end) {
        const contact = (r: number) => (u: number) => separation(u) - r;
        const contacts = [exit(contact(outer), g, -10, 12)!, exit(contact(outer), g, 10, 12)!];
        if (min < inner) contacts.splice(1, 0, exit(contact(inner), g, -10, 12)!, exit(contact(inner), g, 10, 12)!);
        out.push({ body: 401, tdb: g, separation: min / ARCSEC, contacts });
      }
    }
    a = b; b = c;
  }
  return out;
}
