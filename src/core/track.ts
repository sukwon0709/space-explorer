import type { Vec3 } from './ephemeris';

/** A state table as pipeline/fetch_approaches.py writes it (public/data/events/*.json). */
export interface TrackJson {
  name: string;
  designation: string;
  center: number;
  frame: string;
  /** TDB seconds past J2000 of the first sample, and the spacing of the samples (s). */
  start: number;
  step: number;
  /** km and km/s, x y z flattened. */
  positions: number[];
  velocities: number[];
}

/**
 * Position of a small body around a close approach, from a JPL Horizons state table:
 * geocentric ICRF km at a TDB epoch. Between samples, position is the cubic Hermite
 * polynomial through the two neighbouring positions and velocities, and velocity its
 * derivative; the pipeline picks a step for which this is within 0.5 km of Horizons.
 */
export class Track {
  readonly name: string;
  readonly designation: string;
  readonly center: number;
  readonly start: number;
  readonly end: number;
  private readonly step: number;
  private readonly p: Float64Array;
  private readonly v: Float64Array;

  constructor(json: TrackJson) {
    this.name = json.name;
    this.designation = json.designation;
    this.center = json.center;
    this.start = json.start;
    this.step = json.step;
    this.p = Float64Array.from(json.positions);
    this.v = Float64Array.from(json.velocities);
    this.end = json.start + (this.p.length / 3 - 1) * json.step;
  }

  covers(tdb: number): boolean {
    return tdb >= this.start && tdb <= this.end;
  }

  /** Sample index and fraction (0..1) of tdb within its interval. */
  private locate(tdb: number): [number, number] {
    if (!this.covers(tdb)) throw new RangeError(`Epoch ${tdb} outside track ${this.name}`);
    const x = (tdb - this.start) / this.step;
    const i = Math.min(Math.floor(x), this.p.length / 3 - 2);
    return [i, x - i];
  }

  position(tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const [i, s] = this.locate(tdb);
    const h = this.step, s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = (s3 - 2 * s2 + s) * h, h01 = -2 * s3 + 3 * s2, h11 = (s3 - s2) * h;
    const a = i * 3, b = a + 3;
    for (let k = 0; k < 3; k++) out[k] = h00 * this.p[a + k] + h10 * this.v[a + k] + h01 * this.p[b + k] + h11 * this.v[b + k];
    return out;
  }

  velocity(tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const [i, s] = this.locate(tdb);
    const h = this.step, s2 = s * s;
    // d/dt of the Hermite basis: (d/ds) / h.
    const d00 = (6 * s2 - 6 * s) / h, d10 = 3 * s2 - 4 * s + 1, d01 = (-6 * s2 + 6 * s) / h, d11 = 3 * s2 - 2 * s;
    const a = i * 3, b = a + 3;
    for (let k = 0; k < 3; k++) out[k] = d00 * this.p[a + k] + d10 * this.v[a + k] + d01 * this.p[b + k] + d11 * this.v[b + k];
    return out;
  }

  /** Closest approach to the centre body: TDB, distance (km) and speed (km/s). */
  closest(): { tdb: number; distance: number; speed: number } {
    const n = this.p.length / 3;
    let best = 0;
    for (let i = 1; i < n; i++) {
      if (Math.hypot(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]) < Math.hypot(this.p[best * 3], this.p[best * 3 + 1], this.p[best * 3 + 2])) best = i;
    }
    // Range rate r.v changes sign at the minimum; bisect it in the neighbouring intervals.
    const p: Vec3 = [0, 0, 0], v: Vec3 = [0, 0, 0];
    const rate = (t: number) => {
      this.position(t, p);
      this.velocity(t, v);
      return p[0] * v[0] + p[1] * v[1] + p[2] * v[2];
    };
    let a = this.start + Math.max(0, best - 1) * this.step, b = this.start + Math.min(n - 1, best + 1) * this.step;
    if (rate(a) < 0 && rate(b) > 0) {
      for (let i = 0; i < 60; i++) {
        const mid = (a + b) / 2;
        if (rate(mid) < 0) a = mid; else b = mid;
      }
    } else a = b = this.start + best * this.step;
    const tdb = (a + b) / 2;
    this.position(tdb, p);
    this.velocity(tdb, v);
    return { tdb, distance: Math.hypot(p[0], p[1], p[2]), speed: Math.hypot(v[0], v[1], v[2]) };
  }
}
