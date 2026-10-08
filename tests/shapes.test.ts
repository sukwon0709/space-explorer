import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ephemeris, type Vec3 } from '../src/core/ephemeris';
import { GM } from '../src/core/gravity';
import { Polyhedron, TriangleGrid, type Chunk } from '../src/core/shape';
import { ShapeWalker, type ShapeWalkWorld } from '../src/core/shapewalk';
import { utcToTdb } from '../src/core/time';
import type { WalkInput } from '../src/core/walker';
import shapes from '../src/generated/shapes.json';
import reference from './fixtures/shapes-reference.json';
import visited from './fixtures/visited-reference.json';

/**
 * The small bodies spacecraft visited (pipeline/build_shapes.py, build_visited.py): their
 * gravity from the shape models, their orbits, and walking on them.
 */

interface Entry { id: number; gm: number; meanRadius: number; radius: number; rotation?: { pm: number[] } }
const BODIES = shapes.bodies as unknown as Record<string, Entry>;
const REF = reference as unknown as Record<string, { id: number; volume: number; gm: number; points: Vec3[]; accel: Vec3[] }>;

const load = (path: string) => {
  const f = readFileSync(new URL(`../public/data/${path}`, import.meta.url));
  return f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength);
};
const polyhedron = (slug: string) => Polyhedron.parse(load(`shapes/${slug}/gravity.bin`), BODIES[slug].gm);
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

describe('Small bodies: gravity of the shape models', () => {
  it('matches an independent polyhedron computation (numpy, the same mesh) to 1e-6', () => {
    for (const [slug, ref] of Object.entries(REF)) {
      const poly = polyhedron(slug);
      ref.points.forEach((p, k) => {
        const a = poly.acceleration(p);
        const err = len([a[0] - ref.accel[k][0], a[1] - ref.accel[k][1], a[2] - ref.accel[k][2]]) / len(ref.accel[k]);
        // The app reads the mesh as float32.
        expect(err, `${slug} point ${k}`).toBeLessThan(1e-6);
      });
    }
  });

  it('tends to GM/r^2 far away (within 3% at six times the radius: they are lumpy)', () => {
    for (const [slug, ref] of Object.entries(REF)) {
      const poly = polyhedron(slug);
      // The Hera Didymos model's origin is 57 m from the centroid of the mesh, so the pull
      // of a uniform body is centred off it: up to 4% at 2.7 km.
      const tolerance = slug === 'didymos' ? 0.05 : 0.03;
      for (const p of ref.points.slice(-3)) {
        const g = len(poly.acceleration(p));
        expect(Math.abs(g / (BODIES[slug].gm / len(p) ** 2) - 1), slug).toBeLessThan(tolerance);
      }
    }
  });

  it('gives the bulk densities the missions measured', () => {
    // Mass from radio tracking over volume from the model: Lauretta et al. 2019 (Bennu),
    // Watanabe et al. 2019 (Ryugu), Fujiwara et al. 2006 (Itokawa), Yeomans et al. 2000
    // (Eros), Pätzold et al. 2016 (67P), Daly et al. 2023 (Didymos), kg/m^3.
    const measured: Record<string, number> = { bennu: 1190, ryugu: 1190, itokawa: 1900, eros: 2670, '67p': 533, didymos: 2790 };
    for (const [slug, rho] of Object.entries(measured)) {
      const G = 6.6743e-20; // km^3/(kg s^2)
      const volume = REF[slug]?.volume ?? (4 / 3) * Math.PI * BODIES[slug].meanRadius ** 3;
      const density = BODIES[slug].gm / G / volume / 1e9;
      expect(Math.abs(density / rho - 1), `${slug}: ${density.toFixed(0)} kg/m^3`).toBeLessThan(0.06);
    }
  });

  it('sets each body’s GM for the rest of the app', () => {
    for (const e of Object.values(BODIES)) expect(GM[e.id]).toBe(e.gm);
  });
});

describe('Small bodies: orbits', () => {
  const ephemeris = new Ephemeris(load('de440.bin'));
  ephemeris.add(load('moons-visited.bin'));
  const cases = (visited as unknown as { cases: Array<{ center: number; target: number; tdb: number; km: Vec3; tolerance_km: number }> }).cases;

  it('follows JPL Horizons for every visited body, 1960 to 2060', () => {
    for (const c of cases) {
      const a = ephemeris.position(c.target, c.tdb, [0, 0, 0]);
      const b = ephemeris.position(c.center, c.tdb, [0, 0, 0]);
      const err = len([a[0] - b[0] - c.km[0], a[1] - b[1] - c.km[1], a[2] - b[2] - c.km[2]]);
      expect(err, `${c.target} from ${c.center} at ${c.tdb}`).toBeLessThan(c.tolerance_km);
    }
  });

  it('puts Didymos opposite Dimorphos about their barycentre, by their masses', () => {
    const e = new Ephemeris(load('de440.bin'));
    e.add(load('moons-visited.bin'));
    const q = GM[120065803] / (GM[2065803] + GM[120065803]);
    const t = cases.find((c) => c.target === 120065803)!.tdb;
    const bary = e.position(2065803, t, [0, 0, 0]);
    e.setBarycentre(2065803, 120065803, q);
    const primary = e.position(2065803, t, [0, 0, 0]);
    const moon = e.position(120065803, t, [0, 0, 0]);
    for (let k = 0; k < 3; k++) {
      // Mass-weighted mean of the two is the barycentre.
      expect((1 - q) * primary[k] + q * moon[k] - bary[k]).toBeCloseTo(0, 6);
    }
    // Dimorphos orbits 1.19 km from Didymos (Daly et al. 2023).
    expect(len([moon[0] - primary[0], moon[1] - primary[1], moon[2] - primary[2]])).toBeGreaterThan(1.1);
    expect(len([moon[0] - primary[0], moon[1] - primary[1], moon[2] - primary[2]])).toBeLessThan(1.3);
  });

  it('shortens Dimorphos’s orbit by 33 minutes when DART strikes', () => {
    // Thomas et al. 2023 (Nature 616, 448): 11.921 h before the impact, 11.372 ± 0.017 h after.
    const e = new Ephemeris(load('de440.bin'));
    e.add(load('moons-visited.bin'));
    const period = (utc: number) => {
      const t0 = utcToTdb(utc);
      const rel = (t: number): Vec3 => {
        const a = e.position(120065803, t, [0, 0, 0]), b = e.position(2065803, t, [0, 0, 0]);
        return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      };
      // Mean time between crossings of the first direction, over two days, to a second.
      const x0 = rel(t0), x1 = rel(t0 + 600);
      const n: Vec3 = [x0[1] * x1[2] - x0[2] * x1[1], x0[2] * x1[0] - x0[0] * x1[2], x0[0] * x1[1] - x0[1] * x1[0]];
      const side = (t: number) => { const x = rel(t); return n[0] * (x0[1] * x[2] - x0[2] * x[1]) + n[1] * (x0[2] * x[0] - x0[0] * x[2]) + n[2] * (x0[0] * x[1] - x0[1] * x[0]); };
      const ahead = (t: number) => { const x = rel(t); return x[0] * x0[0] + x[1] * x0[1] + x[2] * x0[2] > 0; };
      const crossings: number[] = [];
      for (let t = t0 + 3600; t < t0 + 3 * 86400; t += 60) {
        if (side(t - 60) < 0 && side(t) >= 0 && ahead(t)) {
          let lo = t - 60, hi = t;
          while (hi - lo > 0.5) { const m = (lo + hi) / 2; if (side(m) < 0) lo = m; else hi = m; }
          crossings.push(hi);
        }
      }
      return (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1) / 3600;
    };
    expect(Math.abs(period(Date.UTC(2022, 8, 18)) - 11.921)).toBeLessThan(0.005);
    expect(Math.abs(period(Date.UTC(2022, 9, 20)) - 11.372)).toBeLessThan(0.017);
  });
});

describe('Small bodies: walking', () => {
  /** A body's gravity mesh as a walkable chunk (coarser than the app's, same physics). */
  function world(slug: string): ShapeWalkWorld {
    const poly = polyhedron(slug);
    const v = poly.verts;
    const positions = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) positions[i] = v[i];
    const chunk: Chunk = { path: '', origin: [0, 0, 0], positions, normals: new Float32Array(v.length), indices: poly.faces, surface: poly.faces.length / 3, error: 0 };
    const grid = new TriangleGrid(chunk);
    const period = 2 * Math.PI / (((BODIES[slug].rotation?.pm[1] ?? 0) * Math.PI) / 180 / 86400 || 1e-30);
    return {
      gravity: (p, out = [0, 0, 0]) => {
        const a = poly.acceleration(p);
        out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
        return out;
      },
      spin: [0, 0, (2 * Math.PI) / period],
      raycast: (o, d, maxT) => grid.raycast(o, d, maxT),
      gm: BODIES[slug].gm,
      radius: BODIES[slug].radius,
    };
  }
  const STAND: WalkInput = { move: [0, 0], run: false, jump: false };
  /** On the ground below a direction, settled. */
  function standing(w: ShapeWalkWorld, dir: Vec3): ShapeWalker {
    const r = len(dir);
    const d: Vec3 = [dir[0] / r, dir[1] / r, dir[2] / r];
    const hit = w.raycast([d[0] * w.radius * 2, d[1] * w.radius * 2, d[2] * w.radius * 2], [-d[0], -d[1], -d[2]], w.radius * 2)!;
    const north: Vec3 = [0, 0, 1];
    const walker = new ShapeWalker([...hit.point], north, hit.normal);
    walker.onGround = true;
    walker.step(w, 1, 1, STAND);
    return walker;
  }

  it('stands still on Bennu’s equator for a minute', () => {
    const w = world('bennu');
    const walker = standing(w, [1, 0.2, 0.05]);
    const start: Vec3 = [...walker.p];
    for (let k = 0; k < 60; k++) walker.step(w, 1, 1 / 60, STAND);
    expect(walker.onGround).toBe(true);
    expect(len([walker.p[0] - start[0], walker.p[1] - start[1], walker.p[2] - start[2]]) * 1000).toBeLessThan(0.05);
  });

  it('comes down from a gentle jump on Bennu, slowly; a full jump leaves for good', () => {
    const w = world('bennu');
    const walker = standing(w, [0.3, 1, 0.2]);
    expect(walker.escapeSpeed(w) * 1000).toBeGreaterThan(0.15);
    expect(walker.escapeSpeed(w) * 1000).toBeLessThan(0.3);
    walker.step(w, 0.1, 0.1, { ...STAND, jump: true });
    let t = 0.1, event;
    while (!event && t < 6 * 3600) {
      event = walker.step(w, 10, 1 / 60, STAND);
      t += 10;
    }
    expect(event).toBe('landed');
    // Up at under half the escape speed, the hop lasts tens of minutes.
    expect(t).toBeGreaterThan(600);

    const leaper = standing(w, [0.3, 1, 0.2]);
    leaper.step(w, 0.1, 0.1, { ...STAND, run: true, jump: true });
    let escaped;
    for (let k = 0; k < 2000 && !escaped; k++) escaped = leaper.step(w, 10, 1 / 60, STAND);
    expect(escaped).toBe('escaped');
  });
});
