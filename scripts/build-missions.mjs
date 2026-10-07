// Writes src/generated/missions.json: each mission's span and its moments, the closest
// approaches to the bodies listed in src/ui/missions.ts, found in the Horizons
// trajectories (public/data/missions/) against the app's own ephemeris (DE440 and the
// moon files), plus the dated moments listed there by hand.
//
//   node scripts/build-missions.mjs
//
// The TypeScript sources load through Vite's module runner, as the app and tests do.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, createServerModuleRunner } from 'vite';

const root = new URL('..', import.meta.url);
const server = await createServer({ root: root.pathname, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
try {
  const { Ephemeris } = await runner.import('/src/core/ephemeris.ts');
  const { Trajectory, approaches } = await runner.import('/src/core/mission.ts');
  const { MISSIONS } = await runner.import('/src/ui/missions.ts');
  const { bodyById } = await runner.import('/src/core/bodies.ts');
  const { GM } = await runner.import('/src/core/gravity.ts');
  const { utcToTdb, tdbToUtc } = await runner.import('/src/core/time.ts');

  const load = (name) => {
    const f = readFileSync(new URL(`public/data/${name}`, root));
    return f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength);
  };
  const ephemeris = new Ephemeris(load('de440.bin'));
  for (const name of ['mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']) ephemeris.add(load(`moons-${name}.bin`));
  const iso = (tdb) => new Date(Math.round(tdbToUtc(tdb) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;

  const out = {};
  for (const m of MISSIONS) {
    const file = new URL(`public/data/missions/${m.slug}.bin`, root);
    if (!existsSync(file)) {
      console.warn(`${m.slug}: no trajectory yet`);
      continue;
    }
    const traj = new Trajectory(load(`missions/${m.slug}.bin`));
    const at = (id, t, o) => ephemeris.position(id, t, o);
    const sun = (t, o) => ephemeris.position(10, t, o);
    const helioSpeed = (t) => {
      const v = traj.velocity(t, at), a = sun(t, [0, 0, 0]), b = sun(t + 1, [0, 0, 0]);
      return Math.hypot(v[0] - (b[0] - a[0]), v[1] - (b[1] - a[1]), v[2] - (b[2] - a[2]));
    };
    const moments = [];
    for (const [id, within] of m.encounters) {
      // Only where the body's ephemeris covers the mission.
      const [from, to] = ephemeris.coverage(id);
      const name = bodyById(id).name;
      const radius = bodyById(id).radius[0];
      // Not the launch itself, and not the last rows of a craft that ended inside the
      // body (Galileo, Cassini: Horizons runs on past the entry).
      const found = approaches(traj, id, at, within, Math.max(traj.start, from), Math.min(traj.end, to))
        .filter((a) => a.tdb > traj.start + 7200 && a.distance > radius);
      // Passes slower than escape speed are periapses of an orbit around the body.
      const APSIS = { 10: 'Perihelion', 399: 'Perigee', 301: 'Perilune', 599: 'Perijove', 699: 'Perikrone' };
      const bound = found.filter((a) => a.speed < Math.sqrt((2 * GM[id]) / a.distance));
      let n = 0;
      found.forEach((a, k) => {
        const planet = id % 100 === 99 || id === 10;
        const isBound = bound.includes(a);
        const repeated = isBound && bound.length > 3;
        if (isBound) n++;
        // Gravity assists: speed around the Sun before and after the pass, taken where
        // the spacecraft is twice the counting distance away (or at the ends of the data).
        let assist;
        if (planet && id !== 10 && !isBound && !bound.some((b) => b.tdb > a.tdb)) {
          const span = Math.min(60 * 86400, (2 * within) / a.speed);
          const t0 = Math.max(traj.start, a.tdb - span), t1 = Math.min(traj.end, a.tdb + span);
          assist = [round(helioSpeed(t0), 2), round(helioSpeed(t1), 2)];
        }
        const apsis = APSIS[id] ?? `Closest to ${name}`;
        // An unbound pass followed by orbits is the arrival (the insertion burn comes after).
        const arrival = !isBound && bound.some((b) => b.tdb > a.tdb);
        const title = arrival ? `Arrives at ${name}` : !isBound ? `${name} flyby` : repeated ? `${apsis} ${n}` : apsis;
        moments.push({
          tdb: round(a.tdb, 1), utc: iso(a.tdb), body: id, title,
          distance: round(a.distance, 1), altitude: round(a.distance - radius, 1), speed: round(a.speed, 3),
          ...(assist ? { assist } : {}),
          key: !repeated || n === 1 || n === bound.length || id === 10 ? true : undefined,
        });
      });
    }
    for (const [utc, title] of m.extra ?? []) {
      const tdb = utcToTdb(Date.parse(utc));
      if (tdb >= traj.start && tdb <= traj.end) moments.push({ tdb: round(tdb, 1), utc, title, key: true });
    }
    moments.sort((a, b) => a.tdb - b.tdb);
    for (const x of moments) if (x.key === undefined) delete x.key;
    out[m.slug] = { start: round(traj.start, 1), end: round(traj.end, 1), rows: traj.length, moments };
    console.log(`${m.slug}: ${moments.length} moments (${moments.filter((x) => x.key).length} key)`);
    for (const x of moments.filter((x) => x.key && x.body !== undefined).slice(0, 12)) {
      console.log(`  ${x.utc} ${x.title}: ${Math.round(x.distance).toLocaleString('en-US')} km, ${x.speed.toFixed(2)} km/s${x.assist ? `, Sun-relative ${x.assist[0]} -> ${x.assist[1]} km/s` : ''}`);
    }
  }
  writeFileSync(new URL('src/generated/missions.json', root), JSON.stringify(out));
  console.log('wrote src/generated/missions.json');
} finally {
  await server.close();
}
