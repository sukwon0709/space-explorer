import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ephemeris, type Vec3 } from '../src/core/ephemeris';
import { Trajectory, approaches } from '../src/core/mission';
import { MISSIONS } from '../src/ui/missions';
import { utcToTdb } from '../src/core/time';
import { GM } from '../src/core/gravity';
import moments from '../src/generated/missions.json';
import reference from './fixtures/missions-reference.json';

const load = (name: string) => {
  const f = readFileSync(new URL(`../public/data/${name}`, import.meta.url));
  return f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength);
};
const ephemeris = new Ephemeris(load('de440.bin'));
for (const name of ['mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto', 'visited']) ephemeris.add(load(`moons-${name}.bin`));
ephemeris.setBarycentre(2065803, 120065803, GM[120065803] / (GM[2065803] + GM[120065803]));
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
        expect(gap / r, `${m.slug}: centre ${traj.centres[i]} to ${traj.centres[i + 1]} at ${t}`).toBeLessThan(1e-3);
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
    // The small bodies (ESA, NASA and JHUAPL releases): Rosetta 803 km from Šteins and
    // 3,162 km from Lutetia; New Horizons 3,538 km from Arrokoth; Deep Impact's flyby
    // 500 km from Tempel 1; NEAR's unplanned Eros flyby 3,827 km; Lucy 960 km from
    // Donaldjohanson.
    ['rosetta', 2002867, '2008-09-05T18:38Z', 803, 30, 3],
    ['rosetta', 2000021, '2010-07-10T15:45Z', 3_162, 50, 3],
    ['new-horizons', 2486958, '2019-01-01T05:33Z', 3_538, 50, 3],
    ['deep-impact', 1000093, '2005-07-04T06:00Z', 500, 50, 10],
    ['near-shoemaker', 2000433, '1998-12-23T18:41Z', 3_827, 100, 10],
    ['lucy', 20052246, '2025-04-20T17:51Z', 960, 50, 5],
  ];
  for (const [slug, body, utc, km, kmTol, minutesTol] of passes) {
    it(`${slug} passes ${body} at ${utc}, ${km.toLocaleString('en-US')} km`, () => {
      const traj = trajectory(slug);
      const t = utcToTdb(Date.parse(utc));
      // A small body's flyby is a straight line, a few rows: count passes within 100,000 km.
      const found = approaches(traj, body, at, Math.max(km * 3, 100_000), t - 2 * 86400, t + 2 * 86400);
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

describe('Spacecraft: at the small bodies', () => {
  const distance = (slug: string, body: number, utc: string) => {
    const traj = trajectory(slug);
    const t = utcToTdb(Date.parse(utc));
    const p = traj.position(t, at), b = at(body, t, [0, 0, 0]);
    return Math.hypot(p[0] - b[0], p[1] - b[1], p[2] - b[2]);
  };

  it('ends DART on Dimorphos at the moment of impact', () => {
    // The impact was at 23:14:24 UTC, at 6.1 km/s (Daly et al. 2023).
    const traj = trajectory('dart');
    expect(Math.abs(traj.end - utcToTdb(Date.parse('2022-09-26T23:14:24Z')))).toBeLessThan(1);
    // At its last row, a fraction of a second from Dimorphos's centre at its speed.
    const p = traj.relative(traj.end), v = traj.velocity(traj.end, at);
    const b0 = at(120065803, traj.end, [0, 0, 0]), b1 = at(120065803, traj.end + 1, [0, 0, 0]);
    const speed = Math.hypot(v[0] - (b1[0] - b0[0]), v[1] - (b1[1] - b0[1]), v[2] - (b1[2] - b0[2]));
    expect(speed).toBeCloseTo(6.1, 1);
    expect(Math.hypot(p[0], p[1], p[2]) / speed).toBeLessThan(0.5);
    // A minute earlier it was still 370 km out.
    expect(distance('dart', 120065803, '2022-09-26T23:13:24Z')).toBeGreaterThan(300);
  });

  it('brings Hayabusa2 down to Ryugu’s surface at each touchdown, and back to 20 km', () => {
    // Ryugu's equatorial radius is about 0.5 km; home position is 20 km Earthward.
    for (const utc of ['2019-02-21T22:29:00Z', '2019-07-11T01:06:00Z']) {
      expect(distance('hayabusa2', 2162173, utc)).toBeLessThan(0.55);
      expect(distance('hayabusa2', 2162173, utc)).toBeGreaterThan(0.4);
    }
    expect(distance('hayabusa2', 2162173, '2019-01-15T00:00:00Z')).toBeGreaterThan(18);
    expect(distance('hayabusa2', 2162173, '2019-01-15T00:00:00Z')).toBeLessThan(22);
  });

  it('lands NEAR on Eros and orbits Bennu with OSIRIS-REx', () => {
    // NEAR came to rest on Eros at 19:44 UTC on 12 February 2001 (Eros is 34 x 11 x 11 km).
    expect(distance('near-shoemaker', 2000433, '2001-02-12T20:00:00Z')).toBeLessThan(17.5);
    // OSIRIS-REx's Orbital B: about 1 km from Bennu's centre (Lauretta et al. 2019 reports 680 m above the surface).
    const d = distance('osiris-rex', 2101955, '2019-06-20T00:00:00Z');
    expect(d).toBeGreaterThan(0.8);
    expect(d).toBeLessThan(1.6);
  });
});
