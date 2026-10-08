import type { Vec3 } from './ephemeris';

/**
 * Gravity assists and tides: the two-body arithmetic behind the flight display.
 *
 * Inside a body's sphere of influence the path is close to a conic about it. On a
 * hyperbola the speed relative to the body is the same going out as coming in (v∞),
 * but its direction turns by δ, with sin(δ/2) = 1/e. Relative to the body's own parent
 * (the Sun, for a planet) that turn is a change of speed: the gravity assist. Passing
 * behind a planet (on its trailing side) the turn adds the planet's motion to the
 * ship's; passing in front, it takes it away.
 */

/** A pass by a body, from the ship's state relative to it. */
export interface Encounter {
  /** Periapsis distance from the centre, km. */
  peri: number;
  e: number;
  /** Speed far from the body, km/s. */
  vInf: number;
  /** How far the body bends the path, radians. */
  turn: number;
  /** Seconds until periapsis (negative once past it). */
  toPeri: number;
  /** Velocity relative to the body far before and far after the pass (km/s). */
  vIn: Vec3;
  vOut: Vec3;
}

/** The hyperbolic pass the ship is on about a mass `gm`; undefined if it is bound (or falling straight in). */
export function encounter(rel: Vec3, vel: Vec3, gm: number): Encounter | undefined {
  const r = length(rel);
  const v2 = dot(vel, vel);
  const energy = v2 / 2 - gm / r;
  if (!(energy > 0)) return undefined;
  const h = cross(rel, vel);
  const hl = length(h);
  if (hl < 1e-9 * r * Math.sqrt(v2)) return undefined;
  const vInf = Math.sqrt(2 * energy);
  const vh = cross(vel, h);
  const eVec: Vec3 = [vh[0] / gm - rel[0] / r, vh[1] / gm - rel[1] / r, vh[2] / gm - rel[2] / r];
  const e = length(eVec);
  const a = gm / (vInf * vInf); // |a|
  const peri = a * (e - 1);
  // Directions in the plane of the path: P to periapsis, Q along the motion there.
  const P: Vec3 = [eVec[0] / e, eVec[1] / e, eVec[2] / e];
  const n: Vec3 = [h[0] / hl, h[1] / hl, h[2] / hl];
  const Q = cross(n, P);
  // True anomaly of the asymptotes: cos ν∞ = -1/e.
  const cosInf = -1 / e, sinInf = Math.sqrt(1 - cosInf * cosInf);
  const vIn: Vec3 = [0, 0, 0], vOut: Vec3 = [0, 0, 0];
  // Velocity on a conic goes as -sin ν P + (e + cos ν) Q: its direction at ν = ∓ν∞.
  const dirIn = unit([sinInf * P[0] + (e + cosInf) * Q[0], sinInf * P[1] + (e + cosInf) * Q[1], sinInf * P[2] + (e + cosInf) * Q[2]]);
  const dirOut = unit([-sinInf * P[0] + (e + cosInf) * Q[0], -sinInf * P[1] + (e + cosInf) * Q[1], -sinInf * P[2] + (e + cosInf) * Q[2]]);
  for (let k = 0; k < 3; k++) {
    vIn[k] = vInf * dirIn[k];
    vOut[k] = vInf * dirOut[k];
  }
  // Time from periapsis: r = a (e cosh F - 1), M = e sinh F - F = t sqrt(gm / a^3).
  const coshF = Math.max(1, (r / a + 1) / e);
  const F = Math.acosh(coshF) * (dot(rel, vel) >= 0 ? 1 : -1);
  const since = (e * Math.sinh(F) - F) * Math.sqrt((a * a * a) / gm);
  return { peri, e, vInf, turn: 2 * Math.asin(Math.min(1, 1 / e)), toPeri: -since, vIn, vOut };
}

/**
 * A flyby set up to gain speed: the ship `d0` km from a body of mass `gm`, coming in at
 * `vInf` km/s on a hyperbola that passes `peri` km from its centre behind it (on the
 * side the body moves away from, `ahead` a unit vector along its motion), in the plane
 * with normal `normal`. Returns the ship's position and velocity relative to the body.
 */
export function flybyStart(gm: number, peri: number, vInf: number, ahead: Vec3, normal: Vec3, d0: number): { rel: Vec3; vel: Vec3 } {
  const e = 1 + (peri * vInf * vInf) / gm;
  const p = peri * (1 + e);
  // Periapsis behind the body: there its pull points along its motion, and so does the kick.
  const P: Vec3 = [-ahead[0], -ahead[1], -ahead[2]];
  const Q = unit(cross(normal, P));
  const cosNu = Math.max(-1, Math.min(1, (p / Math.max(d0, peri) - 1) / e));
  const nu = -Math.acos(cosNu); // still on the way in
  const r = p / (1 + e * cosNu);
  const s = Math.sqrt(gm / p);
  const rel: Vec3 = [0, 0, 0], vel: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    rel[k] = r * (Math.cos(nu) * P[k] + Math.sin(nu) * Q[k]);
    vel[k] = s * (-Math.sin(nu) * P[k] + (e + Math.cos(nu)) * Q[k]);
  }
  return { rel, vel };
}

/**
 * The strongest stretch in a tidal tensor (xx, yy, zz, xy, xz, yz; 1/s^2): its size and
 * axis (unit, scene axes), and the squeeze across it.
 */
export function stretch(T: number[]): { along: number; axis: Vec3; across: number } {
  // Power iteration on T + cI, with c large enough that the biggest eigenvalue dominates.
  const c = Math.abs(T[0]) + Math.abs(T[1]) + Math.abs(T[2]) + 2 * (Math.abs(T[3]) + Math.abs(T[4]) + Math.abs(T[5]));
  if (!(c > 0)) return { along: 0, axis: [1, 0, 0], across: 0 };
  let v: Vec3 = [0.57735, 0.57735, 0.57735];
  // Start along the largest diagonal so a symmetric start can't miss the axis.
  const big = T[0] >= T[1] && T[0] >= T[2] ? 0 : T[1] >= T[2] ? 1 : 2;
  v[big] += 1;
  v = unit(v);
  let along = 0;
  for (let i = 0; i < 60; i++) {
    const w: Vec3 = [
      (T[0] + c) * v[0] + T[3] * v[1] + T[4] * v[2],
      T[3] * v[0] + (T[1] + c) * v[1] + T[5] * v[2],
      T[4] * v[0] + T[5] * v[1] + (T[2] + c) * v[2],
    ];
    along = dot(w, v) - c;
    v = unit(w);
  }
  // The trace is the sum of the eigenvalues: zero in empty space (Laplace).
  const across = (T[0] + T[1] + T[2] - along) / 2;
  return { along, axis: v, across };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function unit(v: Vec3): Vec3 {
  const l = length(v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
