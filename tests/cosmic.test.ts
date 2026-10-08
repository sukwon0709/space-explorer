import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BETELGEUSE_SN, LightCurve, SN1987A, popovPlateau, ringDelays, ringGeometry,
} from '../src/core/supernova';
import { Binary, GW150914, bandpass, chirpMass, matchModel } from '../src/core/merger';
import { AU, BARNARD_68, IsothermalSphere, MSUN, StarBirth, YEAR_S } from '../src/core/starbirth';
import { skyBasis } from '../src/core/blackholes';

/**
 * Gate for the live cosmic events: each is computed from physics, and checked here
 * against what was measured.
 */

const sn = JSON.parse(readFileSync('public/data/cosmic/sn1987a.json', 'utf8')).points as Array<[number, number, string]>;
const gw = JSON.parse(readFileSync('public/data/cosmic/gw150914.json', 'utf8'));
const pms = JSON.parse(readFileSync('public/data/cosmic/pms.json', 'utf8'));
const PEAK = 0.4231;

describe('SN 1987A', () => {
  const lc = new LightCurve(SN1987A.light);

  it('follows its measured bolometric light curve (Suntzeff 1991, Bouchet 1991) to 0.06 dex rms', () => {
    let s = 0;
    for (const [day, l] of sn) s += (Math.log10(lc.luminosity(day)) - l) ** 2;
    const rms = Math.sqrt(s / sn.length);
    expect(sn.length).toBeGreaterThan(50);
    expect(rms).toBeLessThan(0.06);
    // No stretch of the curve off by more than 0.2 dex.
    for (const [day, l] of sn) expect(Math.abs(Math.log10(lc.luminosity(day)) - l), `day ${day}`).toBeLessThan(0.2);
  });

  it('needs the nickel-56 the gamma-ray lines measured (0.071 ± 0.003 Suns, Seitenzahl et al. 2014)', () => {
    expect(Math.abs(SN1987A.light.ni56 - 0.071)).toBeLessThan(0.006);
  });

  it('peaks near magnitude 2.9 in V from Earth in May 1987', () => {
    let best = Infinity, when = 0;
    for (let day = 40; day < 140; day += 0.5) {
      const v = lc.absV(day) + 5 * Math.log10(SN1987A.distancePc / 10) + SN1987A.av;
      if (v < best) { best = v; when = day; }
    }
    expect(Math.abs(best - 2.9)).toBeLessThan(0.4);
    expect(when).toBeGreaterThan(70);
    expect(when).toBeLessThan(100);
  });

  it('lights its inner ring from the near side at day 75 ± 2.6 and the far side at day 390 ± 1.8 (Gould and Uza 1998)', () => {
    const g = ringGeometry(SN1987A)!;
    const n = skyBasis(SN1987A.ra, SN1987A.dec).n;
    const [near, far] = ringDelays(g, [-n[0], -n[1], -n[2]]);
    expect(Math.abs(near - 75)).toBeLessThan(5);
    expect(Math.abs(far - 390)).toBeLessThan(5);
  });
});

describe('Betelgeuse as a supernova (computed)', () => {
  const lc = new LightCurve(BETELGEUSE_SN.light);
  it('has a type II-P plateau of about 100-140 days at Popov\'s luminosity', () => {
    const p = popovPlateau(764, 14, 1);
    expect(p.days).toBeGreaterThan(100);
    expect(p.days).toBeLessThan(140);
    const mid = lc.luminosity(60);
    expect(Math.abs(Math.log10(mid / p.luminosity))).toBeLessThan(0.3);
    expect(lc.luminosity(p.days + 40)).toBeLessThan(mid / 5);
  });
  it('would shine at about magnitude -11 from Earth, brighter than the half Moon', () => {
    let best = Infinity;
    for (let day = 1; day < 100; day++) best = Math.min(best, lc.absV(day) + 5 * Math.log10(BETELGEUSE_SN.distancePc / 10) + BETELGEUSE_SN.av);
    expect(best).toBeLessThan(-9.5);
    expect(best).toBeGreaterThan(-12.5);
  });
});

describe('GW150914', () => {
  const b = new Binary(GW150914);
  b.useNumericalRelativity(gw.unfilteredH, gw.unfilteredT0 - PEAK, gw.unfilteredDt);

  it('ends as LIGO measured: 63.1 +3.4/-3.0 Suns, spin 0.69 ± 0.05, 3.1 ± 0.4 Suns radiated (GWTC-1)', () => {
    expect(Math.abs(b.finalMass - 63.1)).toBeLessThan(3);
    expect(Math.abs(b.finalSpin - 0.69)).toBeLessThan(0.05);
    expect(Math.abs(b.mass - b.finalMass - 3.1)).toBeLessThan(0.4);
    expect(Math.abs(chirpMass(GW150914.m1, GW150914.m2) - 28.6)).toBeLessThan(0.5);
  });

  it('rings down near 250 Hz (Abbott et al. 2016: f = 251 ± 8 Hz)', () => {
    const rd = b.ringdown();
    expect(Math.abs(rd.frequency - 251)).toBeLessThan(15);
    expect(rd.tau).toBeGreaterThan(0.003);
    expect(rd.tau).toBeLessThan(0.0045);
  });

  it('enters LIGO\'s band (35 Hz) about 0.1-0.2 s before the peak', () => {
    const t = b.timeAtFrequency(35) * (1 + GW150914.z);
    expect(t).toBeLessThan(-0.08);
    expect(t).toBeGreaterThan(-0.2);
  });

  it('matches the strain Hanford recorded (overlap > 0.75) and the numerical-relativity waveform (> 0.85)', () => {
    const nr = matchModel(b, gw.nrH, gw.nrT0 - PEAK, gw.dt, [35, 350], [-0.004, 0.004, 0.0004]);
    expect(nr.overlap).toBeGreaterThan(0.85);
    const obs = matchModel(b, gw.observedH, gw.t0 - PEAK, gw.dt, [35, 350], [-0.004, 0.004, 0.0004]);
    expect(obs.overlap).toBeGreaterThan(0.75);
  });

  it("has a post-Newtonian inspiral with the shape of numerical relativity's before the merger (overlap > 0.97)", () => {
    // From the start of the NR waveform (0.17 s before the peak) to 23 ms before it. The
    // pure post-Newtonian model's own merger comes about 20 ms late, so it is matched
    // over a time shift.
    const t0 = gw.unfilteredT0 - PEAK;
    const start = Math.ceil((-0.17 - t0) / gw.unfilteredDt);
    const end = Math.floor((-0.023 - t0) / gw.unfilteredDt);
    const pn = new Binary(GW150914);
    const m = matchModel(pn, gw.unfilteredH.slice(start, end), t0 + start * gw.unfilteredDt, gw.unfilteredDt, undefined, [-0.03, 0.03, 0.0004]);
    expect(m.overlap).toBeGreaterThan(0.97);
  });

  it('peaks at about 3.6e56 erg/s in gravitational waves (GWTC-1: 3.6 +0.4/-0.4 e56)', () => {
    let peak = 0;
    for (let t = -0.02; t < 0.01; t += 0.0002) peak = Math.max(peak, b.luminosity(t));
    expect(peak).toBeGreaterThan(2.8e56);
    expect(peak).toBeLessThan(4.6e56);
  });

  it('the filter used for the comparison passes the band and stops what is outside', () => {
    const dt = 1 / 4096, n = 4096;
    const tone = (f: number) => Array.from({ length: n }, (_, k) => Math.sin(2 * Math.PI * f * k * dt));
    const rms = (x: ArrayLike<number>) => Math.sqrt(Array.from(x).slice(n / 4, (3 * n) / 4).reduce((s, v) => s + v * v, 0) / (n / 2));
    expect(rms(bandpass(tone(120), dt, 35, 350))).toBeGreaterThan(0.6);
    expect(rms(bandpass(tone(8), dt, 35, 350))).toBeLessThan(0.05);
  });
});

describe('Barnard 68 to a star', () => {
  const birth = new StarBirth(BARNARD_68, pms.tracks['0.700']);

  it('is a Bonnor-Ebert sphere past the critical point (xi = 6.45; Alves et al. 2001 find 6.9)', () => {
    const c = new IsothermalSphere().critical();
    expect(Math.abs(c.xi - 6.45)).toBeLessThan(0.05);
    expect(BARNARD_68.xiMax).toBeGreaterThan(c.xi);
  });

  it('has the mass and size Alves et al. measured: 2.1 Suns within 12,500 AU', () => {
    expect(Math.abs(birth.mass / MSUN - 2.1)).toBeLessThan(0.3);
    expect(Math.abs(birth.radius / AU - 12500) / 12500).toBeLessThan(0.2);
    // Dimming behind its centre: Alves et al. measured A_V up to about 30.
    expect(birth.peakExtinction()).toBeGreaterThan(20);
    expect(birth.peakExtinction()).toBeLessThan(40);
  });

  it('collapses inside out: a star in about 0.1 Myr, its envelope gone by about 0.5 Myr', () => {
    expect(birth.firstCore / YEAR_S).toBeGreaterThan(5e4);
    expect(birth.firstCore / YEAR_S).toBeLessThan(2e5);
    const early = birth.state(1.5e5), late = birth.state(1e6);
    expect(early.star).toBeGreaterThan(0);
    expect(['0', 'I']).toContain(early.stage);
    expect(late.envelope).toBeLessThan(0.05 * birth.mass / MSUN);
  });

  it('makes a star of about a third of the cloud: 0.7 Suns, a K-type T Tauri star and then a K dwarf', () => {
    const tt = birth.state(3e6), ms = birth.state(9e7);
    expect(Math.abs(ms.star - 0.72)).toBeLessThan(0.1);
    expect(tt.teff).toBeGreaterThan(3800);
    expect(tt.teff).toBeLessThan(4600);
    expect(ms.luminosity).toBeLessThan(tt.luminosity);
    expect(ms.stage).toBe('MS');
  });

  it('keeps every gram: what has not fallen in is still in the envelope', () => {
    for (const years of [5e4, 1e5, 2e5, 4e5]) {
      const s = birth.state(years);
      const arrived = (s.star + s.disc) / BARNARD_68.efficiency;
      expect(Math.abs(arrived + s.envelope - birth.mass / MSUN)).toBeLessThan(0.02);
    }
  });
});
