import type { Vec3 } from './ephemeris';
import { C_KMS, G0 } from './gravity';

/**
 * A piloted ship: Newtonian flight under the gravity of the real bodies, with optional
 * flight assist, and a warp drive for distances no rocket could cover.
 *
 * The ship's position and velocity are kept relative to a reference object (the body
 * whose gravity dominates, or the nearest star or galaxy), in non-rotating scene axes.
 * That keeps them exact anywhere: a metre near the Moon and a metre between galaxies are
 * both representable, which barycentric coordinates 1e20 km out are not. The reference
 * object is accelerated by everything else, so the ship's equation of motion is
 *   du/dt = sum_i g_i(ship) - a_ref + thrust,
 * with a_ref the reference's own acceleration from the ephemeris.
 */

export interface FlightWorld {
  /** Scene position, km. */
  position(id: number, tdb: number, out?: Vec3): Vec3;
  /** Velocity, km/s (scene axes). */
  velocity(id: number, tdb: number, out?: Vec3): Vec3;
  /** The object's own acceleration, km/s^2: zero for stars and galaxies. */
  acceleration(id: number, tdb: number, out?: Vec3): Vec3;
  /** Gravity sources near the ship this frame. */
  sources(abs: Vec3, tdb: number): Source[];
  /** Height (km) above the ground of a point `rel` from the object's centre; NaN if it has no surface. */
  altitude(id: number, rel: Vec3, tdb: number): number;
  /** The object's rotation (rad/s, scene axes), if it turns. */
  spin(id: number, tdb: number): Vec3 | undefined;
  /** Rough size, km (for when the ground turns with the body). */
  radius(id: number): number;
}

export interface Source {
  id: number;
  gm: number;
  /** Event horizon radius, km: the hole pulls with the Paczyński–Wiita potential GM/(r - 2GM/c^2). */
  horizon?: number;
  /** Gravity of an irregular body (km/s^2, scene axes) at `rel` from its centre, in place of GM/r^2. */
  accel?: (rel: Vec3, out: Vec3) => Vec3;
}

/**
 * Something that limits warp speed: a body to slow down for (`arrive` km above its
 * `radius`), or the destination. Positions are scene km.
 */
export interface WarpLimiter {
  id: number;
  pos: Vec3;
  radius: number;
  /** Warp drops out this far above the radius when heading toward it. */
  arrive: number;
  /** A galaxy or nebula: slows the drive inside it but never stops it. */
  soft?: boolean;
}

/** Pilot input: thrust per ship axis (-1..1: right, up, forward) and turn rates (pitch, yaw, roll). */
export interface ShipInput {
  thrust: Vec3;
  turn: Vec3;
  boost: boolean;
  /** Warp throttle while the drive is on: +1 faster, -1 slower. */
  warp: number;
}

export type ShipEvent =
  | { kind: 'landed'; id: number }
  | { kind: 'dropped'; id: number }
  | { kind: 'arrived'; id: number }
  | { kind: 'horizon'; id: number }
  | { kind: 'mass-lock'; id: number };

/** A quaternion [x, y, z, w]: ship axes (x right, y up, -z forward) to scene axes. */
export type Quat = [number, number, number, number];

/** Seconds for flight assist to null drift and spin. */
const FA_TIME = 1.2;
const SPIN_TIME = 0.12;
/** Turn rates (rad/s) at full stick: pitch, yaw, roll. */
const TURN_RATE: Vec3 = [0.9, 0.9, 1.4];
/** Warp: seconds to cover the gap to whatever is ahead (in), or behind (out). */
const WARP_TAU_IN = 1;
const WARP_TAU_OUT = 0.3;
/** Warp spools up by e per this many seconds, and is never slower than this (km/s). */
const WARP_SPOOL = 0.2;
const WARP_MIN = 30;
export const WARP_MAX = 1e16 * C_KMS;
/** Shift multiplies engine thrust by this. */
export const BOOST = 30;

export class Ship {
  ref: number;
  /** Position relative to the reference object, km (scene axes). */
  rel: Vec3;
  /** Velocity relative to the reference object, km/s (non-rotating). */
  vel: Vec3 = [0, 0, 0];
  q: Quat = [0, 0, 0, 1];
  /** Turn rates in ship axes, rad/s. */
  spin: Vec3 = [0, 0, 0];
  /** Flight assist: holds still when the sticks are released. */
  assist = true;
  /** Engine acceleration, in g. */
  power = 10;
  warp = { on: false, speed: 0, set: 0 };
  /** Body the ship is standing on. */
  landed?: number;
  /** Gravitational field at the ship (km/s^2) and the strongest source, after the last step. */
  gravity: Vec3 = [0, 0, 0];
  strongest = -1;
  /** Warp speed limit (km/s) and the object that sets it, after the last warp step. */
  warpCap = Infinity;
  warpLimiter = -1;

  constructor(ref: number, rel: Vec3) {
    this.ref = ref;
    this.rel = [...rel];
  }

  forward(out: Vec3 = [0, 0, 0]): Vec3 {
    return rotate(this.q, [0, 0, -1], out);
  }

  up(out: Vec3 = [0, 0, 0]): Vec3 {
    return rotate(this.q, [0, 1, 0], out);
  }

  right(out: Vec3 = [0, 0, 0]): Vec3 {
    return rotate(this.q, [1, 0, 0], out);
  }

  /** Point the nose along `dir` with `up` as the roof (scene vectors). */
  look(dir: Vec3, up: Vec3): void {
    this.q = lookQuat(dir, up);
  }

  /** Absolute scene position at `tdb`. */
  position(world: FlightWorld, tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    world.position(this.ref, tdb, out);
    for (let k = 0; k < 3; k++) out[k] += this.rel[k];
    return out;
  }

  /** Change the reference object, keeping the absolute position and velocity. */
  rebase(world: FlightWorld, ref: number, tdb: number): void {
    if (ref === this.ref) return;
    const p0 = world.position(this.ref, tdb), p1 = world.position(ref, tdb);
    const v0 = world.velocity(this.ref, tdb), v1 = world.velocity(ref, tdb);
    for (let k = 0; k < 3; k++) {
      this.rel[k] += p0[k] - p1[k];
      this.vel[k] += v0[k] - v1[k];
    }
    this.ref = ref;
  }

  /**
   * Velocity of the local frame (km/s): the turning ground near a body that rotates
   * (within three radii), else zero. Flight assist holds still in this frame.
   */
  frameVelocity(world: FlightWorld, tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    out[0] = out[1] = out[2] = 0;
    const w = world.spin(this.ref, tdb);
    if (!w || length(this.rel) > 3 * world.radius(this.ref)) return out;
    return cross(w, this.rel, out);
  }

  /** Come to rest in the local frame (on entering flight, or after dropping out of warp). */
  stop(world: FlightWorld, tdb: number): void {
    this.frameVelocity(world, tdb, this.vel);
    this.spin = [0, 0, 0];
  }

  /** Turn the ship: input rates (with flight assist) or angular acceleration (without). */
  turn(input: ShipInput, dt: number): void {
    for (let k = 0; k < 3; k++) {
      const cmd = input.turn[k] * TURN_RATE[k];
      if (this.assist) this.spin[k] += (cmd - this.spin[k]) * (1 - Math.exp(-dt / SPIN_TIME));
      else this.spin[k] = Math.max(-3, Math.min(3, this.spin[k] + cmd * 1.5 * dt));
    }
    // Ship axes: pitch about +x, yaw about +y (positive turns left), roll about -z.
    this.rotateBody([this.spin[0] * dt, -this.spin[1] * dt, -this.spin[2] * dt]);
  }

  /** Rotate by a small angle vector in ship axes (radians). */
  rotateBody(angle: Vec3): void {
    const a = Math.hypot(angle[0], angle[1], angle[2]);
    if (a === 0) return;
    const s = Math.sin(a / 2) / a;
    this.q = normalizeQuat(mulQuat(this.q, [angle[0] * s, angle[1] * s, angle[2] * s, Math.cos(a / 2)]));
  }

  /** Turn the nose toward `dir` (scene unit vector) at up to `rate` rad/s. Returns the angle left. */
  align(dir: Vec3, rate: number, dt: number): number {
    const f = this.forward();
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(f, dir))));
    if (angle < 1e-6) return 0;
    let axis = cross(f, dir);
    if (length(axis) < 1e-9) axis = this.up();
    const n = length(axis);
    const step = Math.min(angle, rate * dt * Math.min(1, angle * 4 + 0.15));
    const s = Math.sin(step / 2) / n;
    // World-axis rotation applied on the left.
    this.q = normalizeQuat(mulQuat([axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(step / 2)], this.q));
    this.spin = [0, 0, 0];
    return angle - step;
  }

  /**
   * Advance the ship `dt` seconds of simulated time from `tdb` (gravity and engines), or
   * `real` seconds of the pilot's time under warp. Returns anything worth telling the pilot.
   */
  step(world: FlightWorld, tdb: number, dt: number, real: number, input: ShipInput, limiters: WarpLimiter[] = []): ShipEvent[] {
    const events: ShipEvent[] = [];
    this.turn(input, real);
    if (this.warp.on) {
      this.stepWarp(world, tdb + dt, real, input, limiters, events);
      return events;
    }
    if (dt === 0) return events;
    const sources = world.sources(this.position(world, tdb), tdb);
    // Substeps short against the fastest orbit around anything nearby.
    let hMax = Infinity;
    for (const s of sources) {
      const p = world.position(s.id, tdb);
      const r = Math.max(world.radius(s.id), Math.hypot(...relTo(world, this, p, tdb)));
      hMax = Math.min(hMax, 0.02 * Math.sqrt((r * r * r) / s.gm));
    }
    const n = Math.min(400, Math.max(1, Math.ceil(Math.abs(dt) / hMax)));
    const h = dt / n;
    for (let i = 0; i < n && !events.some((e) => e.kind === 'horizon'); i++) this.substep(world, sources, tdb + i * h, h, input, events);
    return events;
  }

  private readonly acc: Vec3 = [0, 0, 0];

  /** Gravity at the ship (relative to the reference's own acceleration). */
  private field(world: FlightWorld, sources: Source[], tdb: number, out: Vec3, events: ShipEvent[]): Vec3 {
    out[0] = out[1] = out[2] = 0;
    const ref = world.position(this.ref, tdb);
    let best = 0;
    this.strongest = -1;
    for (const s of sources) {
      const p = world.position(s.id, tdb);
      const d: Vec3 = [p[0] - ref[0] - this.rel[0], p[1] - ref[1] - this.rel[1], p[2] - ref[2] - this.rel[2]];
      const r = length(d);
      if (s.horizon !== undefined && r < Math.max(s.horizon, (2 * s.gm) / (C_KMS * C_KMS)) * 1.001) {
        events.push({ kind: 'horizon', id: s.id });
        continue;
      }
      if (s.accel) {
        const a = s.accel([-d[0], -d[1], -d[2]], [0, 0, 0]);
        const g = length(a);
        if (g > best) {
          best = g;
          this.strongest = s.id;
        }
        for (let k = 0; k < 3; k++) out[k] += a[k];
        continue;
      }
      // Paczyński–Wiita near a black hole: Newtonian far out, unbounded at r = 2GM/c^2.
      const r0 = s.horizon !== undefined ? r - (2 * s.gm) / (C_KMS * C_KMS) : r;
      const g = s.gm / (Math.max(r0, 1e-3) * Math.max(r0, 1e-3));
      if (g > best) {
        best = g;
        this.strongest = s.id;
      }
      for (let k = 0; k < 3; k++) out[k] += (g * d[k]) / r;
    }
    this.gravity = [out[0], out[1], out[2]];
    const aRef = world.acceleration(this.ref, tdb);
    for (let k = 0; k < 3; k++) out[k] -= aRef[k];
    return out;
  }

  private substep(world: FlightWorld, sources: Source[], tdb: number, h: number, input: ShipInput, events: ShipEvent[]): void {
    const engine = this.engine(world, tdb, input, h);
    const a = this.field(world, sources, tdb, this.acc, events);
    if (events.some((e) => e.kind === 'horizon')) return;
    // Kick-drift-kick (velocity Verlet) for gravity; the engines push for the whole step.
    for (let k = 0; k < 3; k++) this.vel[k] += (a[k] + engine[k]) * h * 0.5;
    for (let k = 0; k < 3; k++) this.rel[k] += this.vel[k] * h;
    const a2 = this.field(world, sources, tdb + h, this.acc, events);
    for (let k = 0; k < 3; k++) this.vel[k] += (a2[k] + engine[k]) * h * 0.5;
    limitSpeed(this.vel);
    this.ground(world, tdb + h, events);
  }

  /** Engine acceleration (km/s^2, scene axes): the pilot's thrust, and flight assist's. */
  private engine(world: FlightWorld, tdb: number, input: ShipInput, h: number): Vec3 {
    const max = this.power * G0 * (input.boost ? BOOST : 1);
    const axes = [this.right(), this.up(), this.forward()];
    const frame = this.frameVelocity(world, tdb);
    const out: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      let a = input.thrust[k] * max;
      if (input.thrust[k] === 0 && this.assist) {
        // Null drift along this axis in the local frame, as hard as the engines allow.
        const drift = (this.vel[0] - frame[0]) * axes[k][0] + (this.vel[1] - frame[1]) * axes[k][1] + (this.vel[2] - frame[2]) * axes[k][2];
        // (Never more than nulls it in one step, so long steps stay stable.)
        a = Math.max(-max, Math.min(max, -drift / Math.max(FA_TIME, Math.abs(h))));
      }
      for (let c = 0; c < 3; c++) out[c] += a * axes[k][c];
    }
    // Special relativity: the same push changes the speed less as it nears c.
    const v = length(this.vel);
    if (v > 1e-3 * C_KMS) {
      const beta2 = Math.min(0.99999999, (v * v) / (C_KMS * C_KMS));
      const gamma = 1 / Math.sqrt(1 - beta2);
      const along = dot(out, this.vel) / v;
      for (let c = 0; c < 3; c++) {
        const par = (along * this.vel[c]) / v;
        out[c] = par / (gamma * gamma * gamma) + (out[c] - par) / (gamma * gamma);
      }
    }
    return out;
  }

  /** Stand on the ground rather than sink into it. */
  private ground(world: FlightWorld, tdb: number, events: ShipEvent[]): void {
    const alt = world.altitude(this.ref, this.rel, tdb);
    if (!(alt < 0)) {
      if (this.landed !== undefined && alt > 0.002) this.landed = undefined;
      return;
    }
    const r = length(this.rel);
    const s = (r - alt) / r;
    for (let k = 0; k < 3; k++) this.rel[k] *= s;
    const frame = this.frameVelocity(world, tdb);
    // Keep only motion away from the ground and along it (no bounce, no tunnelling).
    const n: Vec3 = [this.rel[0] / r, this.rel[1] / r, this.rel[2] / r];
    const rel: Vec3 = [this.vel[0] - frame[0], this.vel[1] - frame[1], this.vel[2] - frame[2]];
    const out = dot(rel, n);
    for (let k = 0; k < 3; k++) this.vel[k] = frame[k] + (out < 0 ? (rel[k] - out * n[k]) * 0.9 : rel[k]);
    if (this.landed === undefined) events.push({ kind: 'landed', id: this.ref });
    this.landed = this.ref;
  }

  engageWarp(world: FlightWorld, tdb: number, limiters: WarpLimiter[], auto: boolean): ShipEvent | undefined {
    const f = this.forward();
    const abs = this.position(world, tdb);
    for (const l of limiters) {
      if (l.soft) continue;
      const d = sub(l.pos, abs);
      const dist = length(d);
      if (dist - l.radius < 0.5 * l.arrive && onCourse(d, f, l)) return { kind: 'mass-lock', id: l.id };
    }
    this.warp = { on: true, speed: Math.max(WARP_MIN, length(this.vel)), set: auto ? Infinity : C_KMS };
    this.landed = undefined;
    return undefined;
  }

  dropWarp(world: FlightWorld, tdb: number): void {
    this.warp.on = false;
    // The field is measured again on the next step; until then there is no stale reading.
    this.gravity = [0, 0, 0];
    this.strongest = -1;
    this.stop(world, tdb);
  }

  /** The fastest the drive may go now (km/s), and the limiter that sets it. */
  warpLimit(abs: Vec3, limiters: WarpLimiter[]): { cap: number; id: number; drop?: number } {
    const f = this.forward();
    let cap = WARP_MAX, id = -1;
    let drop: number | undefined;
    for (const l of limiters) {
      const d = sub(l.pos, abs);
      const dist = length(d);
      const ahead = onCourse(d, f, l);
      let c: number;
      if (l.soft) {
        if (!(dot(d, f) > 0 && missDistance(d, f) < l.radius) && dist > l.radius) continue;
        c = Math.max(dist - l.radius, 0.3 * l.radius) / WARP_TAU_IN;
      } else {
        const gap = dist - l.radius;
        if (ahead && gap < l.arrive) drop = l.id;
        c = ahead ? Math.max(0, gap - 0.9 * l.arrive) / WARP_TAU_IN : Math.max(gap, 0) / WARP_TAU_OUT;
      }
      if (c < cap) {
        cap = c;
        id = l.id;
      }
    }
    return { cap: Math.max(cap, WARP_MIN), id, drop };
  }

  private stepWarp(world: FlightWorld, tdb: number, real: number, input: ShipInput, limiters: WarpLimiter[], events: ShipEvent[]): void {
    const w = this.warp;
    if (input.warp !== 0) {
      if (!Number.isFinite(w.set)) w.set = w.speed;
      w.set = Math.min(WARP_MAX, Math.max(WARP_MIN, w.set * Math.exp(input.warp * real * (input.boost ? 6 : 3))));
    }
    // Short steps so the limit can follow the distance it is set by.
    const n = Math.max(1, Math.ceil(real / (1 / 120)));
    const h = real / n;
    const f = this.forward();
    const ref = world.position(this.ref, tdb);
    for (let i = 0; i < n; i++) {
      const abs: Vec3 = [ref[0] + this.rel[0], ref[1] + this.rel[1], ref[2] + this.rel[2]];
      const { cap, id, drop } = this.warpLimit(abs, limiters);
      this.warpCap = cap;
      this.warpLimiter = id;
      if (drop !== undefined) {
        this.rebase(world, drop, tdb);
        this.dropWarp(world, tdb);
        events.push({ kind: 'dropped', id: drop });
        return;
      }
      const target = Math.min(w.set, cap);
      w.speed = target > w.speed ? Math.min(target, w.speed * Math.exp(h / WARP_SPOOL)) : target;
      for (let k = 0; k < 3; k++) this.rel[k] += f[k] * w.speed * h;
    }
    // The drive carries the ship in its own frame: no drift relative to the reference.
    this.vel = [0, 0, 0];
  }
}

/** Ship position relative to an absolute point, as `point - ship` (km). */
function relTo(world: FlightWorld, ship: Ship, p: Vec3, tdb: number): Vec3 {
  const ref = world.position(ship.ref, tdb);
  return [p[0] - ref[0] - ship.rel[0], p[1] - ref[1] - ship.rel[1], p[2] - ref[2] - ship.rel[2]];
}

function limitSpeed(v: Vec3): void {
  const s = length(v);
  const max = 0.99999 * C_KMS;
  if (s > max) for (let k = 0; k < 3; k++) v[k] *= max / s;
}

/** Periapsis and apoapsis radii (km) of the two-body orbit about a mass `gm`; apoapsis Infinity if unbound. */
export function apsides(rel: Vec3, vel: Vec3, gm: number): { peri: number; apo: number; e: number } {
  const r = length(rel);
  const v2 = dot(vel, vel);
  const h = cross(rel, vel);
  const energy = v2 / 2 - gm / r;
  const eVec: Vec3 = [0, 0, 0];
  const vh = cross(vel, h);
  for (let k = 0; k < 3; k++) eVec[k] = vh[k] / gm - rel[k] / r;
  const e = length(eVec);
  const p = dot(h, h) / gm;
  const peri = p / (1 + e);
  const apo = energy < 0 ? (-gm / (2 * energy)) * (1 + Math.min(e, 1)) : Infinity;
  return { peri, apo, e };
}

/** Is the ship headed into it (or, for a destination with no size, into its arrival sphere)? */
function onCourse(d: Vec3, f: Vec3, l: WarpLimiter): boolean {
  return dot(d, f) > 0 && missDistance(d, f) < (l.radius > 0 ? 1.2 * l.radius : l.arrive);
}

/** Perpendicular distance from a point at `d` (relative) to the line along unit `f`. */
function missDistance(d: Vec3, f: Vec3): number {
  const along = dot(d, f);
  return Math.sqrt(Math.max(0, dot(d, d) - along * along));
}

export function lookQuat(dir: Vec3, up: Vec3): Quat {
  // Columns of the rotation: right, up, back (= -forward).
  const f = normalize(dir);
  let r = cross(f, up);
  if (length(r) < 1e-9) r = cross(f, Math.abs(f[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
  r = normalize(r);
  const u = cross(r, f);
  const b: Vec3 = [-f[0], -f[1], -f[2]];
  const m00 = r[0], m10 = r[1], m20 = r[2];
  const m01 = u[0], m11 = u[1], m21 = u[2];
  const m02 = b[0], m12 = b[1], m22 = b[2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return normalizeQuat(q);
}

export function rotate(q: Quat, v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 q.xyz x v; v' = v + w t + q.xyz x t
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  out[0] = v[0] + w * tx + (y * tz - z * ty);
  out[1] = v[1] + w * ty + (z * tx - x * tz);
  out[2] = v[2] + w * tz + (x * ty - y * tx);
  return out;
}

function mulQuat(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function normalizeQuat(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function cross(a: Vec3, b: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}
function normalize(v: Vec3): Vec3 {
  const n = length(v);
  return [v[0] / n, v[1] / n, v[2] / n];
}
