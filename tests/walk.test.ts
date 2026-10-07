import { describe, expect, it } from 'vitest';
import { GM } from '../src/core/gravity';
import { MARS_SPHERE, MOON_SPHERE, WGS84, type Shape } from '../src/core/geodesy';
import { JUMP_SPEED, Walker, type WalkInput, type WalkWorld } from '../src/core/walker';

const DEG = Math.PI / 180;
const STAND: WalkInput = { move: [0, 0], run: false, jump: false };

/** A body with flat ground (or a given slope), spinning about its z axis. */
function world(shape: Shape, gm: number, day: number, ground: (lon: number, lat: number) => number = () => 0): WalkWorld {
  return { shape, gm, spin: [0, 0, (2 * Math.PI) / day], ground };
}
const MOON = world(MOON_SPHERE, GM[301], 27.321661 * 86400);
const MARS = world(MARS_SPHERE, GM[499], 88642.66);
const EARTH = world(WGS84, GM[399], 86164.0905);

/** Stand on the ground at the equator and settle. */
function standing(w: WalkWorld, lon = 0, lat = 0): Walker {
  const walker = new Walker(w.shape, lon, lat, w.ground(lon, lat));
  walker.onGround = true;
  walker.step(w, 0.5, STAND);
  return walker;
}

/** Jump straight up and return the peak height (m) and time in the air (s). */
function jump(w: WalkWorld): { peak: number; air: number } {
  const walker = standing(w);
  walker.step(w, 1 / 60, { ...STAND, jump: true });
  let t = 1 / 60;
  while (!walker.onGround && t < 30) {
    walker.step(w, 1 / 60, STAND);
    t += 1 / 60;
  }
  return { peak: walker.peak, air: walker.airTime };
}

describe('Walking: gravity at the feet', () => {
  it('weighs what NASA lists on the Moon, Mars and Earth', () => {
    // NASA fact sheets, equatorial surface gravity (m/s^2). The walker's Earth is a point mass
    // plus spin; the 0.15% from Earth's flattening (J2) is left out.
    const cases: Array<[string, WalkWorld, number, number]> = [
      ['Moon', MOON, 1.62, 0.01],
      ['Mars', MARS, 3.71, 0.02],
      ['Earth', EARTH, 9.78, 0.02],
    ];
    for (const [name, w, nasa, tol] of cases) {
      const g = Math.hypot(...standing(w).gravity(w)) * 1000;
      console.log(`${name}: g = ${g.toFixed(3)} m/s^2 (NASA ${nasa})`);
      expect(Math.abs(g - nasa)).toBeLessThan(tol);
    }
  });
});

describe('Walking: jumps', () => {
  it('rise v^2/2g and last 2v/g: about 3 m and 4 s on the Moon, 1.3 m on Mars', () => {
    for (const [name, w] of [['Moon', MOON], ['Mars', MARS], ['Earth', EARTH]] as const) {
      const g = Math.hypot(...standing(w).gravity(w));
      const v = JUMP_SPEED / 1000;
      const { peak, air } = jump(w);
      const wantPeak = (v * v) / (2 * g) * 1000;
      const wantAir = (2 * v) / g;
      console.log(`${name}: jump ${peak.toFixed(2)} m high (ballistic ${wantPeak.toFixed(2)}), ${air.toFixed(2)} s in the air (${wantAir.toFixed(2)})`);
      expect(Math.abs(peak - wantPeak) / wantPeak).toBeLessThan(0.01);
      // The landing is detected on the frame after touchdown.
      expect(Math.abs(air - wantAir)).toBeLessThan(1 / 30);
    }
    expect(jump(MOON).peak).toBeGreaterThan(2.9);
    expect(jump(MARS).peak).toBeGreaterThan(1.25);
  });
});

describe('Walking: pace', () => {
  it('walks at Froude 0.25 and runs at 2.5: 0.6 and 1.9 m/s on the Moon', () => {
    const paces: Array<[string, WalkWorld, number, number]> = [
      ['Moon', MOON, 0.60, 1.91],
      ['Mars', MARS, 0.91, 2.89],
      ['Earth', EARTH, 1.48, 4.69],
    ];
    for (const [name, w, walk, run] of paces) {
      for (const [running, want] of [[false, walk], [true, run]] as const) {
        const walker = standing(w);
        walker.heading = 90 * DEG;
        // Get up to speed, then time ten seconds.
        walker.step(w, 10, { move: [1, 0], run: running, jump: false });
        const [lon0] = walker.geodetic(w.shape);
        walker.step(w, 10, { move: [1, 0], run: running, jump: false });
        const [lon1] = walker.geodetic(w.shape);
        const speed = ((lon1 - lon0) * w.shape.a * 1000) / 10;
        console.log(`${name} ${running ? 'run' : 'walk'}: ${speed.toFixed(2)} m/s`);
        expect(Math.abs(speed - want)).toBeLessThan(0.02);
        expect(walker.onGround || running).toBe(true);
      }
    }
  });

  it('takes longer to stop on the Moon: friction is at most mu g', () => {
    const stop = (w: WalkWorld) => {
      const walker = standing(w);
      walker.step(w, 10, { move: [1, 0], run: true, jump: false });
      let t = 0;
      while (Math.hypot(...walker.v) * 1000 > 0.01 && t < 10) {
        walker.step(w, 1 / 120, STAND);
        t += 1 / 120;
      }
      return t;
    };
    const moon = stop(MOON), earth = stop(EARTH);
    console.log(`Stopping from a run: Moon ${moon.toFixed(2)} s, Earth ${earth.toFixed(2)} s`);
    // Both run at Fr 2.5 and brake at mu g, so the time goes as 1/sqrt(g).
    expect(moon / earth).toBeGreaterThan(2.2);
    expect(moon / earth).toBeLessThan(2.7);
  });
});

describe('Walking: slopes', () => {
  it('stands on gentle slopes and slides down ones steeper than 35 degrees', () => {
    const slope = (deg: number) => world(MOON_SPHERE, GM[301], 27.321661 * 86400, (lon) => Math.tan(deg * DEG) * lon * MOON_SPHERE.a);
    for (const [deg, slides] of [[20, false], [45, true]] as const) {
      const w = slope(deg);
      const walker = standing(w);
      const [lon0] = walker.geodetic(w.shape);
      walker.step(w, 5, STAND);
      const [lon1] = walker.geodetic(w.shape);
      const moved = Math.abs(lon1 - lon0) * MOON_SPHERE.a * 1000;
      console.log(`${deg} degree slope: moved ${moved.toFixed(2)} m in 5 s`);
      if (slides) expect(moved).toBeGreaterThan(1);
      else expect(moved).toBeLessThan(0.01);
    }
  });
});
