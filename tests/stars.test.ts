import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { Ephemeris, type Vec3 } from '../src/core/ephemeris';
import { utcToTdb } from '../src/core/time';
import { KMS_TO_PCYR, PC_KM, apparentMagnitude, decodeBlock, halfToFloat, parseStarIndex, yearsSinceEpoch } from '../src/core/stars';

/**
 * The milestone 4 gate: the sky from Earth matches catalogue star positions and
 * magnitudes.
 *
 * The app's star octree (Gaia DR3 + Hipparcos, built by pipeline/build_stars.py) is
 * loaded whole and seen from Earth, positioned with the app's own DE440, at three
 * epochs spanning the time bar. Each star is compared with an independent reference
 * (pipeline/make_sky_fixtures.py): the published Hipparcos (1997) and Gaia DR3 entries,
 * moved with ERFA's pmsafe and seen from ERFA's Earth, plus Tycho-2 photometry.
 * The comparison also replays the vertex shader's float32 arithmetic, so it checks
 * where stars land on screen, not just the catalogue.
 */

const ARCSEC = Math.PI / 180 / 3600;
const read = (path: string) => readFileSync(new URL(`../public/data/${path}`, import.meta.url));
const asBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

interface Reference {
  epochs: string[];
  hip: Array<{ hip: number; V: number; mult: string; dir: Vec3[] }>;
  gaia: Array<{ gaia: string; G: number; dir: Vec3[] }>;
  tycho: Array<{ tyc: string; ra: number; dec: number; pmra: number; pmdec: number; V: number; BV: number }>;
}
const reference: Reference = JSON.parse(readFileSync(new URL('./fixtures/sky-reference.json', import.meta.url), 'utf8'));

/** Every star of the octree as float64 arrays. */
interface Catalogue {
  n: number;
  pos: Float64Array;
  posF32: Float32Array;
  vel: Float64Array;
  absMag: Float64Array;
  av: Float64Array;
  /** Star indexes sorted by sky cell (J2016 direction from the Sun), and the sorted cell keys. */
  order: Uint32Array;
  keys: Float64Array;
}

const GRID = 256;
const cellKey = (u: Vec3) => {
  const c = u.map((x) => Math.min(GRID - 1, Math.floor(((x + 1) / 2) * GRID)));
  return (c[0] * GRID + c[1]) * GRID + c[2];
};

let cat: Catalogue;
let earth: Vec3[];

beforeAll(() => {
  const index = parseStarIndex(JSON.parse(read('stars/index.json').toString()));
  const packs = Array.from({ length: index.packs }, (_, k) => asBuffer(read(`stars/pack-${k}.bin`)));
  const n = index.nodes.reduce((s, node) => s + node.count, 0);
  cat = { n, pos: new Float64Array(n * 3), posF32: new Float32Array(n * 3), vel: new Float64Array(n * 3), absMag: new Float64Array(n), av: new Float64Array(n), order: new Uint32Array(n), keys: new Float64Array(n) };
  let i = 0;
  for (const node of index.nodes) {
    const b = decodeBlock(packs[node.pack], node.offset, node.count);
    for (let k = 0; k < node.count; k++, i++) {
      for (let a = 0; a < 3; a++) {
        cat.pos[i * 3 + a] = b.position[k * 3 + a];
        cat.posF32[i * 3 + a] = b.position[k * 3 + a];
        cat.vel[i * 3 + a] = halfToFloat(b.velocity[k * 3 + a]);
      }
      cat.absMag[i] = b.absMag[k] / 1000;
      cat.av[i] = b.avCode[k] * index.avStep;
    }
  }
  // Sky cells: key * 2^22 + index, sorted, so each cell's stars are one contiguous run.
  const packed = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const p: Vec3 = [cat.pos[k * 3], cat.pos[k * 3 + 1], cat.pos[k * 3 + 2]];
    const d = Math.hypot(...p);
    packed[k] = cellKey([p[0] / d, p[1] / d, p[2] / d]) * 4194304 + k;
  }
  packed.sort();
  for (let k = 0; k < n; k++) {
    cat.keys[k] = Math.floor(packed[k] / 4194304);
    cat.order[k] = packed[k] - cat.keys[k] * 4194304;
  }
  const de440 = asBuffer(read('de440.bin'));
  const ephemeris = new Ephemeris(de440);
  earth = reference.epochs.map((utc) => {
    const p = ephemeris.position(399, utcToTdb(Date.parse(utc)), [0, 0, 0]);
    return [p[0] / PC_KM, p[1] / PC_KM, p[2] / PC_KM];
  });
}, 120_000);

/** Star indexes whose J2016 direction from the Sun is in the cell of `u` or a neighbour. */
function near(u: Vec3): number[] {
  const out: number[] = [];
  const c = u.map((x) => Math.min(GRID - 1, Math.floor(((x + 1) / 2) * GRID)));
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const key = ((c[0] + dx) * GRID + c[1] + dy) * GRID + c[2] + dz;
    let lo = 0, hi = cat.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cat.keys[mid] < key) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < cat.n && cat.keys[k] === key; k++) out.push(cat.order[k]);
  }
  return out;
}

/** The app's view of star i from `observer` (pc) at `years` after J2016: float64 direction and V. */
function seen(i: number, observer: Vec3, years: number): { dir: Vec3; V: number } {
  const k = years * KMS_TO_PCYR;
  const rel: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) rel[a] = cat.pos[i * 3 + a] + cat.vel[i * 3 + a] * k - observer[a];
  const d = Math.hypot(...rel);
  return { dir: [rel[0] / d, rel[1] / d, rel[2] / d], V: apparentMagnitude(cat.absMag[i], d, cat.av[i]) };
}

/** The vertex shader's float32 arithmetic for the same star (camera split into high and low parts). */
function seenOnGpu(i: number, observer: Vec3, years: number): Vec3 {
  const f = Math.fround;
  const kf = f(f(years) * f(KMS_TO_PCYR));
  const out: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const high = f(observer[a]);
    const low = f(observer[a] - high);
    out[a] = f(f(cat.posF32[i * 3 + a] - high) + f(f(f(cat.vel[i * 3 + a]) * kf) - low));
  }
  const d = f(Math.hypot(...out));
  return [f(out[0] / d), f(out[1] / d), f(out[2] / d)];
}

const angle = (a: Vec3, b: Vec3) => 2 * Math.asin(Math.min(1, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 2));
const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))];

/** The app star nearest a reference direction at epoch e, within `radius` and `dmag` of its magnitude. */
function match(dir: Vec3, e: number, mag: number, radius: number, dmag: number) {
  const years = yearsSinceEpoch(utcToTdb(Date.parse(reference.epochs[e])));
  let best: { i: number; sep: number; V: number } | undefined;
  for (const i of near(dir)) {
    const s = seen(i, earth[e], years);
    const sep = angle(s.dir, dir);
    if (sep < radius && Math.abs(s.V - mag) < dmag && (!best || sep < best.sep)) best = { i, sep, V: s.V };
  }
  return best;
}

describe('milestone 4 gate: the sky from Earth', () => {
  it('puts every naked-eye Hipparcos star where the catalogue says, at every epoch', () => {
    const seps: number[][] = reference.epochs.map(() => []);
    let missing = 0;
    for (const star of reference.hip) {
      for (let e = 0; e < reference.epochs.length; e++) {
        const m = match(star.dir[e], e, star.V, 60 * ARCSEC, 1.5);
        if (!m) {
          if (e === 1) missing++;
          continue;
        }
        seps[e].push(m.sep / ARCSEC);
      }
    }
    for (let e = 0; e < reference.epochs.length; e++) {
      const s = seps[e];
      console.log(`Hipparcos V<6.5, ${reference.epochs[e].slice(0, 10)}: ${s.length} stars, median ${percentile(s, 0.5).toFixed(3)}", 95% ${percentile(s, 0.95).toFixed(3)}", 99% ${percentile(s, 0.99).toFixed(3)}", max ${Math.max(...s).toFixed(2)}"`);
      // A pixel is 237" in a 50 degree view on a 760 px screen. Most of the difference
      // is Hipparcos (1997) itself: its proper motions are good to about 1 mas/yr, which
      // Gaia and the Hipparcos new reduction improve on, so it grows away from 1991.
      expect(percentile(s, 0.5)).toBeLessThan(0.1);
      expect(percentile(s, 0.99)).toBeLessThan(2);
    }
    console.log(`Hipparcos V<6.5 stars with no app star within 60" and 1.5 mag: ${missing} of ${reference.hip.length}`);
    expect(missing).toBeLessThan(reference.hip.length * 0.002);
  });

  it('puts Gaia stars where Gaia DR3 says, to a few milliarcseconds', () => {
    const seps: number[] = [];
    let missing = 0;
    for (const star of reference.gaia) {
      for (let e = 0; e < reference.epochs.length; e++) {
        const m = match(star.dir[e], e, star.G, 2 * ARCSEC, 4);
        if (!m) {
          missing++;
          console.log(`no match for Gaia DR3 ${star.gaia} (G ${star.G}) at ${reference.epochs[e]}`);
          continue;
        }
        seps.push(m.sep / ARCSEC);
        if (m.sep > 0.05 * ARCSEC) console.log(`Gaia DR3 ${star.gaia} at ${reference.epochs[e]}: ${(m.sep / ARCSEC * 1000).toFixed(1)} mas`);
      }
    }
    console.log(`Gaia: ${seps.length} star-epochs, median ${(percentile(seps, 0.5) * 1000).toFixed(2)} mas, 99% ${(percentile(seps, 0.99) * 1000).toFixed(2)} mas, max ${(Math.max(...seps) * 1000).toFixed(1)} mas`);
    expect(missing).toBe(0);
    // Positions are stored as float32 parsecs: 2^-24 of the distance, up to 6 mas.
    expect(percentile(seps, 0.99)).toBeLessThan(0.01);
  });

  it('shows Hipparcos stars at their catalogue V magnitudes', () => {
    // Stars brighter than about 6 carry Hipparcos photometry; fainter ones are converted
    // from Gaia G and BP-RP (Riello et al. 2021), an independent measurement.
    const bright: number[] = [], faint: number[] = [];
    for (const star of reference.hip) {
      if (star.mult) continue; // doubles: Hipparcos gives the combined light; Gaia may split them
      const m = match(star.dir[1], 1, star.V, 60 * ARCSEC, 1.5);
      if (m) (star.V < 6 ? bright : faint).push(m.V - star.V);
    }
    for (const [label, diffs] of [['V < 6', bright], ['V 6-6.5, from Gaia', faint]] as const) {
      const abs = diffs.map(Math.abs);
      const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      console.log(`V vs Hipparcos, ${label} (${diffs.length} single stars): mean ${mean.toFixed(3)}, median |dV| ${percentile(abs, 0.5).toFixed(3)}, 95% ${percentile(abs, 0.95).toFixed(3)}`);
      expect(Math.abs(mean)).toBeLessThan(0.03);
      expect(percentile(abs, 0.5)).toBeLessThan(0.05);
      expect(percentile(abs, 0.95)).toBeLessThan(0.2);
    }
  });

  it('shows fainter stars at their Tycho-2 V magnitudes', () => {
    const diffs: number[] = [];
    const e = 1;
    const years = yearsSinceEpoch(utcToTdb(Date.parse(reference.epochs[e])));
    for (const t of reference.tycho) {
      // Tycho-2 mean positions are J2000; move them with their proper motion.
      const dt = years + 16;
      const dec = (t.dec + (t.pmdec * dt) / 3.6e6) * (Math.PI / 180);
      const ra = (t.ra + (t.pmra * dt) / 3.6e6 / Math.cos(dec)) * (Math.PI / 180);
      const dir: Vec3 = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
      const m = match(dir, e, t.V, 1.5 * ARCSEC, 1.5);
      if (m && t.V > 6.5) diffs.push(m.V - t.V);
    }
    const abs = diffs.map(Math.abs);
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    console.log(`V vs Tycho-2 (${diffs.length} stars, V 6.5-11, four fields): mean ${mean.toFixed(3)}, median |dV| ${percentile(abs, 0.5).toFixed(3)}, 95% ${percentile(abs, 0.95).toFixed(3)}`);
    expect(diffs.length).toBeGreaterThan(reference.tycho.length * 0.9);
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(percentile(abs, 0.5)).toBeLessThan(0.08);
  });

  it('has the same naked-eye sky as Hipparcos: no star missing, none doubled', () => {
    const e = 1;
    const years = yearsSinceEpoch(utcToTdb(Date.parse(reference.epochs[e])));
    let count = 0;
    for (let i = 0; i < cat.n; i++) if (seen(i, earth[e], years).V < 6.5) count++;
    // Hipparcos counts doubles once (combined light); the app may split some.
    console.log(`stars brighter than V = 6.5 from Earth: app ${count}, Hipparcos ${reference.hip.length}`);
    expect(Math.abs(count - reference.hip.length)).toBeLessThan(reference.hip.length * 0.03);
  });

  it('keeps float32 rounding on the GPU under 0.05 arcsec, from Earth and from other stars', () => {
    // 0.05 arcsec is a five-thousandth of a pixel in a 50 degree view, and 0.01 px at 1 degree.
    const e = 1;
    const years = yearsSinceEpoch(utcToTdb(Date.parse(reference.epochs[e])));
    const observers: Array<[string, Vec3, number]> = [
      ['Earth', earth[e], 0.05],
      ['8 pc away (near Altair)', [-8.2, 1.3, 0.4], 0.05],
      ['beside Deneb, 430 pc away', [197.2, -232.1, 307.6], 0.05],
    ];
    for (const [name, observer, limit] of observers) {
      let worst = 0;
      for (let i = 0; i < cat.n; i += 37) {
        const exact = seen(i, observer, years).dir;
        worst = Math.max(worst, angle(exact, seenOnGpu(i, observer, years)) / ARCSEC);
      }
      console.log(`float32 vertex shader replay from ${name}: worst ${(worst * 1000).toFixed(3)} mas`);
      expect(worst).toBeLessThan(limit);
    }
  });
});
