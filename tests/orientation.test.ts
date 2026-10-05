import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ephemeris } from '../src/core/ephemeris';
import { Orientation } from '../src/core/orientation';
import { icrfToScene } from '../src/core/frames';
import type { Vec3 } from '../src/core/ephemeris';

const file = readFileSync(new URL('../public/data/orientation.bin', import.meta.url));
const orientation = new Orientation(new Ephemeris(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)));
const reference: { cases: Array<{ body: number; tdb: number; matrix: number[] }> } = JSON.parse(
  readFileSync(new URL('./fixtures/orientation-reference.json', import.meta.url), 'utf8'),
);

/** Angle of the rotation a * b^T, from its antisymmetric part (precise near zero). */
function rotationError(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const r = (i: number, j: number) => a[i * 3] * b[j * 3] + a[i * 3 + 1] * b[j * 3 + 1] + a[i * 3 + 2] * b[j * 3 + 2];
  return Math.asin(Math.min(1, Math.hypot(r(1, 2) - r(2, 1), r(2, 0) - r(0, 2), r(0, 1) - r(1, 0)) / 2));
}

describe('Orientation', () => {
  it('matches SPICE (ITRF93 and MOON_ME) to within 10 cm on the surface', () => {
    const worst = new Map<number, number>();
    for (const c of reference.cases) {
      const err = rotationError(orientation.icrfToBody(c.body, c.tdb), c.matrix);
      worst.set(c.body, Math.max(worst.get(c.body) ?? 0, err));
    }
    const earthMetres = worst.get(399)! * 6378137;
    const moonMetres = worst.get(301)! * 1737400;
    console.log(`Worst orientation error on the surface: Earth ${earthMetres.toFixed(3)} m, Moon ${moonMetres.toFixed(6)} m`);
    expect(earthMetres).toBeLessThan(0.1);
    expect(moonMetres).toBeLessThan(0.001);
  });

  it('bodyToScene is the ICRF-to-scene rotation applied to the body axes', () => {
    const t = 8.1e8;
    const m = orientation.icrfToBody(399, t);
    const b = orientation.bodyToScene(399, t);
    for (let axis = 0; axis < 3; axis++) {
      // Body axis `axis` in ICRF is row `axis` of icrfToBody.
      const inScene = icrfToScene([m[axis * 3], m[axis * 3 + 1], m[axis * 3 + 2]] as Vec3);
      for (let k = 0; k < 3; k++) expect(b[k * 3 + axis]).toBeCloseTo(inScene[k], 12);
    }
  });

  it('puts Greenwich under the Sun near 12:00 UT (equation of time aside)', () => {
    // 2026-10-05 11:48:40 UTC is close to local apparent noon at Greenwich
    // (equation of time is about +11.3 min in early October).
    const tdb = (Date.UTC(2026, 9, 5, 11, 48, 40) - Date.UTC(2000, 0, 1, 12)) / 1000 + 69.184;
    const m = orientation.icrfToBody(399, tdb);
    // Prime meridian direction (body x axis) in ICRF, against a rough solar right ascension.
    const raPrime = Math.atan2(m[1], m[0]) * (180 / Math.PI);
    const raSun = 191.3; // degrees, 2026-10-05 noon (Astronomical Almanac scale)
    expect(Math.abs(((raPrime - raSun + 540) % 360) - 180)).toBeLessThan(0.5);
  });
});
