import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ephemeris, type Vec3 } from '../src/core/ephemeris';
import { asteroidOrbit, orbitPosition, parseAsteroids, AU_KM } from '../src/core/smallbodies';

/**
 * Moons and the largest asteroids, refitted from JPL's satellite and asteroid kernels
 * (pipeline/build_moons.py, float32 Chebyshev coefficients), against positions read
 * straight from those kernels at epochs that were not fitted.
 */
const load = (name: string) => {
  const file = readFileSync(new URL(`../public/data/${name}`, import.meta.url));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
};
const reference: {
  tolerance_km: number;
  cases: Array<{ center: number; target: number; tdb: number; km: Vec3; tolerance_km?: number }>;
} = JSON.parse(readFileSync(new URL('./fixtures/moons-reference.json', import.meta.url), 'utf8'));

const ephemeris = new Ephemeris(load('de440.bin'));
for (const system of ['mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto', 'asteroids']) ephemeris.add(load(`moons-${system}.bin`));

describe('moon and asteroid ephemerides', () => {
  it('match the JPL kernels', () => {
    let worst = 0;
    for (const c of reference.cases) {
      const t = ephemeris.position(c.target, c.tdb);
      const o = c.center === 0 ? [0, 0, 0] : ephemeris.position(c.center, c.tdb);
      const err = Math.hypot(t[0] - o[0] - c.km[0], t[1] - o[1] - c.km[1], t[2] - o[2] - c.km[2]);
      expect(err, `body ${c.target} at ${c.tdb}`).toBeLessThan(c.tolerance_km ?? reference.tolerance_km);
      worst = Math.max(worst, err / (c.tolerance_km ?? reference.tolerance_km));
    }
    expect(reference.cases.length).toBeGreaterThan(500);
    expect(worst).toBeLessThan(1);
  });

  it('two-body asteroid orbits stay close to the full ephemeris near their epoch', () => {
    // Vesta is record 1 or so; find it by its orbit (a = 2.36 AU, i = 7.1 degrees).
    const set = parseAsteroids(load('asteroids.bin'));
    let vesta = -1;
    for (let k = 0; k < 50; k++) {
      const a = set.elements[k * 8], i = set.elements[k * 8 + 2];
      if (Math.abs(a - 2.36) < 0.01 && Math.abs(i - 7.14 * (Math.PI / 180)) < 0.01) vesta = k;
    }
    expect(vesta).toBeGreaterThanOrEqual(0);
    const orbit = asteroidOrbit(set, vesta);
    const epochDays = set.elements[vesta * 8 + 6];
    for (const dd of [-60, 0, 60]) {
      const days = epochDays + dd;
      const p = orbitPosition(orbit, days);
      const tdb = days * 86400;
      const v = ephemeris.position(2000004, tdb), s = ephemeris.position(10, tdb);
      // Ecliptic two-body position vs ICRF kernel position: rotate the ICRF difference.
      const e = 23.439291111 * (Math.PI / 180);
      const d = [v[0] - s[0], v[1] - s[1], v[2] - s[2]];
      const ecl = [d[0], Math.cos(e) * d[1] + Math.sin(e) * d[2], -Math.sin(e) * d[1] + Math.cos(e) * d[2]];
      const err = Math.hypot(p[0] - ecl[0], p[1] - ecl[1], p[2] - ecl[2]);
      // float32 elements (7 digits of a 2.4 AU orbit) and no perturbations: within 0.0005 AU.
      expect(err, `Vesta ${dd} days from epoch`).toBeLessThan(0.0005 * AU_KM);
    }
  });
});

describe('comet orbits', () => {
  const at = (e: number, days: number) => {
    const p = orbitPosition({ q: 1, e, i: 0.3, node: 1, peri: 2, tp: 0 }, days);
    return Math.hypot(p[0], p[1], p[2]) / AU_KM;
  };
  it('are at perihelion distance at the time of perihelion, for any eccentricity', () => {
    for (const e of [0.2, 0.9, 0.9995, 1, 1.0005, 1.5]) expect(at(e, 0)).toBeCloseTo(1, 9);
  });
  it('move smoothly across the parabolic boundary', () => {
    // Elliptic, parabolic and hyperbolic branches agree near e = 1, 30 days from perihelion.
    // Evenly spaced eccentricities give evenly spaced distances (small second differences).
    const near = [0.996, 0.998, 1, 1.002, 1.004].map((e) => at(e, 30));
    for (let k = 1; k < near.length - 1; k++) expect(Math.abs(near[k + 1] - 2 * near[k] + near[k - 1])).toBeLessThan(2e-5);
    // Vis-viva check for an ellipse: r goes from q to Q = q (1 + e) / (1 - e).
    expect(at(0.5, 0.5 * 365.25 * Math.pow(2, 1.5) / 1.000003)).toBeCloseTo(3, 3);
  });
});
