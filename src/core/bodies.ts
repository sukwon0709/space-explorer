/**
 * Bodies drawn in milestone 1. Radii are IAU WGCCRE 2015 values (km); pole directions
 * are the IAU J2000 right ascension / declination of each north pole (degrees).
 *
 * DE421 has no planet-centre segments for Jupiter through Pluto, so those use their
 * system barycentres. The offset is small for the giants (Jupiter's is under a few
 * hundred km) but about 2,100 km for Pluto, because Charon is massive.
 */

export interface Body {
  id: number;
  name: string;
  /** Equatorial and polar radius, km. */
  radius: [number, number];
  /** North pole RA/Dec, degrees (J2000). */
  pole: [number, number];
  /** Approximate visual colour, used until surface maps arrive in milestone 2. */
  color: string;
  /** Body the orbit line is drawn around (NAIF id), and orbital period in days. */
  orbit?: { around: number; periodDays: number };
  emissive?: boolean;
}

export const BODIES: Body[] = [
  { id: 10, name: 'Sun', radius: [695700, 695700], pole: [286.13, 63.87], color: '#fff4e0', emissive: true },
  { id: 199, name: 'Mercury', radius: [2440.53, 2438.26], pole: [281.0103, 61.4155], color: '#9a9590', orbit: { around: 10, periodDays: 87.969 } },
  { id: 299, name: 'Venus', radius: [6051.8, 6051.8], pole: [272.76, 67.16], color: '#e8dcb5', orbit: { around: 10, periodDays: 224.701 } },
  { id: 399, name: 'Earth', radius: [6378.137, 6356.752], pole: [0, 90], color: '#4a78b5', orbit: { around: 10, periodDays: 365.256 } },
  { id: 301, name: 'Moon', radius: [1738.1, 1736.0], pole: [269.9949, 66.5392], color: '#a9a59e', orbit: { around: 399, periodDays: 27.3217 } },
  { id: 499, name: 'Mars', radius: [3396.19, 3376.2], pole: [317.269202, 54.432516], color: '#c1673f', orbit: { around: 10, periodDays: 686.98 } },
  { id: 5, name: 'Jupiter', radius: [71492, 66854], pole: [268.056595, 64.495303], color: '#d8c3a0', orbit: { around: 10, periodDays: 4332.59 } },
  { id: 6, name: 'Saturn', radius: [60268, 54364], pole: [40.589, 83.537], color: '#e3d3a4', orbit: { around: 10, periodDays: 10759.22 } },
  { id: 7, name: 'Uranus', radius: [25559, 24973], pole: [257.311, -15.175], color: '#a8d8e0', orbit: { around: 10, periodDays: 30685.4 } },
  { id: 8, name: 'Neptune', radius: [24764, 24341], pole: [299.36, 43.46], color: '#5b7fd1', orbit: { around: 10, periodDays: 60189 } },
  { id: 9, name: 'Pluto', radius: [1188.3, 1188.3], pole: [132.993, -6.163], color: '#c9b49a', orbit: { around: 10, periodDays: 90560 } },
];

/**
 * Saturn's main rings, km from Saturn's centre, with normal optical depth bands
 * (Cassini radio occultation summaries; values rounded). Drawn in Saturn's equator plane.
 */
export const SATURN_RINGS: Array<{ name: string; inner: number; outer: number; opacity: number }> = [
  { name: 'C ring', inner: 74658, outer: 92000, opacity: 0.12 },
  { name: 'B ring', inner: 92000, outer: 117580, opacity: 0.9 },
  { name: 'Cassini Division', inner: 117580, outer: 122170, opacity: 0.08 },
  { name: 'A ring', inner: 122170, outer: 136775, opacity: 0.55 },
];

export function bodyById(id: number): Body {
  const body = BODIES.find((b) => b.id === id);
  if (!body) throw new Error(`Unknown body ${id}`);
  return body;
}
