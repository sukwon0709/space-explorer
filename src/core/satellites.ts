import { gstime, json2satrec, sgp4, type OMMJsonObject, type SatRec } from 'satellite.js';
import type { Vec3 } from './ephemeris';

/** One object of the CelesTrak GP snapshot (OMM fields plus the groups it came from). */
export type SatelliteElements = OMMJsonObject & { NORAD_CAT_ID: number; GROUPS?: string[] };

export interface SatelliteSnapshot {
  fetched: string;
  source: string;
  objects: SatelliteElements[];
}

export interface Satellite {
  id: number;
  name: string;
  groups: string[];
  satrec: SatRec;
  /** Element epoch, Unix ms. */
  epoch: number;
}

const MS_PER_DAY = 86400000;
const JD_UNIX_EPOCH = 2440587.5;
/** SGP4 elements are only meaningful for a few weeks either side of their epoch. */
export const ELEMENT_VALIDITY_DAYS = 30;

export function parseSatellites(objects: SatelliteElements[]): Satellite[] {
  const out: Satellite[] = [];
  for (const o of objects) {
    try {
      const satrec = json2satrec(o);
      out.push({ id: o.NORAD_CAT_ID, name: o.OBJECT_NAME, groups: o.GROUPS ?? [], satrec, epoch: (satrec.jdsatepoch - JD_UNIX_EPOCH) * MS_PER_DAY });
    } catch {
      // Malformed elements: leave the object out.
    }
  }
  return out;
}

/**
 * Earth-fixed position (km) of a satellite at a UTC instant, or false when its elements
 * are too far from that instant or SGP4 fails (decayed). SGP4 gives TEME coordinates;
 * turning them by Greenwich mean sidereal time gives the pseudo Earth-fixed frame,
 * which differs from ITRF only by polar motion (about 10 m) and UT1 - UTC (under
 * 0.9 s of Earth rotation, at most 0.4 km), both below SGP4's own error.
 */
export function earthFixedPosition(sat: Satellite, unixMs: number, out: Vec3): boolean {
  if (Math.abs(unixMs - sat.epoch) > ELEMENT_VALIDITY_DAYS * MS_PER_DAY) return false;
  const result = sgp4(sat.satrec, (unixMs - sat.epoch) / 60000);
  if (!result || typeof result.position !== 'object') return false;
  const { x, y, z } = result.position;
  const g = gstime(unixMs / MS_PER_DAY + JD_UNIX_EPOCH);
  const c = Math.cos(g), s = Math.sin(g);
  out[0] = c * x + s * y;
  out[1] = -s * x + c * y;
  out[2] = z;
  return Number.isFinite(out[0] + out[1] + out[2]);
}

/** Orbital period in minutes. */
export function periodMinutes(sat: Satellite): number {
  return (2 * Math.PI) / sat.satrec.no;
}
