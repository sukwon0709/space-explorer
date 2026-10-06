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
  /** Face the Sun from the ground point and keep it in view as it moves across the sky. */
  aimSun?: boolean;
  /** Vertical field of view, degrees (default 50). */
  fov?: number;
  /** A visitor on a close pass: its Horizons track (public/data/events/) and name. */
  visitor?: { track: string; name: string; comet: boolean };
  /** One line on what to watch, shown when the event starts. */
  note?: string;
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

// ---- the catalogue: every eclipse, transit and close approach, 1960-2060 -------------

/** src/generated/events.json, written by scripts/build-events.mjs (see skyevents.ts). */
export interface EventCatalogue {
  solar: Array<{ type: string; greatest: string; lat: number; lon: number; magnitude: number; duration?: number; sunAlt: number }>;
  lunar: Array<{ type: string; greatest: string; umbral: number; penumbral: number; partial?: number; total?: number }>;
  transits: Array<{ body: string; observer: string | { body: string; lat: number; lon: number; site: string }; greatest: string; contacts: string[]; lat?: number; lon?: number }>;
  approaches: Array<{ name: string; designation: string; comet: boolean; closest: string; distance: number; speed: number; track: string }>;
}

export interface EventGroup {
  label: string;
  events: SkyEvent[];
}

const at = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const minutes = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);
const place = (lat: number, lon: number) => `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
const capital = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * Every event in the catalogue as a view: central solar eclipses from the ground where
 * the eclipse is greatest, facing the Sun; partial ones (and central ones near the
 * horizon) from space, over the shadow; lunar eclipses from the Earth side of the Moon;
 * transits through a white-light solar filter from where the Sun is overhead; close
 * approaches from far enough out to see the whole pass.
 */
export function eventGroups(cat: EventCatalogue, minUtc: number, maxUtc: number): EventGroup[] {
  const solar: SkyEvent[] = cat.solar.map((e) => {
    const central = e.type !== 'partial' && e.sunAlt > 8;
    const name = `${capital(e.type)} solar eclipse · ${day(e.greatest)}`;
    if (central) {
      const half = (e.duration ?? 60) / 2;
      return {
        title: `${name} · ${minutes(e.duration ?? 0)}`, utc: at(e.greatest, -half - 30), rate: 1, focus: 'Earth', dist: 0.05,
        lat: e.lat, lon: e.lon, tilt: 4, aimSun: true, fov: e.type === 'annular' ? 4 : 6,
        note: `${capital(e.type)} eclipse at ${place(e.lat, e.lon)}, where it is greatest: ${minutes(e.duration ?? 0)} of ${e.type === 'annular' ? 'the ring' : 'totality'}`,
      };
    }
    return {
      title: name, utc: at(e.greatest, -45 * 60), rate: 60, focus: 'Earth', dist: 12000, lat: e.lat, lon: e.lon, heading: 0, tilt: 88,
      note: `The Moon's shadow crossing Earth; greatest eclipse at ${e.greatest.slice(11, 16)} UTC, magnitude ${e.magnitude.toFixed(2)}`,
    };
  });
  const lunar: SkyEvent[] = cat.lunar.map((e) => {
    const span = e.type === 'penumbral' ? 2 * 3600 : (e.partial ?? 3600) / 2 + 15 * 60;
    return {
      title: `${capital(e.type)} lunar eclipse · ${day(e.greatest)}`, utc: at(e.greatest, -span), rate: 300, focus: 'Moon',
      dist: 9000, lat: 0, lon: 0, heading: 0, tilt: 88,
      note: e.type === 'total' ? `The Moon turns red in Earth's shadow: ${minutes(e.total ?? 0)} of totality` : `Umbral magnitude ${e.umbral.toFixed(2)}; greatest at ${e.greatest.slice(11, 16)} UTC`,
    };
  });
  const transits: SkyEvent[] = cat.transits.map((e) => {
    if (typeof e.observer !== 'string') {
      // Phobos from Perseverance's landing site: a half-minute annular eclipse.
      const start = e.contacts[0];
      return {
        title: `Phobos crosses the Sun, from Jezero crater · ${day(e.greatest)}`, utc: at(start, -15), rate: 1, focus: 'Mars', dist: 0.002,
        lat: e.observer.lat, lon: e.observer.lon, tilt: 2, aimSun: true, fov: 0.9,
        note: `Phobos in front of the Sun, as Perseverance filmed it: ${minutes((Date.parse(e.contacts[e.contacts.length - 1]) - Date.parse(start)) / 1000)}`,
      };
    }
    const duration = (Date.parse(e.contacts[e.contacts.length - 1]) - Date.parse(e.contacts[0])) / 1000;
    return {
      title: `Transit of ${e.body} · ${day(e.greatest)}`, utc: at(e.contacts[0], -120), rate: 300, focus: 'Earth', dist: 0.05,
      lat: e.lat, lon: e.lon, tilt: 4, aimSun: true, fov: e.body === 'Venus' ? 0.8 : 0.7,
      note: `${e.body} crosses the Sun, through a solar filter: ${(duration / 3600).toFixed(1)} hours, sped up 300 times`,
    };
  });
  const approaches: SkyEvent[] = cat.approaches.map((e) => {
    // Long enough before closest approach to see it coming, at a rate that shows it in about a minute.
    const window = Math.max(2 * 3600, Math.min(20 * 86400, (12 * e.distance) / e.speed));
    return {
      title: `${e.name} passes Earth · ${day(e.closest)}`, utc: at(e.closest, -window / 2), rate: Math.round(window / 60), focus: 'Earth',
      dist: 3 * e.distance, heading: 0, tilt: 20, visitor: { track: e.track, name: e.name, comet: e.comet },
      note: `${e.name} at ${e.distance.toLocaleString('en-US')} km from Earth's centre, ${e.speed.toFixed(1)} km/s`,
    };
  });
  const inRange = (list: SkyEvent[]) => list.filter((e) => {
    const t = Date.parse(e.utc);
    return t >= minUtc && t <= maxUtc;
  });
  return [
    { label: 'Highlights', events: inRange([...EVENTS, ...transits.filter((e) => e.title.startsWith('Phobos')).slice(0, 1), ...approaches.filter((e) => e.title.includes('Apophis'))]) },
    { label: 'Solar eclipses', events: inRange(solar) },
    { label: 'Lunar eclipses', events: inRange(lunar) },
    { label: 'Transits', events: inRange(transits) },
    { label: 'Close approaches', events: inRange(approaches) },
  ];
}
