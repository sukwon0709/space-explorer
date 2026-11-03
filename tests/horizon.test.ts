import { describe, expect, it } from 'vitest';
import { computeHorizons, horizonDegrees, HORIZON_DIRECTIONS } from '../src/core/horizon';

const n = 17;
const bounds: [number, number, number, number] = [0, 0, 1, 1];
const R = 1737.4;
const DEG = Math.PI / 180;

describe('horizon maps', () => {
  it('sees a flat plain dip below the horizontal by the curvature only', () => {
    const h = computeHorizons(new Float64Array(n * n), n, bounds, R, () => 0);
    for (let k = 0; k < HORIZON_DIRECTIONS; k++) {
      const deg = horizonDegrees(h[(8 * n + 8) * HORIZON_DIRECTIONS + k]);
      expect(deg).toBeLessThanOrEqual(0.2);
      expect(deg).toBeGreaterThan(-1.5);
    }
  });

  it('finds the elevation of a cliff to the east, and an open sky to the west', () => {
    // East half of the tile and everything east of it is 2 km higher.
    const heights = new Float64Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[j * n + i] = i >= 12 ? 2 : 0;
    const lonOf = (i: number) => i / (n - 1);
    const h = computeHorizons(heights, n, bounds, R, (lon) => (lon > lonOf(12) ? 2 : 0));
    const i = 4, j = 8;
    // Distance to the foot of the cliff (bilinear: it rises between columns 11 and 12).
    const d = (lonOf(12) - lonOf(i)) * DEG * R * Math.cos(0.5 * DEG);
    const expected = Math.atan(2 / d) / DEG;
    const east = horizonDegrees(h[(j * n + i) * HORIZON_DIRECTIONS + 2]);
    expect(east).toBeGreaterThan(expected - 3);
    expect(east).toBeLessThan(expected + 6);
    const west = horizonDegrees(h[(j * n + i) * HORIZON_DIRECTIONS + 6]);
    expect(west).toBeLessThan(0.5);
  });
});
