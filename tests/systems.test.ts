import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { AU_KM, EARTH_RADIUS_KM, StarSystems, type SystemsData } from '../src/core/systems';
import { besselianToJd, planeState, positionAngle, skyAxes, solveKepler, visualOffset } from '../src/core/kepler';
import type { NamedStar } from '../src/core/stars';
import type { Vec3 } from '../src/core/ephemeris';
import reference from './fixtures/systems-reference.json';

/**
 * Gate for star systems: binary stars where the orbit catalogue (and Gaia) put them,
 * and every transiting planet in front of its star at its time of mid-transit.
 */

const named = JSON.parse(readFileSync('public/data/stars/named.json', 'utf8')) as NamedStar[];
const data = JSON.parse(readFileSync('public/data/stars/systems.json', 'utf8')) as SystemsData;
const systems = new StarSystems(named, data, () => 1);
const SOLAR_RADIUS_KM = 695700;
const tdbOfBesselian = (y: number) => (besselianToJd(y) - 2451545) * 86400;

/** Separation (arcsec) and position angle (degrees) of b from a as seen from the Sun. */
function seenFromSun(a: Vec3, b: Vec3): { rho: number; theta: number } {
  const d = Math.hypot(...a);
  const { north, east } = skyAxes([a[0] / d, a[1] / d, a[2] / d]);
  const rel = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const n = rel[0] * north[0] + rel[1] * north[1] + rel[2] * north[2];
  const e = rel[0] * east[0] + rel[1] * east[1] + rel[2] * east[2];
  const arcsec = 180 / Math.PI * 3600 / d;
  return { rho: Math.hypot(n, e) * arcsec, theta: ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360 };
}

function members(k: number, tdb: number): [Vec3, Vec3] {
  const b = systems.binaryOf.get(k)!;
  const a = systems.binaryState(b, 0, tdb, { p: [0, 0, 0], v: [0, 0, 0], acc: [0, 0, 0] }).p;
  const s = systems.binaryState(b, 1, tdb, { p: [0, 0, 0], v: [0, 0, 0], acc: [0, 0, 0] }).p;
  return [a, s];
}

describe('Kepler orbits', () => {
  test('solves Kepler\'s equation to machine precision', () => {
    for (const e of [0, 0.1, 0.5, 0.9, 0.97]) {
      for (let M = -7; M < 7; M += 0.37) {
        const E = solveKepler(M, e);
        const back = E - e * Math.sin(E);
        expect(Math.abs(((back - M) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI)).toBeLessThan(1e-12);
      }
    }
  });

  test('velocity and acceleration are the derivatives of position', () => {
    const n = 2 * Math.PI / 1000;
    for (const e of [0, 0.3, 0.8]) {
      const h = 1e-3;
      const s0 = planeState(2, e, n, n * 123), s1 = planeState(2, e, n, n * (123 + h)), sm = planeState(2, e, n, n * (123 - h));
      for (let a = 0; a < 2; a++) {
        expect(s0.v[a]).toBeCloseTo((s1.p[a] - sm.p[a]) / (2 * h), 7);
        expect(s0.acc[a]).toBeCloseTo((s1.v[a] - sm.v[a]) / (2 * h), 7);
      }
    }
  });
});

describe('binary stars', () => {
  test('six binaries are drawn on their orbits', () => {
    expect(systems.binaries.length).toBe(6);
  });

  // ORB6's ephemerides give position angles for the equinox of date; the catalogue's
  // orbits (and this simulator) use J2000. Precession turns position angles by
  // 0.00557° sin(ra) sec(dec) a year.
  test.each(systems.binaries.map((b) => [`${b.data.wds} ${b.data.pair}`, b] as const))('%s matches the ORB6 ephemeris', (key, b) => {
    const rows = (reference.orb6 as Record<string, Array<{ year: number; theta: number; rho: number }>>)[key];
    expect(rows).toBeDefined();
    const star = named[b.primary];
    const d = Math.hypot(...star.pos);
    const ra = Math.atan2(star.pos[1], star.pos[0]), dec = Math.asin(star.pos[2] / d);
    for (const row of rows) {
      const tdb = tdbOfBesselian(row.year);
      // The catalogue orbit itself.
      const pa = positionAngle(visualOffset(b.data.orbit, tdb).p);
      const precession = 0.00557 * Math.sin(ra) / Math.cos(dec) * (row.year - 2000);
      expect(Math.abs(((pa.theta + precession - row.theta + 540) % 360) - 180)).toBeLessThan(0.08);
      expect(Math.abs(pa.rho / row.rho - 1)).toBeLessThan(0.002);
      // And the two stars placed in space, seen from the Sun.
      const [a, s] = members(b.primary, tdb);
      const seen = seenFromSun(a, s);
      expect(Math.abs(((seen.theta + precession - row.theta + 540) % 360) - 180)).toBeLessThan(0.1);
      expect(Math.abs(seen.rho / row.rho - 1)).toBeLessThan(0.003);
    }
  });

  test('61 Cygni B is where Gaia measured it in 2016', () => {
    const k = named.findIndex((s) => s.hip === 104214);
    const g = reference.gaia61Cyg;
    const [a, s] = members(k, (g.year - 2000) * 365.25 * 86400);
    const seen = seenFromSun(a, s);
    expect(Math.abs(seen.rho - g.rho)).toBeLessThan(0.15);
    expect(Math.abs(seen.theta - g.theta)).toBeLessThan(0.3);
  });

  test('stars orbit their barycentre, which moves in a straight line', () => {
    for (const b of systems.binaries) {
      const bary = (tdb: number) => {
        const [a, s] = members(b.primary, tdb);
        return a.map((x, i) => x * (1 - b.f) + s[i] * b.f);
      };
      const t0 = 0, t1 = 20 * 365.25 * 86400, t2 = 40 * 365.25 * 86400;
      const p0 = bary(t0), p1 = bary(t1), p2 = bary(t2);
      for (let i = 0; i < 3; i++) expect(Math.abs(p0[i] - 2 * p1[i] + p2[i])).toBeLessThan(1);
    }
  });
});

describe('exoplanets', () => {
  test('nearly every catalogued planet has an orbit', () => {
    const total = named.reduce((n, s) => n + (s.planets?.length ?? 0), 0);
    expect(systems.planets.length).toBeGreaterThan(0.98 * total);
  });

  test('transiting planets are in front of their star at mid-transit', () => {
    let checked = 0, outside = 0;
    const far: string[] = [];
    const worst: string[] = [];
    for (const info of systems.planets) {
      if (!info.extra.transits || info.extra.tc === undefined) continue;
      const tdb = (info.extra.tc - 2451545) * 86400;
      const star = systems.starState(info.host, tdb).p;
      const planet = systems.planetState(info.index, tdb).p;
      const d = Math.hypot(...star);
      const toUs: Vec3 = [-star[0] / d, -star[1] / d, -star[2] / d];
      const rel = planet.map((x, i) => x - star[i]);
      const along = rel[0] * toUs[0] + rel[1] * toUs[1] + rel[2] * toUs[2];
      const across = Math.sqrt(Math.max(0, rel[0] ** 2 + rel[1] ** 2 + rel[2] ** 2 - along * along));
      const rStar = named[info.host].radius * SOLAR_RADIUS_KM;
      const rPlanet = info.radius * EARTH_RADIUS_KM;
      checked++;
      expect(along).toBeGreaterThan(0);
      if (across > rStar + rPlanet) {
        outside++;
        if (worst.length < 5) worst.push(`${info.name}: ${(across / rStar).toFixed(2)} stellar radii`);
      }
      // Grazing at worst, but for circumbinary planets (TIC 172900988 b), whose transits
      // drift: the catalogue's inclination, a and stellar radius don't always agree.
      if (across > 2 * rStar + rPlanet) far.push(info.name);
    }
    expect(far.length, far.join(', ')).toBeLessThanOrEqual(2);
    expect(checked).toBeGreaterThan(3500);
    expect(outside / checked, worst.join('; ')).toBeLessThan(0.02);
  });

  test('planets with a time of periastron are at periastron then', () => {
    let checked = 0;
    for (const info of systems.planets) {
      if (info.extra.tp === undefined || info.extra.tc !== undefined || info.orbit.e < 0.05) continue;
      const tdb = (info.extra.tp - 2451545) * 86400;
      const r = Math.hypot(...systems.planetOffsetIcrf(info.index, tdb)) / AU_KM;
      expect(r / (info.orbit.a * (1 - info.orbit.e))).toBeCloseTo(1, 9);
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });

  test('TRAPPIST-1 has seven planets, all transiting, all rocky', () => {
    const k = named.findIndex((s) => s.name === 'TRAPPIST-1');
    const list = systems.planetsOf.get(k)!;
    expect(list.map((p) => p.name.slice(-1)).join('')).toBe('bcdefgh');
    for (const p of list) {
      expect(p.extra.transits).toBe(1);
      expect(p.kind).toMatch(/rock|ice|lava/);
    }
  });

  test('planet kinds follow size, density and temperature', () => {
    const kind = (name: string) => systems.planets.find((p) => p.name === name)!.kind;
    expect(kind('HD 189733 b')).toBe('gas giant');
    expect(kind('55 Cnc e')).toBe('lava world');
    expect(kind('GJ 1214 b')).toBe('sub-Neptune');
    expect(kind('Proxima Cen b')).toBe('temperate rock');
  });
});
