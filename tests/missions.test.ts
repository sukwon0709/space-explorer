import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ephemeris, type Vec3 } from '../src/core/ephemeris';
import { Trajectory, approaches } from '../src/core/mission';
import { MISSIONS } from '../src/ui/missions';
import { utcToTdb } from '../src/core/time';
import moments from '../src/generated/missions.json';
import reference from './fixtures/missions-reference.json';

const load = (name: string) => {
  const f = readFileSync(new URL(`../public/data/${name}`, import.meta.url));
  return f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength);
};
const ephemeris = new Ephemeris(load('de440.bin'));
for (const name of ['mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']) ephemeris.add(load(`moons-${name}.bin`));
const at = (id: number, t: number, out: Vec3) => ephemeris.position(id, t, out);
const trajectories = new Map<string, Trajectory>();
const trajectory = (slug: string) => {
  if (!trajectories.has(slug)) trajectories.set(slug, new Trajectory(load(`missions/${slug}.bin`)));
  return trajectories.get(slug)!;
};

describe('Spacecraft: trajectories', () => {
  it('ships a trajectory and its moments for every mission', () => {
    for (const m of MISSIONS) {
      expect(existsSync(new URL(`../public/data/missions/${m.slug}.bin`, import.meta.url)), m.slug).toBe(true);
      expect((moments as Record<string, unknown>)[m.slug], m.slug).toBeDefined();
    }
  });

  it('matches Horizons within 1 km between its rows', () => {
    let worst = 0;
    for (const r of reference) {
      const traj = trajectory(r.slug);
      expect(traj.centre(r.tdb), `${r.slug} at ${r.tdb}`).toBe(r.centre);
      const p = traj.relative(r.tdb);
      const err = Math.hypot(p[0] - r.position[0], p[1] - r.position[1], p[2] - r.position[2]);
      worst = Math.max(worst, err);
      expect(err, `${r.slug} at ${r.tdb}`).toBeLessThan(1);
    }
    expect(reference.length).toBeGreaterThan(100);
    expect(worst).toBeGreaterThan(0);
  });

  it('switches centre at the edge of a sphere of influence with no visible jump', () => {
    // Horizons' cruise path (around the Sun) and its encounter path (around the planet)
    // come from different reconstructions; where the table changes centre they disagree
    // by up to 13,500 km for Voyager 2 at Neptune, 87 million km out: under a
    // thousandth of the distance, below a pixel at any view that shows both.
    let switches = 0;
    for (const m of MISSIONS) {
      const traj = trajectory(m.slug);
      for (let i = 0; i + 1 < traj.length; i++) {
        if (traj.t[i] !== traj.t[i + 1]) continue;
        switches++;
        const t = traj.t[i];
        const a = at(traj.centres[i], t, [0, 0, 0]), b = at(traj.centres[i + 1], t, [0, 0, 0]);
        const gap = Math.hypot(...[0, 1, 2].map((k) => a[k] + traj.p[i * 3 + k] - b[k] - traj.p[i * 3 + 3 + k]));
        const planet = traj.centres[i] === 10 ? i + 1 : i;
        const r = Math.hypot(traj.p[planet * 3], traj.p[planet * 3 + 1], traj.p[planet * 3 + 2]);
        expect(gap / r, `${m.slug}: centre ${traj.centres[i]} to ${traj.centres[i + 1]}`).toBeLessThan(1e-3);
        // The duplicated epoch belongs to the later centre.
        expect(traj.centre(t)).toBe(traj.centres[i + 1]);
      }
    }
    expect(switches).toBeGreaterThan(20);
  });
});

describe('Spacecraft: the passes everyone knows', () => {
  // Distance from the body's centre (km) and time (UTC) as NASA/JPL published them.
  const passes: [slug: string, body: number, utc: string, km: number, kmTol: number, minutesTol: number][] = [
    ['voyager-1', 599, '1979-03-05T12:05Z', 348_890, 2_000, 10],
    ['voyager-1', 699, '1980-11-12T23:46Z', 184_300, 1_000, 10],
    ['voyager-2', 599, '1979-07-09T22:29Z', 721_670, 1_000, 10],
    ['voyager-2', 699, '1981-08-26T03:24Z', 161_000, 1_000, 10],
    ['voyager-2', 799, '1986-01-24T17:59Z', 107_000, 1_000, 10],
    ['voyager-2', 899, '1989-08-25T03:56Z', 29_240, 100, 5],
    ['pioneer-10', 599, '1973-12-04T02:26Z', 203_700, 1_000, 10],
    ['new-horizons', 999, '2015-07-14T11:49Z', 13_690, 100, 3],
    // 559 km above the Earth (radius 6,378 km).
    ['juno', 399, '2013-10-09T19:21Z', 6_937, 30, 3],
    // Artemis II: 6,545 km above the far side of the Moon.
    ['artemis-2', 301, '2026-04-06T23:01Z', 8_282, 30, 3],
    // Parker's 22nd perihelion: 6.9 million km from the Sun's centre at 191 km/s.
    ['parker-solar-probe', 10, '2024-12-24T11:53Z', 6_870_000, 20_000, 20],
  ];
  for (const [slug, body, utc, km, kmTol, minutesTol] of passes) {
    it(`${slug} passes ${body} at ${utc}, ${km.toLocaleString('en-US')} km`, () => {
      const traj = trajectory(slug);
      const t = utcToTdb(Date.parse(utc));
      const found = approaches(traj, body, at, km * 3, t - 2 * 86400, t + 2 * 86400);
      expect(found.length).toBe(1);
      expect(Math.abs(found[0].distance - km)).toBeLessThan(kmTol);
      expect(Math.abs(found[0].tdb - t) / 60).toBeLessThan(minutesTol);
    });
  }

  it('lists the gravity assists with the speed they gave', () => {
    // Voyager 2 at Jupiter: about 10 km/s around the Sun before, about 20 after.
    const jupiter = (moments as any)['voyager-2'].moments.find((m: any) => m.body === 599);
    expect(jupiter.title).toBe('Jupiter flyby');
    expect(jupiter.assist[0]).toBeLessThan(12);
    expect(jupiter.assist[1]).toBeGreaterThan(18);
    // Cassini's arrival at Saturn is an orbit, not a flyby: its periapses are counted.
    const cassini = (moments as any).cassini.moments;
    expect(cassini.some((m: any) => m.title === 'Perikrone 1')).toBe(true);
    expect(cassini.filter((m: any) => m.body === 606).length).toBeGreaterThan(100);
  });
});
