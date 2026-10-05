import { describe, expect, it } from 'vitest';
import { taiMinusUtc, tdbToUtc, utcToTdb } from '../src/core/time';

describe('time scales', () => {
  it('uses 37 leap seconds since 2017', () => {
    expect(taiMinusUtc(Date.UTC(2016, 11, 31, 23, 59, 59))).toBe(36);
    expect(taiMinusUtc(Date.UTC(2017, 0, 1))).toBe(37);
  });

  it('places J2000 (2000-01-01 11:58:55.816 UTC) at TT = 0', () => {
    // TT - UTC was 64.184 s in 2000, so J2000 TT is 11:58:55.816 UTC; TDB differs by < 2 ms.
    expect(Math.abs(utcToTdb(Date.UTC(2000, 0, 1, 11, 58, 55, 816)))).toBeLessThan(0.002);
  });

  it('round-trips UTC through TDB', () => {
    const t = Date.UTC(2026, 9, 5, 4, 30, 12, 345);
    expect(Math.abs(tdbToUtc(utcToTdb(t)) - t)).toBeLessThan(0.01);
  });
});
