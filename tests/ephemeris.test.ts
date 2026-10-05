import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ephemeris } from '../src/core/ephemeris';

const file = readFileSync(new URL('../public/data/de421.bin', import.meta.url));
const ephemeris = new Ephemeris(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
const reference: { cases: Array<{ center: number; target: number; tdb: number; km: number[] }> } = JSON.parse(
  readFileSync(new URL('./fixtures/de421-reference.json', import.meta.url), 'utf8'),
);

describe('Ephemeris', () => {
  it('matches JPL reference positions (jplephem on the source kernel) to within 1 m', () => {
    let worst = 0;
    for (const c of reference.cases) {
      const p = ephemeris.segmentPosition(c.target, c.tdb);
      const err = Math.hypot(p[0] - c.km[0], p[1] - c.km[1], p[2] - c.km[2]);
      worst = Math.max(worst, err);
    }
    expect(reference.cases.length).toBeGreaterThan(900);
    expect(worst).toBeLessThan(0.001); // km
  });

  it('chains segments to the barycentre (Earth = EMB + Earth offset)', () => {
    const t = 8.1e8;
    const emb = ephemeris.segmentPosition(3, t);
    const earthFromEmb = ephemeris.segmentPosition(399, t);
    const earth = ephemeris.position(399, t);
    for (let i = 0; i < 3; i++) expect(earth[i]).toBeCloseTo(emb[i] + earthFromEmb[i], 6);
  });

  it('puts Earth about 1 AU from the Sun, closest in early January', () => {
    const AU = 149597870.7;
    const dist = (tdb: number) => {
      const e = ephemeris.position(399, tdb);
      const s = ephemeris.position(10, tdb);
      return Math.hypot(e[0] - s[0], e[1] - s[1], e[2] - s[2]) / AU;
    };
    const perihelion2026 = (Date.UTC(2026, 0, 3, 17, 15) - Date.UTC(2000, 0, 1, 12)) / 1000 + 69.184;
    const aphelion2026 = (Date.UTC(2026, 6, 6, 17, 31) - Date.UTC(2000, 0, 1, 12)) / 1000 + 69.184;
    expect(dist(perihelion2026)).toBeCloseTo(0.98330, 4);
    expect(dist(aphelion2026)).toBeCloseTo(1.01664, 4);
  });

  it('rejects epochs outside the bundled range', () => {
    expect(() => ephemeris.position(399, ephemeris.end + 86400)).toThrow(RangeError);
    expect(() => ephemeris.position(399, ephemeris.start - 86400)).toThrow(RangeError);
  });
});
