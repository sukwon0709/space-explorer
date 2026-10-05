import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Vec3 } from '../src/core/ephemeris';
import { BLACK_HOLES, companionOffsetKm, gravRadius, julianDate, viewInclination } from '../src/core/blackholes';
import { blur, modelImage, ringDiameter, shadowDiameter } from '../src/core/ehtimage';
import { Fate, criticalCurve, hamiltonian, horizon, isco, photonFromCamera, trace } from '../src/core/kerr';
import { EHT_BEAM } from '../src/ui/ehtpanel';

// Milestone 6 gate: the ray tracer reproduces the analytic shadow of a Kerr black hole,
// and the modelled Sgr A* and M87* show rings of the size the Event Horizon Telescope
// measured, at the masses and distances the app uses.

const AU_KM = 149597870.7;
const PC_KM = 3.0856775814913673e13;
const UAS = Math.PI / 180 / 3600 / 1e6;
const hole = (name: string) => BLACK_HOLES.find((b) => b.name === name)!;
const eht = JSON.parse(readFileSync('public/data/blackholes/eht.json', 'utf8')) as Record<string, { field: number }>;

/** A ray from a camera far out at inclination `incl`, aimed at image-plane point (alpha, beta) (M). */
function fate(a: number, incl: number, alpha: number, beta: number): Fate {
  const R = 1e4;
  const s = Math.sin(incl), c = Math.cos(incl);
  const cam: Vec3 = [R * s, 0, R * c];
  const er: Vec3 = [s, 0, c], et: Vec3 = [c, 0, -s], ef: Vec3 = [0, 1, 0];
  const d = [0, 1, 2].map((k) => -er[k] + (alpha * ef[k] - beta * et[k]) / R);
  const l = Math.hypot(d[0], d[1], d[2]);
  return trace(photonFromCamera(a, cam, d.map((v) => v / l) as Vec3), { eps: 0.01, maxSteps: 40000 }).fate;
}

describe('Kerr ray tracing', () => {
  it('has the textbook horizons and innermost stable orbits', () => {
    expect(horizon(0)).toBe(2);
    expect(horizon(0.9)).toBeCloseTo(1.43589, 5);
    expect(isco(0)).toBeCloseTo(6, 10);
    expect(isco(0.9)).toBeCloseTo(2.32088, 4);
    expect(isco(1)).toBeCloseTo(1, 6);
  });

  it('keeps photons on the light cone', () => {
    const d = [-0.6, 0.1, -0.79], l = Math.hypot(d[0], d[1], d[2]);
    const ph = photonFromCamera(0.9, [6, 2, 3], [d[0] / l, d[1] / l, d[2] / l]);
    expect(Math.abs(hamiltonian(0.9, ph.L, ph.state))).toBeLessThan(1e-10);
    let worst = 0;
    // (Away from the horizon, where p_r itself diverges in these coordinates.)
    trace(ph, { eps: 0.03, onStep: (_, to) => { if (to[0] > 2) worst = Math.max(worst, Math.abs(hamiltonian(0.9, ph.L, to))); } });
    expect(worst).toBeLessThan(1e-3);
  });

  // The shadow's edge from integrating rays matches Bardeen's (1973) analytic curve to 0.1%.
  for (const [a, inclDeg] of [[0, 60], [0.9, 17], [0.9, 60], [0.99, 90], [0.99, 30]] as const) {
    it(`matches Bardeen's shadow for a = ${a} seen ${inclDeg}° from the axis`, () => {
      const incl = (inclDeg * Math.PI) / 180;
      const curve = criticalCurve(a, incl, 720);
      for (let k = 0; k < curve.length; k += Math.floor(curve.length / 12)) {
        const [x, y] = curve[k];
        expect(fate(a, incl, x * 0.999, y * 0.999)).toBe(Fate.Horizon);
        expect(fate(a, incl, x * 1.001, y * 1.001)).toBe(Fate.Escaped);
      }
    });
  }

  it('passes smoothly over the poles', () => {
    // Rays crossing just beside the spin axis: Boyer-Lindquist coordinates are singular
    // there, and the escape direction must still change smoothly across it.
    for (const a of [0, 0.9]) {
      const th = (75 * Math.PI) / 180, R = 18;
      const cam: Vec3 = [R * Math.sin(th), 0, R * Math.cos(th)];
      const up = [-Math.cos(th), 0, Math.sin(th)];
      let prev: Vec3 | undefined;
      for (let i = -40; i <= 40; i++) {
        const x = i * 0.0005;
        const d = [0, 1, 2].map((k) => -cam[k] / R + x * (k === 1 ? 1 : 0) + 0.45 * up[k]);
        const l = Math.hypot(d[0], d[1], d[2]);
        const res = trace(photonFromCamera(a, cam, d.map((v) => v / l) as Vec3), { eps: 0.07, maxSteps: 2000 });
        expect(res.fate).toBe(Fate.Escaped);
        if (prev) expect(Math.acos(Math.min(1, dotv(prev, res.direction!)))).toBeLessThan(0.01);
        prev = res.direction!;
      }
    }
  });
});

describe('Black holes against the Event Horizon Telescope', () => {
  it('has the angular sizes the EHT inferred (theta_g = GM / c^2 D)', () => {
    const thetaG = (name: string) => gravRadius(hole(name)) / (hole(name).dist * PC_KM) / UAS;
    // Sgr A*: 4.8 (+1.4, -0.7) microarcseconds (EHT 2022, Paper I); M87*: 3.8 +- 0.4 (EHT 2019, Paper VI).
    expect(thetaG('Sgr A*')).toBeGreaterThan(4.1);
    expect(thetaG('Sgr A*')).toBeLessThan(6.2);
    expect(thetaG('M87*')).toBeGreaterThan(3.4);
    expect(thetaG('M87*')).toBeLessThan(4.2);
  });

  for (const [name, key] of [['Sgr A*', 'sgra-eht'], ['M87*', 'm87-eht']] as const) {
    it(`shows ${name}'s ring at the size the EHT measured`, () => {
      const bh = hole(name);
      const n = 64, field = eht[key].field;
      // The modelled 230 GHz image seen from Earth, blurred to the EHT's resolution,
      // measured the way the EHT measures its images.
      const img = blur(modelImage(bh, n, field, 0.05), n, (EHT_BEAM * n) / field);
      const ring = ringDiameter(img, n, field);
      expect(Math.abs(ring - bh.eht!.ring)).toBeLessThan(2 * bh.eht!.error);
      // The shadow (critical curve) lies inside the bright ring.
      expect(shadowDiameter(bh, viewInclination(bh))).toBeLessThan(ring);
    }, 120000);
  }
});

describe('Orbits around black holes', () => {
  it('weighs Sgr A* with S2 (Kepler’s third law)', () => {
    const { stars } = JSON.parse(readFileSync('public/data/blackholes/sstars.json', 'utf8')) as { stars: Array<{ name: string; a: number; period: number }> };
    const s2 = stars.find((s) => s.name === 'S2')!;
    const aAU = s2.a * hole('Sgr A*').dist;
    const mass = aAU ** 3 / s2.period ** 2;
    expect(Math.abs(mass / hole('Sgr A*').mass - 1)).toBeLessThan(0.02);
  });

  it('puts the companions on their measured orbits', () => {
    for (const bh of BLACK_HOLES) {
      const c = bh.companion;
      if (!c) continue;
      const o = c.orbit;
      const at = (jd: number) => Math.hypot(...companionOffsetKm(bh, jd)) / AU_KM;
      // Closest at periastron, farthest half an orbit later, and back after a period.
      expect(at(o.tp)).toBeCloseTo(o.a * (1 - o.e), 3);
      expect(at(o.tp + o.period / 2)).toBeCloseTo(o.a * (1 + o.e), 3);
      const now = julianDate(0);
      const p0 = companionOffsetKm(bh, now), p1 = companionOffsetKm(bh, now + o.period);
      expect(Math.hypot(p0[0] - p1[0], p0[1] - p1[1], p0[2] - p1[2]) / AU_KM).toBeLessThan(1e-6);
      // Kepler's third law with the black hole's and the star's masses.
      const total = o.a ** 3 / (o.period / 365.25) ** 2;
      expect(Math.abs(total / (bh.mass + c.mass) - 1)).toBeLessThan(0.08);
    }
  });
});

const dotv = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
