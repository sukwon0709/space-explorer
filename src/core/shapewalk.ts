import type { Vec3 } from './ephemeris';
import type { Hit } from './shape';
import { EYE_HEIGHT, FRICTION, JUMP_SPEED, LEG, type WalkInput } from './walker';

/**
 * Someone on foot on a small body, drawn from its shape model (core/shape.ts): an
 * asteroid or comet nucleus a few hundred metres to a few tens of km across. As on the
 * planets (core/walker.ts) everything is in the body-fixed frame, which turns with the
 * body, but the ground is the triangle mesh itself and gravity is that of the
 * polyhedron (Werner & Scheeres 1997) plus the centrifugal acceleration, so "down" is
 * wherever the two together point: on a contact binary like 67P or Arrokoth it swings
 * through tens of degrees from the line to the centre, and on a fast spinner like
 * Didymos the equator is nearly weightless.
 *
 *   a = g_poly(p) - w x (w x p) - 2 w x v
 *
 * Gravity there is a ten-thousandth of Earth's or less, so the gait follows it (Froude
 * number, as in walker.ts): a walk on Bennu is 4 mm/s. Shown in real time that is a
 * standstill, so time runs faster while walking, by sqrt(g_Earth / g): the same
 * Froude number then moves the legs as on Earth. Everything else runs fast with it,
 * the Sun crossing the sky too. A jump is a gentle push (under half the escape speed);
 * a full jump (3.1 m/s, as on Earth) leaves most of these bodies for good.
 */

export interface ShapeWalkWorld {
  /** Gravitational acceleration (km/s^2, body frame) at a point. */
  gravity(p: Vec3, out?: Vec3): Vec3;
  /** Rotation in the body frame, rad/s. */
  spin: Vec3;
  /** First surface hit along a ray (body frame, km), within `maxT` km. */
  raycast(origin: Vec3, dir: Vec3, maxT: number): Hit | undefined;
  /** Gravitational parameter (km^3/s^2) and largest radius (km). */
  gm: number;
  radius: number;
}

/** Feet are looked for this far above them (km), and followed this far down a step. */
const PROBE = 0.0005;
const STEP_DOWN = 0.0003;
const FROUDE_WALK = 0.25;
const FROUDE_RUN = 2.5;
const MAX_SLOPE = (40 * Math.PI) / 180;
/** Substeps per second of the walker's own (real) time. */
const RATE = 120;

export class ShapeWalker {
  /** Feet (km) and velocity (km/s), body frame. */
  p: Vec3;
  v: Vec3 = [0, 0, 0];
  /** Facing direction along the ground (unit, body frame) and look angle above it. */
  fwd: Vec3;
  pitch = 0;
  onGround = true;
  /** Ground normal under the feet (smoothed over half a metre). */
  normal: Vec3;
  airTime = 0;
  /** Highest point above take-off (m). */
  peak = 0;
  private takeoff: Vec3 = [0, 0, 0];

  constructor(p: Vec3, heading: Vec3, normal: Vec3) {
    this.p = [...p];
    this.normal = [...normal];
    this.fwd = tangent(heading, normal);
  }

  /** Gravity plus the centrifugal acceleration at a point (km/s^2, body frame). */
  effective(world: ShapeWalkWorld, p: Vec3 = this.p, out: Vec3 = [0, 0, 0]): Vec3 {
    world.gravity(p, out);
    const w = world.spin;
    const c = cross(w, cross(w, p));
    for (let k = 0; k < 3; k++) out[k] -= c[k];
    return out;
  }

  /** Local up: against the effective gravity (outward from the centre if it vanishes). */
  up(world: ShapeWalkWorld, p: Vec3 = this.p, g = this.effective(world, p)): Vec3 {
    const l = len(g);
    if (l === 0 || dot(g, p) > 0) return scale(p, 1 / len(p));
    return [-g[0] / l, -g[1] / l, -g[2] / l];
  }

  /** Comfortable pace (or a run), km/s of body time, for the gravity here. */
  pace(world: ShapeWalkWorld, run: boolean): number {
    const g = len(this.effective(world)) * 1000;
    return Math.sqrt((run ? FROUDE_RUN : FROUDE_WALK) * g * LEG) / 1000;
  }

  /** Escape speed from the body at the feet (km/s), from GM and distance to the centre. */
  escapeSpeed(world: ShapeWalkWorld): number {
    return Math.sqrt((2 * world.gm) / len(this.p));
  }

  /** How much faster than real time to run, so a walk looks like one on Earth. */
  static timeRate(world: ShapeWalkWorld, p: Vec3): number {
    const w = new ShapeWalker(p, [1, 0, 0], [0, 0, 1]);
    const g = len(w.effective(world)) * 1000;
    return Math.max(1, Math.min(1000, Math.sqrt(9.80665 / Math.max(g, 1e-9))));
  }

  eye(world: ShapeWalkWorld): Vec3 {
    const up = this.up(world);
    return [this.p[0] + (up[0] * EYE_HEIGHT) / 1000, this.p[1] + (up[1] * EYE_HEIGHT) / 1000, this.p[2] + (up[2] * EYE_HEIGHT) / 1000];
  }

  view(world: ShapeWalkWorld): { dir: Vec3; up: Vec3 } {
    const up = this.up(world);
    const f = tangent(this.fwd, up);
    const c = Math.cos(this.pitch), s = Math.sin(this.pitch);
    return {
      dir: [f[0] * c + up[0] * s, f[1] * c + up[1] * s, f[2] * c + up[2] * s],
      up: [-f[0] * s + up[0] * c, -f[1] * s + up[1] * c, -f[2] * s + up[2] * c],
    };
  }

  /** Turn right by `dHeading` and look up by `dPitch` (radians). */
  look(world: ShapeWalkWorld, dHeading: number, dPitch: number): void {
    const up = this.up(world);
    const f = tangent(this.fwd, up);
    const right = cross(f, up);
    const c = Math.cos(dHeading), s = Math.sin(dHeading);
    this.fwd = tangent([f[0] * c + right[0] * s, f[1] * c + right[1] * s, f[2] * c + right[2] * s], up);
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dPitch));
  }

  /** The ground under a point: a ray down from just above it. */
  ground(world: ShapeWalkWorld, p: Vec3, up: Vec3, depth = PROBE + STEP_DOWN): Hit | undefined {
    const o: Vec3 = [p[0] + up[0] * PROBE, p[1] + up[1] * PROBE, p[2] + up[2] * PROBE];
    return world.raycast(o, [-up[0], -up[1], -up[2]], depth);
  }

  /** The ground's normal around the feet, averaged over three points 30 cm apart. */
  private smoothNormal(world: ShapeWalkWorld, up: Vec3): Vec3 | undefined {
    const f = tangent(this.fwd, up);
    const r = cross(f, up);
    const n: Vec3 = [0, 0, 0];
    let found = 0;
    for (let i = 0; i < 3; i++) {
      const a = (i * 2 * Math.PI) / 3;
      const d = 0.0003;
      const q: Vec3 = [0, 1, 2].map((k) => this.p[k] + (f[k] * Math.cos(a) + r[k] * Math.sin(a)) * d) as Vec3;
      const hit = this.ground(world, q, up, PROBE + 0.002);
      if (!hit) continue;
      const s = dot(hit.normal, up) < 0 ? -1 : 1;
      for (let k = 0; k < 3; k++) n[k] += hit.normal[k] * s;
      found++;
    }
    if (!found) return undefined;
    return scale(n, 1 / len(n));
  }

  /**
   * Advance `dt` seconds of the body's time, in substeps set by the `real` seconds that
   * pass for the walker. Returns 'landed' on touching down after a jump, 'escaped' once
   * well clear of the body faster than its escape speed.
   */
  step(world: ShapeWalkWorld, dt: number, real: number, input: WalkInput): 'landed' | 'escaped' | undefined {
    if (dt <= 0) return undefined;
    let event: 'landed' | 'escaped' | undefined;
    if (this.onGround) this.normal = this.smoothNormal(world, this.up(world)) ?? this.normal;
    const n = Math.max(1, Math.min(48, Math.ceil(real * RATE)));
    const h = dt / n;
    const pace = this.pace(world, input.run);
    for (let i = 0; i < n; i++) {
      event = this.substep(world, h, input, pace) ?? event;
      input = { ...input, jump: false };
    }
    const r = len(this.p);
    if (!this.onGround && r > 2 * world.radius && dot(this.v, this.p) > 0 && len(this.v) > this.escapeSpeed(world)) event = 'escaped';
    return event;
  }

  private substep(world: ShapeWalkWorld, h: number, input: WalkInput, pace: number): 'landed' | undefined {
    const g = this.effective(world);
    const cor = cross(world.spin, this.v);
    const a: Vec3 = [g[0] - 2 * cor[0], g[1] - 2 * cor[1], g[2] - 2 * cor[2]];
    const up = this.up(world, this.p, g);
    let event: 'landed' | undefined;
    if (this.onGround) {
      const normal = dot(this.normal, up) > 0 ? this.normal : up;
      const slope = Math.acos(Math.min(1, dot(normal, up)));
      const into = dot(a, normal);
      for (let k = 0; k < 3; k++) a[k] -= into * normal[k];
      const f = tangent(this.fwd, normal);
      const right = cross(f, normal);
      const [mf, mr] = input.move;
      const m = Math.hypot(mf, mr);
      const want: Vec3 = [0, 0, 0];
      if (m > 0 && slope < MAX_SLOPE) for (let k = 0; k < 3; k++) want[k] = ((f[k] * mf + right[k] * mr) / Math.max(1, m)) * pace;
      const grip = slope < MAX_SLOPE ? FRICTION * Math.max(0, -into) : 0.5 * FRICTION * Math.max(0, -into) * Math.cos(slope);
      const dv: Vec3 = [0, 0, 0];
      for (let k = 0; k < 3; k++) dv[k] = want[k] - (this.v[k] - dot(this.v, normal) * normal[k] + a[k] * h);
      const need = len(dv) / h;
      const push = Math.min(need, grip);
      for (let k = 0; k < 3; k++) a[k] += need > 0 ? (dv[k] / h) * (push / need) : 0;
      if (input.jump) {
        // A gentle push, or (running) the full 3.1 m/s legs give on Earth.
        const speed = input.run ? JUMP_SPEED / 1000 : Math.min(JUMP_SPEED / 1000, 0.45 * this.escapeSpeed(world));
        for (let k = 0; k < 3; k++) {
          this.v[k] += normal[k] * speed;
          a[k] = g[k] - 2 * cor[k];
        }
        this.onGround = false;
        this.airTime = 0;
        this.peak = 0;
        this.takeoff = [...this.p];
      }
    }
    const before: Vec3 = [...this.p];
    for (let k = 0; k < 3; k++) {
      this.p[k] += (this.v[k] + 0.5 * a[k] * h) * h;
      this.v[k] += a[k] * h;
    }
    // (Up barely turns within a substep.)
    const up2 = up;
    if (this.onGround) {
      // A rise steeper than a scramble (a boulder's side, a cliff) stops the feet.
      const hit = this.ground(world, this.p, up2);
      const moved = sub(this.p, before);
      const flat = sub(moved, scale(up2, dot(moved, up2)));
      const across = len(flat);
      // At knee height, toward where the feet are going.
      const knee: Vec3 = [before[0] + up2[0] * 0.0004, before[1] + up2[1] * 0.0004, before[2] + up2[2] * 0.0004];
      const wall = across > 1e-9 && world.raycast(knee, scale(flat, 1 / across), across + 0.0002);
      if (wall || (hit && PROBE - hit.t > across * 1.7 + 0.00002)) {
        this.p = before;
        const vn = dot(this.v, up2);
        this.v = scale(up2, Math.min(0, vn));
        return event;
      }
    }
    if (!this.onGround) {
      this.airTime += h;
      this.peak = Math.max(this.peak, dot(sub(this.p, this.takeoff), up2) * 1000);
      // Touch down when the feet reach the ground (looked for from just above them).
      const reach = PROBE + Math.max(0, -dot(this.v, up2) * h);
      const hit = this.ground(world, this.p, up2, reach);
      if (hit && hit.t <= PROBE + 1e-9) {
        this.p = [...hit.point];
        this.settle(hit.normal, up2);
        this.onGround = true;
        event = 'landed';
      }
    } else {
      const hit = this.ground(world, this.p, up2);
      if (hit) {
        this.p = [...hit.point];
        this.settle(hit.normal, up2);
      } else {
        // Walked off an edge (or the ground fell away faster than gravity pulls).
        this.onGround = false;
        this.airTime = 0;
        this.peak = 0;
        this.takeoff = [...this.p];
      }
    }
    return event;
  }

  /** On the ground: no motion into it (no bounce). */
  private settle(normal: Vec3, up: Vec3): void {
    const n = dot(normal, up) < 0 ? scale(normal, -1) : normal;
    const vn = dot(this.v, n);
    if (vn < 0) for (let k = 0; k < 3; k++) this.v[k] -= vn * n[k];
  }
}

/** `v` made perpendicular to unit `n` and normalised (any perpendicular if parallel). */
export function tangent(v: Vec3, n: Vec3): Vec3 {
  const d = dot(v, n);
  let t: Vec3 = [v[0] - d * n[0], v[1] - d * n[1], v[2] - d * n[2]];
  if (len(t) < 1e-6) t = cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  return scale(t, 1 / len(t));
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
