import type { Mat3 } from './orientation';
import { OBLIQUITY_J2000 } from './frames';
import rotation from '../generated/rotation.json';

/**
 * IAU WGCCRE 2015 rotation models (pole right ascension and declination, prime
 * meridian angle W), as NAIF's pck00011.tpc gives them; see pipeline/build_rotation.py.
 * Earth and the Moon use measured orientation instead (orientation.ts).
 */

interface RotationEntry {
  radii?: number[];
  ra?: number[];
  dec?: number[];
  pm?: number[];
  nut_prec_ra?: number[];
  nut_prec_dec?: number[];
  nut_prec_pm?: number[];
}

const DEG = Math.PI / 180;
const DAY = 86400;
const CENTURY = 36525 * DAY;
const table = rotation as unknown as { bodies: Record<string, RotationEntry>; systems: Record<string, { degree: number; angles: number[] }> };

/** Triaxial radii (km) from the PCK, or undefined. */
export function pckRadii(id: number): [number, number, number] | undefined {
  const r = table.bodies[String(id)]?.radii as number[] | undefined;
  return r ? [r[0], r[1], r[2]] : undefined;
}

export function hasRotation(id: number): boolean {
  return table.bodies[String(id)]?.pm !== undefined;
}

const poly = (c: number[], x: number) => c[0] + c[1] * x + (c[2] ?? 0) * x * x;

/** Pole RA, Dec and prime meridian W (radians) at a TDB epoch (seconds past J2000). */
export function rotationAngles(id: number, tdb: number): [number, number, number] {
  const e = table.bodies[String(id)];
  if (!e?.pm || !e.ra || !e.dec) throw new Error(`No rotation model for body ${id}`);
  const T = tdb / CENTURY;
  const d = tdb / DAY;
  let ra = poly(e.ra, T);
  let dec = poly(e.dec, T);
  let w = poly(e.pm, d);
  // Planet ids (x99) and their moons share their system's nutation-precession angles.
  const system = id < 1000 ? table.systems[String(Math.floor(id / 100))] : undefined;
  if (system && (e.nut_prec_ra || e.nut_prec_dec || e.nut_prec_pm)) {
    const step = system.degree + 1;
    const n = system.angles.length / step;
    for (let i = 0; i < n; i++) {
      let theta = 0;
      for (let k = system.degree; k >= 0; k--) theta = theta * T + system.angles[i * step + k];
      theta *= DEG;
      const s = Math.sin(theta), c = Math.cos(theta);
      ra += (e.nut_prec_ra?.[i] ?? 0) * s;
      dec += (e.nut_prec_dec?.[i] ?? 0) * c;
      w += (e.nut_prec_pm?.[i] ?? 0) * s;
    }
  }
  return [ra * DEG, dec * DEG, w * DEG];
}

/** ICRF -> body-fixed rotation: R3(W) R1(90 - dec) R3(90 + ra), row-major. */
export function iauIcrfToBody(id: number, tdb: number, out: Mat3 = new Float64Array(9)): Mat3 {
  const [ra, dec, w] = rotationAngles(id, tdb);
  return eulerMatrix(ra, dec, w, out);
}

/** ICRF -> body-fixed rotation from pole RA/Dec and prime meridian angle W (radians). */
export function eulerMatrix(ra: number, dec: number, w: number, out: Mat3 = new Float64Array(9)): Mat3 {
  // 3-1-3 Euler angles (phi, theta, psi) = (90 + ra, 90 - dec, W), as SPICE's eul2m.
  const phi = Math.PI / 2 + ra, theta = Math.PI / 2 - dec, psi = w;
  const cf = Math.cos(phi), sf = Math.sin(phi);
  const ct = Math.cos(theta), st = Math.sin(theta);
  const cp = Math.cos(psi), sp = Math.sin(psi);
  out[0] = cp * cf - sp * ct * sf;
  out[1] = cp * sf + sp * ct * cf;
  out[2] = sp * st;
  out[3] = -sp * cf - cp * ct * sf;
  out[4] = -sp * sf + cp * ct * cf;
  out[5] = cp * st;
  out[6] = st * sf;
  out[7] = -st * cf;
  out[8] = ct;
  return out;
}

const COS_E = Math.cos(OBLIQUITY_J2000);
const SIN_E = Math.sin(OBLIQUITY_J2000);
const scratch = new Float64Array(9);

/** Body-fixed -> scene axes (ecliptic J2000, y up), row-major; matches Orientation.bodyToScene. */
export function iauBodyToScene(id: number, tdb: number, out: Mat3 = new Float64Array(9)): Mat3 {
  return icrfToBodyAsScene(iauIcrfToBody(id, tdb, scratch), out);
}

/** Turn an ICRF -> body rotation into body -> scene axes. */
export function icrfToBodyAsScene(m: Mat3, out: Mat3 = new Float64Array(9)): Mat3 {
  for (let j = 0; j < 3; j++) {
    const x = m[j * 3], y = m[j * 3 + 1], z = m[j * 3 + 2];
    out[j] = x;
    out[3 + j] = -SIN_E * y + COS_E * z;
    out[6 + j] = -(COS_E * y + SIN_E * z);
  }
  return out;
}
