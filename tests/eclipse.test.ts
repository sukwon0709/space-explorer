import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ephemeris } from '../src/core/ephemeris';
import { Orientation } from '../src/core/orientation';
import { EclipseCalculator } from '../src/core/eclipse';
import { utcToTdb } from '../src/core/time';

/**
 * Milestone 3 gate: the total solar eclipse of 2 August 2027 reproduces NASA's
 * published path of totality (Espenak, eclipse.gsfc.nasa.gov).
 *
 * NASA's table is in UT and assumes Delta T = TT - UT1 = 71.7 s; the app's Earth
 * orientation follows IERS, which predicts 69.4 s for that day. The comparison adopts
 * NASA's Delta T, both for converting NASA's times to TT and for the Earth's rotation
 * angle, so like is compared with like. (With the IERS value the whole path shifts
 * about 1 km east-west and its times by 2.3 s.)
 */
const load = (name: string) => {
  const file = readFileSync(new URL(`../public/data/${name}`, import.meta.url));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
};
const ephemeris = new Ephemeris(load('de440.bin'));
const orientation = new Orientation(new Ephemeris(load('orientation.bin')));
const nasa: {
  delta_t: number;
  iers_ut1_utc: number;
  greatest: { utc: string; lat: number; lon: number; duration_s: number };
  path: Array<{ utc: string; north: [number, number]; south: [number, number]; central: [number, number]; duration_s: number; width_km: number }>;
} = JSON.parse(readFileSync(new URL('./fixtures/eclipse-2027-08-02.json', import.meta.url), 'utf8'));

const ourDeltaT = 32.184 + 37 - nasa.iers_ut1_utc;
const eclipse = new EclipseCalculator(ephemeris, orientation, { ut1Shift: ourDeltaT - nasa.delta_t });
/** TDB of a NASA table time (UT1): TT = UT1 + Delta T. */
const tdbOf = (utc: string) => utcToTdb(Date.parse(utc)) + (nasa.delta_t - (32.184 + 37));
const R = 6371.0;
const DEG = Math.PI / 180;

function distanceKm(a: [number, number], b: [number, number]): number {
  const [la1, lo1] = [a[0] * DEG, a[1] * DEG];
  const [la2, lo2] = [b[0] * DEG, b[1] * DEG];
  const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Point `s` km from a toward b along the great circle. */
function along(a: [number, number], b: [number, number], s: number): [number, number] {
  const d = distanceKm(a, b);
  const t = s / d;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

describe('2027 August 2 total solar eclipse (milestone 3 gate)', () => {
  it("central line lies within 1 km of NASA's at every 2-minute step, and runs within 1.5 s of its times", () => {
    // Split each difference into across the path (where the path lies on the map) and
    // along it (when the shadow gets there); near sunrise and sunset the shadow skims
    // the ground at up to 5 km/s, so timing is compared in seconds.
    let worstCross = 0, worstTime = 0;
    const rows = nasa.path;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const p = eclipse.centralPoint(tdbOf(row.utc));
      expect(p).not.toBeNull();
      const prev = rows[Math.max(i - 1, 0)], next = rows[Math.min(i + 1, rows.length - 1)];
      const c = Math.cos(row.central[0] * DEG);
      const dir = [(next.central[0] - prev.central[0]) * 111.195, (next.central[1] - prev.central[1]) * 111.195 * c];
      const step = Math.hypot(dir[0], dir[1]);
      const speed = step / ((rows.indexOf(next) - rows.indexOf(prev)) * 120);
      const d = [(p![0] - row.central[0]) * 111.195, (p![1] - row.central[1]) * 111.195 * c];
      const alongKm = (d[0] * dir[0] + d[1] * dir[1]) / step;
      const cross = (-d[0] * dir[1] + d[1] * dir[0]) / step;
      worstCross = Math.max(worstCross, Math.abs(cross));
      worstTime = Math.max(worstTime, Math.abs(alongKm / speed));
    }
    console.log(`central line: ${rows.length} points, worst ${worstCross.toFixed(3)} km across the path, worst ${worstTime.toFixed(2)} s along it`);
    expect(worstCross).toBeLessThan(1);
    expect(worstTime).toBeLessThan(1.5);
  });

  it('northern and southern limits match NASA within 1.5 km', () => {
    let worst = 0;
    // Every fifth row keeps the test quick; each limit needs a search in space and time.
    for (const row of nasa.path.filter((_, i) => i % 5 === 2)) {
      const tdb = tdbOf(row.utc);
      for (const limit of [row.north, row.south]) {
        // Walk from NASA's central point toward its limit and find where totality ends.
        const span = distanceKm(row.central, limit);
        let inside = 0, outside = span * 1.3;
        for (let i = 0; i < 30; i++) {
          const mid = (inside + outside) / 2;
          const [lat, lon] = along(row.central, limit, mid);
          if (eclipse.maxMargin(lat, lon, tdb, 600).margin > 0) inside = mid;
          else outside = mid;
        }
        worst = Math.max(worst, Math.abs((inside + outside) / 2 - span));
      }
    }
    console.log(`limits: worst ${worst.toFixed(3)} km`);
    expect(worst).toBeLessThan(1.5);
  });

  it('greatest duration of totality matches NASA within 1 s', () => {
    const g = nasa.greatest;
    const tdb = tdbOf(g.utc);
    const span = eclipse.totality(g.lat, g.lon, tdb)!;
    const duration = span[1] - span[0];
    console.log(`duration at greatest eclipse: ${duration.toFixed(2)} s (NASA ${g.duration_s} s)`);
    expect(Math.abs(duration - g.duration_s)).toBeLessThan(1);
  });
});
