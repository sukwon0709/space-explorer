import type { Vec3 } from './ephemeris';
import { Ship, type FlightWorld, type Source } from './flight';
import { apsides } from './flight';

/** Most points in one forecast. */
const MAX_POINTS = 6000;
/** Farthest ahead a forecast looks: two years. */
const MAX_SPAN = 2 * 365.25 * 86400;

/** A stretch of the forecast spent in one body's frame (its sphere of influence). */
export interface ForecastRun {
  frame: number;
  first: number;
  last: number;
  /** Index of the point nearest the frame body. */
  closest: number;
}

/**
 * Where the ship goes if the engines stay off: a ghost ship flown ahead under the same
 * gravity (Ship.coast), switching frame at each sphere of influence as the ship itself
 * does, so a flyby is drawn around the body it passes. It is computed a slice at a time
 * (`advance`), so a long look ahead never stalls a frame.
 *
 * Points are kept relative to their frame body at their own time, and drawn relative to
 * where that body is now: orbits close, and a flyby shows its true hyperbola.
 */
export class Forecast {
  readonly t = new Float64Array(MAX_POINTS);
  /** Position and velocity relative to the frame body, km and km/s (scene axes). */
  readonly p = new Float64Array(MAX_POINTS * 3);
  readonly v = new Float64Array(MAX_POINTS * 3);
  readonly frames = new Int32Array(MAX_POINTS);
  n = 0;
  runs: ForecastRun[] = [];
  done = true;
  /** Why it stopped: hit the ground (or a horizon), closed an orbit, or ran out of time or points. */
  end: 'impact' | 'horizon' | 'orbit' | 'span' | 'points' | undefined;
  private ghost?: Ship;
  private sources: Source[] = [];
  private stepsSinceSources = 0;
  private tdb = 0;
  private limit = 0;
  private runEnd = Infinity;
  /** Real time (s) it was started, by the caller's clock. */
  startedAt = 0;

  /** Start over from the ship as it is at `tdb`, looking no later than `limit`. */
  start(world: FlightWorld, ship: Ship, tdb: number, limit: number, now = 0): void {
    const g = new Ship(ship.ref, ship.rel);
    g.vel = [...ship.vel];
    g.assist = false;
    this.ghost = g;
    this.tdb = tdb;
    this.limit = Math.min(limit, tdb + MAX_SPAN);
    this.n = 0;
    this.runs = [];
    this.done = !(this.limit > tdb);
    this.end = undefined;
    this.startedAt = now;
    this.sources = world.sources(g.position(world, tdb), tdb);
    this.stepsSinceSources = 0;
    this.push();
  }

  /**
   * Fly the ghost on by at most `steps` steps. `frameOf` picks the body whose sphere of
   * influence a point is in (the ship's own rule). Returns true once finished.
   */
  advance(world: FlightWorld, frameOf: (abs: Vec3, tdb: number) => number, steps: number): boolean {
    const g = this.ghost;
    if (!g || this.done) return true;
    for (let i = 0; i < steps && !this.done; i++) {
      if (this.stepsSinceSources > 20) {
        this.sources = world.sources(g.position(world, this.tdb), this.tdb);
        this.stepsSinceSources = 0;
      }
      this.stepsSinceSources++;
      if (this.sources.length === 0) {
        this.done = true;
        this.end = 'span';
        break;
      }
      const h = Math.min(g.maxStep(world, this.sources, this.tdb), this.limit - this.tdb, this.runEnd - this.tdb);
      const events = g.coast(world, this.sources, this.tdb, h);
      this.tdb += h;
      const fell = events.find((e) => e.kind === 'horizon');
      if (fell) {
        this.finish('horizon');
        break;
      }
      if (g.landed !== undefined) {
        this.push();
        this.finish('impact');
        break;
      }
      const frame = frameOf(g.position(world, this.tdb), this.tdb);
      if (frame !== g.ref) {
        this.push();
        g.rebase(world, frame, this.tdb);
        // The other body's pull now sets the step: ask for its neighbours afresh.
        this.stepsSinceSources = Infinity;
      }
      this.push();
      if (this.n >= MAX_POINTS - 2) this.finish('points');
      else if (this.tdb >= this.runEnd) this.finish('orbit');
      else if (this.tdb >= this.limit) this.finish('span');
    }
    return this.done;
  }

  private finish(end: Forecast['end']): void {
    this.done = true;
    this.end = end;
  }

  private push(): void {
    const g = this.ghost!;
    const i = this.n++;
    this.t[i] = this.tdb;
    this.frames[i] = g.ref;
    for (let k = 0; k < 3; k++) {
      this.p[i * 3 + k] = g.rel[k];
      this.v[i * 3 + k] = g.vel[k];
    }
    const run = this.runs[this.runs.length - 1];
    if (run && run.frame === g.ref) {
      run.last = i;
      if (len3(this.p, i) < len3(this.p, run.closest)) run.closest = i;
      return;
    }
    this.runs.push({ frame: g.ref, first: i, last: i, closest: i });
    // A bound orbit is drawn once round; a path that escapes, until it leaves.
    this.runEnd = Infinity;
    const gm = this.sources.find((s) => s.id === g.ref)?.gm;
    if (gm && this.runs.length === 1) {
      const { apo } = apsides(g.rel, g.vel, gm);
      if (Number.isFinite(apo)) {
        const r = length(g.rel), v2 = g.vel[0] ** 2 + g.vel[1] ** 2 + g.vel[2] ** 2;
        const a = 1 / (2 / r - v2 / gm);
        this.runEnd = this.tdb + 2 * Math.PI * Math.sqrt((a * a * a) / gm);
      }
    }
  }

  /** Where the forecast puts the ship at `tdb` (frame body and position relative to it), if it covers that time. */
  at(tdb: number, out: Vec3 = [0, 0, 0]): number | undefined {
    if (this.n < 2 || tdb < this.t[0] || tdb > this.t[this.n - 1]) return undefined;
    let lo = 0, hi = this.n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] <= tdb) lo = mid;
      else hi = mid;
    }
    const frame = this.frames[lo];
    const span = this.t[hi] - this.t[lo];
    const s = this.frames[hi] === frame && span > 0 ? (tdb - this.t[lo]) / span : 0;
    for (let k = 0; k < 3; k++) out[k] = this.p[lo * 3 + k] + (this.p[hi * 3 + k] - this.p[lo * 3 + k]) * s;
    return frame;
  }

  /** The point's position relative to its frame body. */
  point(i: number, out: Vec3 = [0, 0, 0]): Vec3 {
    out[0] = this.p[i * 3]; out[1] = this.p[i * 3 + 1]; out[2] = this.p[i * 3 + 2];
    return out;
  }

  velocity(i: number, out: Vec3 = [0, 0, 0]): Vec3 {
    out[0] = this.v[i * 3]; out[1] = this.v[i * 3 + 1]; out[2] = this.v[i * 3 + 2];
    return out;
  }
}

const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const len3 = (a: Float64Array, i: number) => Math.hypot(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);
