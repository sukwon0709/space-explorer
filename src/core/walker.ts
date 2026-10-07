import type { Vec3 } from './ephemeris';
import { bodyToGeodetic, enu, geodeticToBody, type Shape } from './geodesy';

/**
 * Someone on foot on a solid world (Earth, the Moon, Mars, Mercury, moons, dwarf planets). Everything is in the body-fixed frame,
 * which turns with the body, so the walker feels the body's gravity plus the
 * centrifugal and Coriolis accelerations of standing on a spinning world:
 *   a = -GM p/|p|^3 - w x (w x p) - 2 w x v.
 *
 * How fast people walk is set by gravity. Walking is an inverted pendulum, and the
 * gait depends on the Froude number Fr = v^2 / (g L) with L the leg length: people
 * walk comfortably at Fr = 0.25 and switch to running near 0.5, on Earth and in the
 * Apollo footage alike (Minetti 2001; Kram et al. 1997). So the comfortable pace is
 * 1.5 m/s on Earth, 0.9 m/s on Mars and 0.6 m/s on the Moon, and a run (Fr = 2.5)
 * 4.7, 2.9 and 1.9 m/s. Feet push on the ground through friction, so how hard you can
 * speed up, slow down or turn is at most mu g: sluggish on the Moon.
 *
 * A jump leaves the ground at 3.1 m/s, the take-off speed of a 0.5 m standing jump on
 * Earth: 1.3 m high on Mars and 3 m on the Moon, where it lasts nearly 4 s. There is no
 * air drag (it is negligible at walking speeds even on Earth) and no spacesuit.
 */

export interface WalkWorld {
  shape: Shape;
  /** Gravitational parameter, km^3/s^2. */
  gm: number;
  /** The body's rotation in its own frame, rad/s. */
  spin: Vec3;
  /** Ground height (km above the reference shape) under a longitude/latitude (radians). */
  ground(lon: number, lat: number): number;
}

export interface WalkInput {
  /** -1..1: forward, right. */
  move: [number, number];
  run: boolean;
  jump: boolean;
}

/** Leg length (m), eye height (m), friction coefficient of boots on regolith. */
export const LEG = 0.9;
export const EYE_HEIGHT = 1.7;
export const FRICTION = 0.6;
export const JUMP_SPEED = Math.sqrt(2 * 9.80665 * 0.5);
const FROUDE_WALK = 0.25;
const FROUDE_RUN = 2.5;
/** Slopes steeper than this can't be walked up: feet slip. */
const MAX_SLOPE = 35 * Math.PI / 180;
const STEP = 1 / 240;

export class Walker {
  /** Feet position (body-fixed km) and velocity (body-fixed km/s). */
  p: Vec3;
  v: Vec3 = [0, 0, 0];
  /** Facing direction: radians from north toward east; look angle above the horizon. */
  heading = 0;
  pitch = 0;
  onGround = false;
  /** Seconds since the feet last left the ground, and the highest point reached (m above take-off). */
  airTime = 0;
  peak = 0;
  private takeoff = 0;

  constructor(shape: Shape, lon: number, lat: number, ground: number) {
    this.p = geodeticToBody(shape, lon, lat, ground);
  }

  geodetic(shape: Shape): [number, number, number] {
    return bodyToGeodetic(shape, this.p);
  }

  /** Gravity plus centrifugal acceleration at the feet (km/s^2, body frame). */
  gravity(world: WalkWorld, out: Vec3 = [0, 0, 0]): Vec3 {
    const r = len(this.p);
    const k = -world.gm / (r * r * r);
    const w = world.spin;
    const wp = cross(w, this.p);
    const c = cross(w, wp);
    for (let i = 0; i < 3; i++) out[i] = k * this.p[i] - c[i];
    return out;
  }

  /** Pace (km/s) the walker aims for: a walk or a run at this gravity. */
  pace(world: WalkWorld, run: boolean): number {
    const g = len(this.gravity(world)) * 1000;
    return Math.sqrt((run ? FROUDE_RUN : FROUDE_WALK) * g * LEG) / 1000;
  }

  /** Eye position, body-fixed km. */
  eye(shape: Shape, out: Vec3 = [0, 0, 0]): Vec3 {
    const [lon, lat] = bodyToGeodetic(shape, this.p);
    const up = enu(lon, lat).up;
    for (let i = 0; i < 3; i++) out[i] = this.p[i] + up[i] * EYE_HEIGHT / 1000;
    return out;
  }

  /** Line of sight and up (body frame). */
  view(shape: Shape): { dir: Vec3; up: Vec3 } {
    const [lon, lat] = bodyToGeodetic(shape, this.p);
    const { east, north, up } = enu(lon, lat);
    const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const dir: Vec3 = [0, 0, 0], u: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const fwd = north[i] * ch + east[i] * sh;
      dir[i] = fwd * cp + up[i] * sp;
      u[i] = -fwd * sp + up[i] * cp;
    }
    return { dir, up: u };
  }

  look(dHeading: number, dPitch: number): void {
    this.heading = (this.heading + dHeading) % (2 * Math.PI);
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dPitch));
  }

  /** Advance `dt` seconds. Returns true on touching down after a jump or fall. */
  step(world: WalkWorld, dt: number, input: WalkInput): boolean {
    let landed = false;
    // Standing still while finer terrain loads, the ground under the feet moves: stay on it.
    if (this.onGround) {
      const [lon, lat] = bodyToGeodetic(world.shape, this.p);
      geodeticToBody(world.shape, lon, lat, world.ground(lon, lat), this.p);
    }
    const n = Math.max(1, Math.ceil(dt / STEP));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      landed = this.substep(world, h, input) || landed;
      input = { ...input, jump: false };
    }
    return landed;
  }

  private substep(world: WalkWorld, h: number, input: WalkInput): boolean {
    const shape = world.shape;
    const [lon, lat, height] = bodyToGeodetic(shape, this.p);
    const ground = world.ground(lon, lat);
    const frame = enu(lon, lat);
    const g = this.gravity(world);
    let landed = false;

    // Coriolis, from moving over the turning body.
    const cor = cross(world.spin, this.v);
    const a: Vec3 = [g[0] - 2 * cor[0], g[1] - 2 * cor[1], g[2] - 2 * cor[2]];

    if (this.onGround) {
      const normal = this.normal(world, lon, lat, frame);
      const slope = Math.acos(Math.min(1, dot(normal, frame.up)));
      // The ground pushes back: only the part of gravity along the slope remains.
      const into = dot(a, normal);
      for (let k = 0; k < 3; k++) a[k] -= into * normal[k];
      // Tangential velocity the feet aim for, along the ground.
      const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
      const fwd: Vec3 = [0, 0, 0], right: Vec3 = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        fwd[k] = frame.north[k] * ch + frame.east[k] * sh;
        right[k] = frame.east[k] * ch - frame.north[k] * sh;
      }
      const [mf, mr] = input.move;
      const m = Math.hypot(mf, mr);
      const pace = this.pace(world, input.run);
      const want: Vec3 = [0, 0, 0];
      if (m > 0) for (let k = 0; k < 3; k++) want[k] = ((fwd[k] * mf + right[k] * mr) / Math.max(1, m)) * pace;
      const wn = dot(want, normal);
      for (let k = 0; k < 3; k++) want[k] -= wn * normal[k];
      // Friction is all the feet have, and on steep ground they slip.
      const grip = slope < MAX_SLOPE ? FRICTION * -into : 0.5 * FRICTION * -into * Math.cos(slope);
      const target: Vec3 = slope < MAX_SLOPE ? want : [0, 0, 0];
      const dv: Vec3 = [0, 0, 0];
      for (let k = 0; k < 3; k++) dv[k] = target[k] - (this.v[k] + a[k] * h);
      const need = len(dv) / h;
      const push = Math.min(need, Math.max(grip, 0));
      for (let k = 0; k < 3; k++) a[k] += need > 0 ? (dv[k] / h) * (push / need) : 0;
      if (input.jump && slope < MAX_SLOPE) {
        // Feet leave the ground: from here on only gravity acts.
        for (let k = 0; k < 3; k++) {
          this.v[k] += normal[k] * JUMP_SPEED / 1000;
          a[k] = g[k] - 2 * cor[k];
        }
        this.onGround = false;
        this.airTime = 0;
        this.peak = 0;
        this.takeoff = height;
      }
    }

    // Exact for a steady acceleration, so a jump peaks at v^2/2g whatever the step.
    for (let k = 0; k < 3; k++) {
      this.p[k] += (this.v[k] + 0.5 * a[k] * h) * h;
      this.v[k] += a[k] * h;
    }

    const [lon2, lat2, height2] = bodyToGeodetic(shape, this.p);
    const ground2 = world.ground(lon2, lat2);
    if (!this.onGround) {
      this.airTime += h;
      this.peak = Math.max(this.peak, (height2 - this.takeoff) * 1000);
    }
    if (height2 <= ground2 + 1e-6 || (this.onGround && height2 - ground2 < 0.0003)) {
      // Feet on the ground: snap to it and drop any motion into it.
      geodeticToBody(shape, lon2, lat2, ground2, this.p);
      const up = enu(lon2, lat2).up;
      const vn = dot(this.v, up);
      if (vn < 0) for (let k = 0; k < 3; k++) this.v[k] -= vn * up[k];
      landed = !this.onGround;
      this.onGround = true;
    } else if (this.onGround && height2 - ground2 > 0.0003) {
      // Walked off an edge (or the ground fell away faster than gravity pulls).
      this.onGround = false;
      this.airTime = 0;
      this.peak = 0;
      this.takeoff = height2;
    }
    void ground;
    return landed;
  }

  /** Ground normal from heights half a metre either side. */
  private normal(world: WalkWorld, lon: number, lat: number, frame: { east: Vec3; north: Vec3; up: Vec3 }): Vec3 {
    const r = world.shape.a;
    const d = 0.0005;
    const dLat = d / r, dLon = d / (r * Math.max(0.01, Math.cos(lat)));
    const sx = (world.ground(lon + dLon, lat) - world.ground(lon - dLon, lat)) / (2 * d);
    const sy = (world.ground(lon, lat + dLat) - world.ground(lon, lat - dLat)) / (2 * d);
    const n: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) n[k] = frame.up[k] - sx * frame.east[k] - sy * frame.north[k];
    const l = len(n);
    return [n[0] / l, n[1] / l, n[2] / l];
  }
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
