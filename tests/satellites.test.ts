import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { earthFixedPosition, parseSatellites, type SatelliteSnapshot } from '../src/core/satellites';
import type { Vec3 } from '../src/core/ephemeris';

const snapshot: SatelliteSnapshot = JSON.parse(readFileSync(new URL('../public/data/satellites.json', import.meta.url), 'utf8'));
const reference: { cases: Array<{ id: number; unixMs: number; itrf: Vec3 }> } = JSON.parse(
  readFileSync(new URL('./fixtures/satellites-reference.json', import.meta.url), 'utf8'),
);

describe('Satellites', () => {
  const satellites = new Map(parseSatellites(snapshot.objects).map((s) => [s.id, s]));

  it('parses the bundled snapshot, including the ISS and Tiangong', () => {
    expect(satellites.size).toBeGreaterThan(150);
    expect(satellites.get(25544)?.name).toMatch(/ISS/);
    expect(satellites.get(48274)?.name).toMatch(/CSS/);
  });

  it('matches skyfield Earth-fixed positions to within 1 km', () => {
    let worst = 0;
    const out: Vec3 = [0, 0, 0];
    for (const c of reference.cases) {
      expect(earthFixedPosition(satellites.get(c.id)!, c.unixMs, out)).toBe(true);
      worst = Math.max(worst, Math.hypot(out[0] - c.itrf[0], out[1] - c.itrf[1], out[2] - c.itrf[2]));
    }
    console.log(`Worst satellite position difference from skyfield: ${(worst * 1000).toFixed(1)} m`);
    expect(worst).toBeLessThan(1);
  });

  it('refuses elements far from their epoch', () => {
    const iss = satellites.get(25544)!;
    expect(earthFixedPosition(iss, iss.epoch + 90 * 86400000, [0, 0, 0])).toBe(false);
  });
});
