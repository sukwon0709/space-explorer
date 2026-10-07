// Writes src/generated/events.json: solar and lunar eclipses, transits of Mercury and
// Venus, Phobos transits seen by Perseverance, and close approaches, 1960-2060, all
// computed with the app's own ephemeris and Earth orientation (src/core/skyevents.ts).
//
//   node scripts/build-events.mjs
//
// The TypeScript sources load through Vite's module runner, as the app and tests do.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, createServerModuleRunner } from 'vite';

const root = new URL('..', import.meta.url);
const server = await createServer({ root: root.pathname, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
try {
  const { Ephemeris } = await runner.import('/src/core/ephemeris.ts');
  const { Orientation } = await runner.import('/src/core/orientation.ts');
  const { SkyEvents, phobosTransits, PERSEVERANCE } = await runner.import('/src/core/skyevents.ts');
  const { Track } = await runner.import('/src/core/track.ts');
  const { utcToTdb, tdbToUtc } = await runner.import('/src/core/time.ts');

  const load = (name) => {
    const f = readFileSync(new URL(`public/data/${name}`, root));
    return f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength);
  };
  const ephemeris = new Ephemeris(load('de440.bin'));
  ephemeris.add(load('moons-mars.bin'));
  const orientation = new Orientation(new Ephemeris(load('orientation.bin')));
  const sky = new SkyEvents(ephemeris, orientation);

  const start = utcToTdb(Date.UTC(1960, 0, 1)), end = utcToTdb(Date.UTC(2060, 11, 31, 23, 59, 59));
  /** UTC ISO to 0.1 s. */
  const iso = (tdb) => new Date(Math.round(tdbToUtc(tdb) / 100) * 100).toISOString().replace(/(\.\d)00Z$/, '$1Z');
  const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;

  const solar = sky.solarEclipses(start, end).map((e) => ({
    type: e.type, greatest: iso(e.tdb), lat: round(e.lat, 3), lon: round(e.lon, 3),
    gamma: round(e.gamma, 4), magnitude: round(e.magnitude, 4),
    ...(e.duration ? { duration: round(e.duration, 1) } : {}), sunAlt: round(e.sunAlt, 1),
  }));
  const lunar = sky.lunarEclipses(start, end).map((e) => ({
    type: e.type, greatest: iso(e.tdb), umbral: round(e.umbral, 4), penumbral: round(e.penumbral, 4),
    ...(e.partialDuration ? { partial: round(e.partialDuration, 1) } : {}),
    ...(e.totalDuration ? { total: round(e.totalDuration, 1) } : {}),
    lat: round(e.lat, 2), lon: round(e.lon, 2),
  }));
  const names = { 199: 'Mercury', 299: 'Venus' };
  const transits = [199, 299]
    .flatMap((b) => sky.transits(b, start, end))
    .map((t) => ({
      body: names[t.body], observer: 'Earth', greatest: iso(t.tdb), separation: round(t.separation, 1),
      contacts: t.contacts.map(iso), lat: round(t.lat, 2), lon: round(t.lon, 2),
    }));
  // Phobos from Perseverance's landing site, the days around the 2 April 2022 transit it filmed.
  const site = PERSEVERANCE;
  for (const t of phobosTransits(ephemeris, site, utcToTdb(Date.UTC(2022, 2, 28)), utcToTdb(Date.UTC(2022, 3, 8)))) {
    transits.push({
      body: 'Phobos', observer: { body: 'Mars', lat: site.lat, lon: site.lon, site: site.name },
      greatest: iso(t.tdb), separation: round(t.separation, 1), contacts: t.contacts.map(iso),
    });
  }
  transits.sort((a, b) => (a.greatest < b.greatest ? -1 : 1));

  const approaches = readdirSync(new URL('public/data/events/', root))
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const json = JSON.parse(readFileSync(new URL(`public/data/events/${file}`, root), 'utf8'));
      const c = new Track(json).closest();
      return {
        name: json.name, designation: json.designation, comet: json.comet,
        closest: iso(c.tdb), distance: Math.round(c.distance), speed: round(c.speed, 2), track: file,
      };
    })
    .sort((a, b) => (a.closest < b.closest ? -1 : 1));

  const out = { solar, lunar, transits, approaches };
  writeFileSync(new URL('src/generated/events.json', root), JSON.stringify(out) + '\n');
  const count = (list, key) => list.reduce((m, e) => ((m[e[key]] = (m[e[key]] ?? 0) + 1), m), {});
  console.log('solar', solar.length, count(solar, 'type'));
  console.log('lunar', lunar.length, count(lunar, 'type'));
  console.log('transits', transits.length, count(transits, 'body'));
  console.log('approaches', approaches.length);
} finally {
  await runner.close();
  await server.close();
}
