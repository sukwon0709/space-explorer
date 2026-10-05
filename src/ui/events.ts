/**
 * Events the time bar can jump to. Times were found with the app's own ephemeris and
 * eclipse code (DE440, IERS Earth orientation) and agree with NASA's eclipse
 * predictions (eclipse.gsfc.nasa.gov) to within a few seconds.
 */
export interface SkyEvent {
  title: string;
  /** When to start, UTC. */
  utc: string;
  /** Clock rate to start at, simulated seconds per second. */
  rate: number;
  focus: string;
  /** Camera distance, km, and (for Earth and the Moon) the ground point to look from or at. */
  dist: number;
  lat?: number;
  lon?: number;
  /** Heading and tilt of the camera, degrees (see the URL parameters in main.ts). */
  heading?: number;
  tilt?: number;
  /** Face the Sun from the ground point (sets heading and how far the view turns up). */
  aimSun?: boolean;
  /** Vertical field of view, degrees (default 50). */
  fov?: number;
}

export const EVENTS: SkyEvent[] = [
  // Totality at Luxor: 10:02:07 to 10:08:28 UTC (6 min 21 s), the Sun 80 degrees up.
  { title: 'Total solar eclipse from Luxor · 2 Aug 2027', utc: '2027-08-02T10:01:45Z', rate: 1, focus: 'Earth', dist: 0.05, lat: 25.6989, lon: 32.6421, tilt: 4, aimSun: true, fov: 5 },
  { title: "Moon's shadow over Egypt · 2 Aug 2027", utc: '2027-08-02T09:58:00Z', rate: 60, focus: 'Earth', dist: 9000, lat: 25.75, lon: 32.79, heading: 0, tilt: 88 },
  // Totality at Burgos: 18:28:26 to 18:30:10 UTC, the Sun low in the west.
  { title: 'Total solar eclipse from Burgos · 12 Aug 2026', utc: '2026-08-12T18:28:05Z', rate: 1, focus: 'Earth', dist: 0.05, lat: 42.3439, lon: -3.6969, tilt: 4, aimSun: true, fov: 12 },
  // Greatest eclipse 11:34 UTC.
  { title: 'Total lunar eclipse · 3 Mar 2026', utc: '2026-03-03T10:40:00Z', rate: 300, focus: 'Moon', dist: 9000, lat: 0, lon: 0, heading: 0, tilt: 88 },
  // Greatest eclipse 16:53 UTC.
  { title: 'Total lunar eclipse · 31 Dec 2028', utc: '2028-12-31T16:00:00Z', rate: 300, focus: 'Moon', dist: 9000, lat: 0, lon: 0, heading: 0, tilt: 88 },
  // Io's shadow crosses the middle of Jupiter's disc (as seen from the Sun) at 10:19 UTC.
  { title: "Io's shadow on Jupiter · 7 Oct 2026", utc: '2026-10-07T09:30:00Z', rate: 300, focus: 'Jupiter', dist: 330000 },
  { title: "Saturn's rings in Cassini's last summer · 15 Jun 2017", utc: '2017-06-15T00:00:00Z', rate: 3600, focus: 'Saturn', dist: 420000 },
];
