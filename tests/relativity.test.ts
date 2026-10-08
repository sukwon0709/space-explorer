import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/ephemeris';
import { C_KMS, G0 } from '../src/core/gravity';
import {
  LIGHT_YEAR_KM, T_CMB, Trip, aberrate, betaOf, doppler, dopplerObserved, freeStep, gammaOf, hyperbolic, pointGain, properTimeFor, surfaceGain,
} from '../src/core/relativity';

const YEAR = 365.25 * 86400;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('Relativity: what the pilot sees', () => {
  it('shifts a source abeam to cos(angle) = beta ahead (aberration)', () => {
    for (const b of [0.1, 0.5, 0.9, 0.999]) {
      const seen = aberrate([1, 0, 0], [0, 0, b]);
      expect(seen[2]).toBeCloseTo(b, 12);
    }
    // Ahead and behind stay put.
    expect(aberrate([0, 0, 1], [0, 0, 0.9])[2]).toBeCloseTo(1, 12);
    expect(aberrate([0, 0, -1], [0, 0, 0.9])[2]).toBeCloseTo(-1, 12);
  });

  it('inverts with the opposite velocity, and agrees on the Doppler factor both ways', () => {
    const beta: Vec3 = [0.3, -0.5, 0.7];
    for (const n of [[1, 0, 0], [0, 1, 0], [0.6, 0, -0.8], [-0.36, 0.48, 0.8]] as Vec3[]) {
      const seen = aberrate(n, beta);
      const back = aberrate(seen, [-beta[0], -beta[1], -beta[2]]);
      for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(n[k], 12);
      expect(dopplerObserved(seen, beta)).toBeCloseTo(doppler(n, beta), 10);
    }
  });

  it('blueshifts head-on by sqrt((1 + beta) / (1 - beta)), and gives a transverse redshift of 1 / gamma', () => {
    for (const b of [0.1, 0.5, 0.99]) {
      expect(doppler([0, 0, 1], [0, 0, b])).toBeCloseTo(Math.sqrt((1 + b) / (1 - b)), 10);
      expect(doppler([0, 0, -1], [0, 0, b])).toBeCloseTo(Math.sqrt((1 - b) / (1 + b)), 10);
      // Seen exactly abeam (in the ship's frame), the light is redshifted by time dilation.
      expect(dopplerObserved([1, 0, 0], [0, 0, b])).toBeCloseTo(1 / gammaOf(b), 10);
    }
  });

  it('gives the microwave background the dipole Planck measured from the Sun\'s motion', () => {
    // Planck 2018 (I, table 3): the Sun moves at 369.82 km/s toward (l, b) = (264.02, 48.25)
    // deg, making the sky 3,362.08 uK hotter ahead than average.
    const beta: Vec3 = [0, 0, 369.82 / C_KMS];
    const ahead = T_CMB * doppler([0, 0, 1], beta) - T_CMB;
    expect(ahead * 1e6).toBeGreaterThan(3362.08 - 5);
    expect(ahead * 1e6).toBeLessThan(3362.08 + 5);
  });

  it('turns a surface into a hotter blackbody ahead, and moves a star\'s visible light out of view far ahead', () => {
    expect(surfaceGain(1, 5772)).toBeCloseTo(1, 12);
    expect(pointGain(1, 5772)).toBeCloseTo(1, 12);
    // A glowing surface only gets brighter ahead.
    let last = 0;
    for (const D of [0.5, 1, 2, 5, 20, 100, 1e4]) {
      const g = surfaceGain(D, 5772);
      expect(g).toBeGreaterThan(last);
      last = g;
    }
    // A Sun-like star brightens a little ahead, then fades as its light goes ultraviolet:
    // the "starbow" ring.
    const gains = [1, 1.5, 2, 3, 5, 10, 30, 100].map((D) => pointGain(D, 5772));
    const peak = Math.max(...gains);
    expect(peak).toBeGreaterThan(1.2);
    expect(gains[gains.length - 1]).toBeLessThan(0.3);
    // Behind, it fades into the infrared.
    expect(pointGain(0.2, 5772)).toBeLessThan(1e-4);
    // The CMB at 2.7 K becomes visible light ahead once D is about 1,000 (2,700 K).
    expect(surfaceGain(1000, T_CMB)).toBeGreaterThan(1e100);
  });
});

describe('Relativity: the ship', () => {
  const g = G0;

  it('matches Baez\'s relativistic-rocket table at 1 g', () => {
    // Accelerating 1 year of ship time: 0.56 ly covered, 1.19 years on Earth, 0.77 c, gamma 1.58.
    const h = hyperbolic(g, YEAR);
    expect(h.x / LIGHT_YEAR_KM).toBeCloseTo(0.56, 2);
    expect(h.t / YEAR).toBeCloseTo(1.19, 2);
    expect(h.beta).toBeCloseTo(0.77, 2);
    expect(h.gamma).toBeCloseTo(1.58, 2);
    // Accelerate halfway, decelerate the rest: ship time for each trip, to the precision quoted.
    const trips: [ly: number, years: number, roundedTo: number][] = [[4.3, 3.6, 0.1], [27, 6.6, 0.1], [30_000, 20, 1], [2_000_000, 28, 1]];
    for (const [ly, years, roundedTo] of trips) {
      const trip = new Trip(ly * LIGHT_YEAR_KM, g);
      expect(Math.abs(trip.tau / YEAR - years)).toBeLessThanOrEqual(roundedTo / 2);
    }
  });

  it('flies to Proxima Centauri at 1 g in 3.6 years on board and 5.9 on Earth', () => {
    const trip = new Trip(4.2465 * LIGHT_YEAR_KM, g);
    expect(trip.tau / YEAR).toBeCloseTo(3.55, 1);
    expect(trip.t / YEAR).toBeCloseTo(5.9, 1);
    expect(trip.peakBeta).toBeGreaterThan(0.94);
    // Halfway, the turnaround; at the end, at rest at the star.
    const mid = trip.at(trip.tau / 2);
    expect(mid.x / trip.distance).toBeCloseTo(0.5, 9);
    expect(mid.beta).toBeCloseTo(trip.peakBeta, 9);
    const end = trip.at(trip.tau);
    expect(end.x / trip.distance).toBeCloseTo(1, 9);
    expect(end.beta).toBeCloseTo(0, 9);
    expect(end.t).toBeCloseTo(trip.t, 0);
    // The light-speed limit: no trip beats the light's own travel time.
    expect(trip.t).toBeGreaterThan(trip.distance / C_KMS);
  });

  it('keeps short hops Newtonian (no cancellation at small speeds)', () => {
    const x = 1000; // km
    const tau = properTimeFor(g, x);
    expect(tau).toBeCloseTo(Math.sqrt((2 * x) / g), 6);
    expect(hyperbolic(g, tau).x).toBeCloseTo(x, 6);
  });

  it('integrates free flight under thrust to the exact hyperbolic motion', () => {
    const x: Vec3 = [0, 0, 0], u: Vec3 = [0, 0, 0];
    let t = 0;
    const steps = 365;
    for (let i = 0; i < steps; i++) t += freeStep(x, u, [g, 0, 0], (2 * YEAR) / steps);
    const exact = hyperbolic(g, 2 * YEAR);
    expect(x[0] / exact.x).toBeCloseTo(1, 6);
    expect(t / exact.t).toBeCloseTo(1, 6);
    expect(betaOf(u)[0]).toBeCloseTo(exact.beta, 7);
    // Thrust across the motion turns the ship without changing its speed much at first,
    // and the speed never reaches c.
    for (let i = 0; i < 100; i++) freeStep(x, u, [0, 10 * g, 0], 0.01 * YEAR);
    const b = betaOf(u);
    expect(Math.sqrt(dot(b, b))).toBeLessThan(1);
  });
});

describe('Relativity: the background ahead', () => {
  it('squeezes the microwave background into a blazing point at gamma of a million', async () => {
    const { forwardBackgroundFlux } = await import('../src/core/relativity');
    // At rest it is invisible; at gamma 1e6 (halfway to Andromeda at 1 g) the whole
    // background, blueshifted to millions of kelvin, sits in a patch a microradian across
    // and outshines the full Moon (1/400,000 of the Sun).
    expect(forwardBackgroundFlux(1.2e6)).toBeGreaterThan(1 / 400_000);
    // Rayleigh-Jeans estimate: (pi / gamma^2) B_V(2 gamma T) ln(2 gamma T / T_V) over the Sun's.
    const g = 1.2e6;
    const Tv = 26399.6;
    const rj = (Math.PI / g ** 2) * ((2 * g * 2.7255) / Tv) * Math.log((2 * g * 2.7255) / Tv) / ((1 / Math.expm1(Tv / 5772)) * Math.PI * (959.63 / 206264.806) ** 2);
    expect(forwardBackgroundFlux(g) / rj).toBeGreaterThan(0.7);
    expect(forwardBackgroundFlux(g) / rj).toBeLessThan(1.4);
    // Slower, it fades fast: at gamma 100 the patch is only 540 K at most.
    expect(forwardBackgroundFlux(100)).toBeLessThan(1e-15);
  });
});
