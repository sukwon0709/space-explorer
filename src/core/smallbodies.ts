import type { Vec3 } from './ephemeris';

/**
 * Asteroids and comets as two-body heliocentric orbits from JPL Small-Body Database
 * elements (see pipeline/fetch_smallbodies.py). Planetary perturbations are left out,
 * which is good to a few thousand km within a few years of each orbit's epoch for
 * main-belt asteroids and plenty for drawing the belt; comets passing close to Jupiter
 * drift further. Positions are km, ecliptic J2000 axes, relative to the Sun.
 */

export const AU_KM = 149597870.7;
/** Gaussian gravitational constant: the Sun's mean motion at 1 AU, rad/day. */
export const GAUSS_K = 0.01720209895;
const JD_J2000 = 2451545.0;

export interface AsteroidSet {
  count: number;
  /** count x 8 float32: a [AU], e, i, Omega, omega, M [rad], epoch [days past J2000], H. */
  elements: Float32Array;
  /** 1 = near-Earth asteroid. */
  flags: Uint8Array;
}

export function parseAsteroids(buffer: ArrayBuffer): AsteroidSet {
  const view = new DataView(buffer);
  if (String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== 'SBDY') throw new Error('Not an SBDY file');
  const count = view.getUint32(8, true);
  return {
    count,
    elements: new Float32Array(buffer, 16, count * 8),
    flags: new Uint8Array(buffer, 16 + count * 32, count),
  };
}

export interface Comet {
  name: string;
  /** Perihelion distance [AU], eccentricity, inclination, node, argument of perihelion [deg]. */
  q: number;
  e: number;
  i: number;
  om: number;
  w: number;
  /** Time of perihelion and epoch of the elements, Julian Date TDB. */
  tp: number;
  epoch: number;
}

export interface Orbit {
  /** Perihelion distance, AU. */
  q: number;
  e: number;
  /** Radians. */
  i: number;
  node: number;
  peri: number;
  /** Time of perihelion, days past J2000 TDB. */
  tp: number;
}

export function asteroidOrbit(set: AsteroidSet, index: number): Orbit {
  const el = set.elements.subarray(index * 8, index * 8 + 8);
  const [a, e, i, node, peri, m, epoch] = el;
  const n = GAUSS_K / Math.pow(a, 1.5);
  return { q: a * (1 - e), e, i, node, peri, tp: epoch - m / n };
}

export function cometOrbit(c: Comet): Orbit {
  const DEG = Math.PI / 180;
  return { q: c.q, e: c.e, i: c.i * DEG, node: c.om * DEG, peri: c.w * DEG, tp: c.tp - JD_J2000 };
}

/**
 * Heliocentric position (km, ecliptic J2000) at `days` past J2000 TDB, for any
 * eccentricity: Kepler's equation for ellipses, its hyperbolic form above e = 1, and
 * Barker's equation for parabolas.
 */
export function orbitPosition(o: Orbit, days: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const { q, e } = o;
  const dt = days - o.tp;
  let x: number, y: number;
  if (e < 0.999) {
    const a = q / (1 - e);
    const n = GAUSS_K / Math.pow(a, 1.5);
    let M = (n * dt) % (2 * Math.PI);
    if (M > Math.PI) M -= 2 * Math.PI;
    else if (M < -Math.PI) M += 2 * Math.PI;
    let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
    for (let k = 0; k < 30; k++) {
      const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= d;
      if (Math.abs(d) < 1e-14) break;
    }
    x = a * (Math.cos(E) - e);
    y = a * Math.sqrt(1 - e * e) * Math.sin(E);
  } else if (e > 1.001) {
    const a = q / (e - 1);
    const M = (GAUSS_K / Math.pow(a, 1.5)) * dt;
    let H = Math.asinh(M / e);
    for (let k = 0; k < 50; k++) {
      const d = (e * Math.sinh(H) - H - M) / (e * Math.cosh(H) - 1);
      H -= d;
      if (Math.abs(d) < 1e-14) break;
    }
    x = a * (e - Math.cosh(H));
    y = a * Math.sqrt(e * e - 1) * Math.sinh(H);
  } else {
    // Near-parabolic: Barker's equation s^3/3 + s = W with s = tan(nu/2), using the
    // parabola with this perihelion distance (good enough within 0.1% of e = 1 near
    // perihelion, where such comets are seen).
    const W = (GAUSS_K * dt) / Math.sqrt(2 * q * q * q);
    const c = Math.cbrt(1.5 * W + Math.sqrt(1 + 2.25 * W * W));
    const s = c - 1 / c;
    x = q * (1 - s * s);
    y = 2 * q * s;
  }
  const cO = Math.cos(o.node), sO = Math.sin(o.node);
  const cw = Math.cos(o.peri), sw = Math.sin(o.peri);
  const ci = Math.cos(o.i), si = Math.sin(o.i);
  out[0] = (x * (cO * cw - sO * sw * ci) - y * (cO * sw + sO * cw * ci)) * AU_KM;
  out[1] = (x * (sO * cw + cO * sw * ci) - y * (sO * sw - cO * cw * ci)) * AU_KM;
  out[2] = (x * sw * si + y * cw * si) * AU_KM;
  return out;
}
