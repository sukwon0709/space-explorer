import type { Vec3 } from './ephemeris';
import shapes from '../generated/shapes.json';

/** Barycentric ICRF position (km) of a body at a TDB epoch: the app's ephemeris. */
export type BodyPosition = (id: number, tdb: number, out: Vec3) => Vec3;

/**
 * A spacecraft's path from JPL Horizons (pipeline/fetch_missions.py): rows of TDB
 * seconds past J2000, centre (NAIF id), and ICRF position (km) and velocity (km/s)
 * relative to the centre, unevenly spaced. Between rows, the relative position is the
 * cubic Hermite polynomial through the two neighbouring positions and velocities, and
 * velocity its derivative; the pipeline places rows so this stays within 0.5 km of
 * Horizons at every interval's midpoint. Where the centre changes, an epoch is listed
 * twice, once in each frame, so no interval spans two centres.
 */
export class Trajectory {
  readonly t: Float64Array;
  readonly centres: Int32Array;
  readonly p: Float64Array;
  readonly v: Float64Array;
  readonly start: number;
  readonly end: number;
  private last = 0;
  private readonly a: Vec3 = [0, 0, 0];
  private readonly b: Vec3 = [0, 0, 0];

  constructor(buffer: ArrayBuffer) {
    const rows = new Float64Array(buffer);
    const n = rows.length / 8;
    this.t = new Float64Array(n);
    this.centres = new Int32Array(n);
    this.p = new Float64Array(n * 3);
    this.v = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.t[i] = rows[i * 8];
      this.centres[i] = rows[i * 8 + 1];
      for (let k = 0; k < 3; k++) {
        this.p[i * 3 + k] = rows[i * 8 + 2 + k];
        this.v[i * 3 + k] = rows[i * 8 + 5 + k];
      }
    }
    this.start = this.t[0];
    this.end = this.t[n - 1];
  }

  get length(): number {
    return this.t.length;
  }

  covers(tdb: number): boolean {
    return tdb >= this.start && tdb <= this.end;
  }

  /** Index of the row starting the interval containing tdb (clamped to the table). */
  index(tdb: number): number {
    const t = this.t;
    const n = t.length;
    // Playback moves forward a little each frame: try the last interval first.
    const i = this.last;
    if (i < n - 1 && t[i] <= tdb && tdb < t[i + 1]) return i;
    if (i + 2 < n && t[i + 1] <= tdb && tdb < t[i + 2]) return (this.last = i + 1);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= tdb) lo = mid;
      else hi = mid;
    }
    return (this.last = Math.min(lo, n - 2));
  }

  /** The body the path is given relative to at tdb. */
  centre(tdb: number): number {
    return this.centres[this.index(Math.min(this.end, Math.max(this.start, tdb)))];
  }

  /** Position relative to the centre (ICRF km), clamped to the ends of the table. */
  relative(tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    tdb = Math.min(this.end, Math.max(this.start, tdb));
    const i = this.index(tdb);
    const h = this.t[i + 1] - this.t[i];
    const s = h > 0 ? (tdb - this.t[i]) / h : 0, s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = (s3 - 2 * s2 + s) * h, h01 = -2 * s3 + 3 * s2, h11 = (s3 - s2) * h;
    const a = i * 3, b = a + 3;
    for (let k = 0; k < 3; k++) out[k] = h00 * this.p[a + k] + h10 * this.v[a + k] + h01 * this.p[b + k] + h11 * this.v[b + k];
    return out;
  }

  /** Velocity relative to the centre (ICRF km/s). */
  relativeVelocity(tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    tdb = Math.min(this.end, Math.max(this.start, tdb));
    const i = this.index(tdb);
    const h = this.t[i + 1] - this.t[i];
    if (!(h > 0)) {
      for (let k = 0; k < 3; k++) out[k] = this.v[i * 3 + k];
      return out;
    }
    const s = (tdb - this.t[i]) / h, s2 = s * s;
    const d00 = (6 * s2 - 6 * s) / h, d10 = 3 * s2 - 4 * s + 1, d01 = (-6 * s2 + 6 * s) / h, d11 = 3 * s2 - 2 * s;
    const a = i * 3, b = a + 3;
    for (let k = 0; k < 3; k++) out[k] = d00 * this.p[a + k] + d10 * this.v[a + k] + d01 * this.p[b + k] + d11 * this.v[b + k];
    return out;
  }

  /** Barycentric ICRF position, km: the centre's position from `at` plus the path. */
  position(tdb: number, at: BodyPosition, out: Vec3 = [0, 0, 0]): Vec3 {
    const c = this.centre(tdb);
    this.relative(tdb, out);
    at(c, Math.min(this.end, Math.max(this.start, tdb)), this.a);
    for (let k = 0; k < 3; k++) out[k] += this.a[k];
    return out;
  }

  /** Barycentric ICRF velocity, km/s (the centre's from a one-second difference). */
  velocity(tdb: number, at: BodyPosition, out: Vec3 = [0, 0, 0]): Vec3 {
    tdb = Math.min(this.end, Math.max(this.start, tdb));
    const c = this.centre(tdb);
    this.relativeVelocity(tdb, out);
    at(c, tdb + 0.5, this.a);
    at(c, tdb - 0.5, this.b);
    for (let k = 0; k < 3; k++) out[k] += this.a[k] - this.b[k];
    return out;
  }
}

export interface Approach {
  /** NAIF id of the body passed. */
  body: number;
  tdb: number;
  /** From the body's centre, km. */
  distance: number;
  /** Relative to the body, km/s. */
  speed: number;
}

/**
 * Closest approaches to a body: every local minimum of the distance closer than
 * `within` km, with bodies placed by `at`. The minimum is where the range rate r.v
 * changes sign; it is bisected to a millisecond.
 */
export function approaches(
  traj: Trajectory, id: number, at: BodyPosition, within: number, from = traj.start, to = traj.end,
): Approach[] {
  const body = (t: number, out: Vec3) => at(id, t, out);
  const sc: Vec3 = [0, 0, 0], vs: Vec3 = [0, 0, 0], b: Vec3 = [0, 0, 0], b1: Vec3 = [0, 0, 0];
  const rel = (t: number): [number, number] => {
    traj.position(t, at, sc);
    traj.velocity(t, at, vs);
    body(t, b);
    body(t + 1, b1);
    let rr = 0, rv = 0, vv = 0;
    for (let k = 0; k < 3; k++) {
      const r = sc[k] - b[k];
      const v = vs[k] - (b1[k] - b[k]);
      rr += r * r;
      rv += r * v;
      vv += v * v;
    }
    return [Math.sqrt(rr), rv / Math.sqrt(rr)];
  };
  // Sample at the table's rows, but at least every few hours so no pass is stepped over.
  const times: number[] = [];
  const first = Math.max(traj.start, from), last = Math.min(traj.end, to);
  for (let i = traj.index(first); i < traj.length && traj.t[i] <= last; i++) {
    const a = Math.max(first, traj.t[i]);
    const z = Math.min(last, i + 1 < traj.length ? traj.t[i + 1] : last);
    const n = Math.max(1, Math.ceil((z - a) / (6 * 3600)));
    for (let k = 0; k < n; k++) times.push(a + ((z - a) * k) / n);
  }
  times.push(last);
  const out: Approach[] = [];
  let [, prevRate] = rel(times[0]);
  for (let j = 1; j < times.length; j++) {
    const [d, rate] = rel(times[j]);
    if (prevRate < 0 && rate >= 0 && d < within * 3) {
      let lo = times[j - 1], hi = times[j];
      while (hi - lo > 1e-3) {
        const mid = (lo + hi) / 2;
        if (rel(mid)[1] < 0) lo = mid;
        else hi = mid;
      }
      const t = (lo + hi) / 2;
      const [dist] = rel(t);
      if (dist < within) {
        traj.velocity(t, at, vs);
        body(t, b);
        body(t + 1, b1);
        out.push({ body: id, tdb: t, distance: dist, speed: Math.hypot(vs[0] - (b1[0] - b[0]), vs[1] - (b1[1] - b[1]), vs[2] - (b1[2] - b[2])) });
      }
    }
    prevRate = rate;
  }
  return out;
}

/**
 * Spheres of influence, km (Laplace, a (m/M)^0.4), for the bodies a trajectory can be
 * given relative to (pipeline/fetch_missions.py uses the same). The Moon's is relative
 * to Earth.
 */
export const SOI: Record<number, number> = { 199: 1.12e5, 299: 6.16e5, 399: 9.25e5, 301: 6.6e4, 499: 5.77e5, 599: 4.82e7, 699: 5.48e7, 799: 5.18e7, 899: 8.68e7, 999: 3.1e6 };

// The small bodies spacecraft visited pull too weakly for a sphere worth the name; within
// 20,000 km the trail is still best drawn around them (a mission is relative to one only
// during its visit, pipeline/fetch_missions.py VISITS).
for (const e of Object.values(shapes.bodies as Record<string, { id: number }>)) SOI[e.id] = 2e4;
