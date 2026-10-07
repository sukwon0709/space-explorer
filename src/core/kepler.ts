import type { Vec3 } from './ephemeris';

/**
 * Two-body orbits for binary stars and exoplanets: position, velocity and acceleration
 * on a Keplerian ellipse, in the orbit's own sky frame (see each function).
 */

const TWO_PI = 2 * Math.PI;
const DEG = Math.PI / 180;

/** Eccentric anomaly for mean anomaly M (radians) and eccentricity e < 1. */
export function solveKepler(M: number, e: number): number {
  M = ((M % TWO_PI) + TWO_PI) % TWO_PI;
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 30; k++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-14) break;
  }
  return E;
}

/** Mean anomaly at true anomaly f. */
export function meanFromTrue(f: number, e: number): number {
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(f / 2), Math.sqrt(1 + e) * Math.cos(f / 2));
  return E - e * Math.sin(E);
}

/**
 * Position, velocity and acceleration in the orbit plane, periapsis along the first
 * axis: semi-major axis a (any unit), mean motion n (radians per second), mean anomaly
 * M. Velocity in a per second, acceleration in a per second squared.
 */
export interface PlaneState {
  p: [number, number];
  v: [number, number];
  acc: [number, number];
}

export function planeState(a: number, e: number, n: number, M: number): PlaneState {
  const E = solveKepler(M, e);
  const cosE = Math.cos(E), sinE = Math.sin(E);
  const s = Math.sqrt(1 - e * e);
  const x = a * (cosE - e), y = a * s * sinE;
  const Edot = n / (1 - e * cosE);
  const r = a * (1 - e * cosE);
  const k = -(n * n * a * a * a) / (r * r * r);
  return { p: [x, y], v: [-a * sinE * Edot, a * s * cosE * Edot], acc: [k * x, k * y] };
}

/** A visual binary's orbit as catalogued (ORB6): years, arcseconds, degrees, Besselian years. */
export interface VisualOrbit {
  P: number;
  a: number;
  i: number;
  node: number;
  T: number;
  e: number;
  omega: number;
}

/** Julian date of a Besselian epoch. */
export function besselianToJd(year: number): number {
  return 2415020.31352 + (year - 1900) * 365.242198781;
}

/** TDB seconds past J2000 to Besselian year. */
export function tdbToBesselian(tdb: number): number {
  return 1900 + (tdb / 86400 + 2451545 - 2415020.31352) / 365.242198781;
}

/**
 * The companion relative to the primary on a visual orbit, by the Thiele-Innes
 * constants: [north, east, away from us] in arcseconds, and their rates (per second)
 * and accelerations. Away from us is positive at the ascending node's side, where the
 * companion recedes, as in ORB6.
 */
export function visualOffset(o: VisualOrbit, tdb: number): { p: Vec3; v: Vec3; acc: Vec3 } {
  const w = o.omega * DEG, W = o.node * DEG, i = o.i * DEG;
  const cw = Math.cos(w), sw = Math.sin(w), cW = Math.cos(W), sW = Math.sin(W), ci = Math.cos(i), si = Math.sin(i);
  // Unit Thiele-Innes constants (a = 1).
  const A = cw * cW - sw * sW * ci;
  const B = cw * sW + sw * cW * ci;
  const F = -sw * cW - cw * sW * ci;
  const G = -sw * sW + cw * cW * ci;
  const C = sw * si;
  const H = cw * si;
  const periodS = o.P * 365.242198781 * 86400;
  const n = TWO_PI / periodS;
  const tPeri = (besselianToJd(o.T) - 2451545) * 86400;
  const st = planeState(o.a, o.e, n, n * (tdb - tPeri));
  const map = (q: [number, number]): Vec3 => [A * q[0] + F * q[1], B * q[0] + G * q[1], C * q[0] + H * q[1]];
  return { p: map(st.p), v: map(st.v), acc: map(st.acc) };
}

/** Position angle (degrees east of north) and separation of a visual offset. */
export function positionAngle(p: Vec3): { theta: number; rho: number } {
  return { theta: ((Math.atan2(p[1], p[0]) / DEG) % 360 + 360) % 360, rho: Math.hypot(p[0], p[1]) };
}

/**
 * Sky axes at a direction (ICRF unit vector toward the star): north, east and the line
 * of sight away from us.
 */
export function skyAxes(dir: Vec3): { north: Vec3; east: Vec3; away: Vec3 } {
  const ra = Math.atan2(dir[1], dir[0]);
  const dec = Math.asin(Math.max(-1, Math.min(1, dir[2])));
  const cr = Math.cos(ra), sr = Math.sin(ra), cd = Math.cos(dec), sd = Math.sin(dec);
  return { north: [-sd * cr, -sd * sr, cd], east: [-sr, cr, 0], away: [cd * cr, cd * sr, sd] };
}

/** A planet's orbit around its star. */
export interface PlanetOrbit {
  /** Days. */
  period: number;
  /** AU. */
  a: number;
  e: number;
  /** Argument of periastron, degrees (90 when unknown: a transit then falls at periastron's quarter). */
  w: number;
  /** Inclination to the sky plane, degrees (90: edge on). */
  i: number;
  /** Position angle of the ascending node on the sky, degrees: almost never measured. */
  node: number;
  /** Time of periastron, TDB seconds past J2000. */
  tPeri: number;
}

/** Time of periastron (TDB s) from a time of mid-transit: there the true anomaly is 90° - w. */
export function periastronFromTransit(tTransit: number, periodDays: number, e: number, wDeg: number): number {
  const M = meanFromTrue(Math.PI / 2 - wDeg * DEG, e);
  return tTransit - (M / TWO_PI) * periodDays * 86400;
}

/**
 * The planet relative to its star (Winn 2010, "Transits and occultations", eqs. 2-4):
 * [north, east, away from us] in AU, with rates per second and accelerations. A transit
 * is where the planet is between its star and us.
 */
export function planetOffset(o: PlanetOrbit, tdb: number): { p: Vec3; v: Vec3; acc: Vec3 } {
  const n = TWO_PI / (o.period * 86400);
  const st = planeState(o.a, o.e, n, n * (tdb - o.tPeri));
  const w = o.w * DEG, i = o.i * DEG, W = o.node * DEG;
  const cw = Math.cos(w), sw = Math.sin(w), ci = Math.cos(i), si = Math.sin(i), cW = Math.cos(W), sW = Math.sin(W);
  const map = (q: [number, number]): Vec3 => {
    // In the orbit plane, rotated by w from the node line.
    const x1 = cw * q[0] - sw * q[1], y1 = sw * q[0] + cw * q[1];
    // Winn's X (along the node line), Y (across it on the sky), Z (toward us).
    const X = -x1, Y = -y1 * ci, Z = y1 * si;
    // Node line at position angle `node`, east of north.
    return [X * cW - Y * sW, X * sW + Y * cW, -Z];
  };
  return { p: map(st.p), v: map(st.v), acc: map(st.acc) };
}
