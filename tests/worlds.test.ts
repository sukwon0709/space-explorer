import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import manifest from '../src/generated/tiles.json';
import { GM } from '../src/core/gravity';
import { Walker, type WalkInput, type WalkWorld } from '../src/core/walker';

/**
 * The other worlds' terrain (pipeline/build_worlds.py) against published measurements
 * of their relief, and walking on them at their real gravity.
 */

const DEG = Math.PI / 180;
const GRID = 65;
const CHUNK_ROOTS = manifest.scheme.chunkRoots;
interface World { body: number; name: string; radius: number }
const WORLDS = (manifest as unknown as { worlds: World[] }).worlds;
const world = (name: string) => WORLDS.find((w) => w.name === name)!;

/** Height (km above the world's reference sphere) at lon/lat (degrees), from the deepest global tiles. */
function heightAt(body: number, lon: number, lat: number): number {
  const layer = manifest.layers.find((l) => l.body === body && l.kind === 'height' && l.bbox[2] - l.bbox[0] === 360)! as {
    id: string; levels: number[]; heightUnit?: number; heightOffset?: number;
  };
  const level = layer.levels[1];
  const size = 180 / 2 ** level;
  const fx = (lon + 180) / size, fy = (90 - lat) / size;
  const x = Math.min(Math.floor(fx), 2 ** (level + 1) - 1), y = Math.min(Math.floor(fy), 2 ** level - 1);
  const root = Math.max(...CHUNK_ROOTS.filter((r) => r <= level));
  const pack = readFileSync(`public/data/tiles/${layer.id}/${root}-${x >> (level - root)}-${y >> (level - root)}.bin`);
  const count = pack.readUInt32LE(8);
  for (let i = 0; i < count; i++) {
    const o = 16 + 20 * i;
    if (pack[o] !== level || pack.readUInt32LE(o + 4) !== x || pack.readUInt32LE(o + 8) !== y) continue;
    const blob = inflateSync(pack.subarray(pack.readUInt32LE(o + 12), pack.readUInt32LE(o + 12) + pack.readUInt32LE(o + 16)));
    const q = new Int16Array(blob.buffer, blob.byteOffset, GRID * GRID);
    const h = (i: number, j: number) => ((q[j * GRID + i] & ~1) * (layer.heightUnit ?? 0.5) + (layer.heightOffset ?? 0)) / 1000;
    const u = (fx - x) * (GRID - 1), v = (fy - y) * (GRID - 1);
    const i0 = Math.min(Math.floor(u), GRID - 2), j0 = Math.min(Math.floor(v), GRID - 2);
    const tu = u - i0, tv = v - j0;
    return (h(i0, j0) * (1 - tu) + h(i0 + 1, j0) * tu) * (1 - tv) + (h(i0, j0 + 1) * (1 - tu) + h(i0 + 1, j0 + 1) * tu) * tv;
  }
  throw new Error(`no tile ${level}/${x}/${y} in ${layer.id}`);
}

/** Points on a circle of `radiusKm` (along the surface) around lat/lon (degrees). */
function ring(w: World, lat: number, lon: number, radiusKm: number, n = 36): [number, number][] {
  const out: [number, number][] = [];
  const d = radiusKm / w.radius, la = lat * DEG;
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    // Destination along a great circle, bearing a from north.
    const lat2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(a));
    const lon2 = lon * DEG + Math.atan2(Math.sin(a) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(lat2));
    out.push([((lon2 / DEG + 540) % 360) - 180, lat2 / DEG]);
  }
  return out;
}
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
/** Highest point within `radiusKm` of lat/lon (degrees), sampled on rings. */
function peak(w: World, lat: number, lon: number, radiusKm: number): number {
  let best = heightAt(w.body, lon, lat);
  for (let r = radiusKm / 8; r <= radiusKm; r += radiusKm / 8) for (const [x, y] of ring(w, lat, lon, r)) best = Math.max(best, heightAt(w.body, x, y));
  return best;
}

describe('Worlds: relief matches published measurements', () => {
  it('covers every solid world with a natural-colour or tinted map', () => {
    const names = WORLDS.map((w) => w.name);
    console.log(`worlds with terrain: ${names.join(', ')}`);
    for (const name of ['mercury', 'ceres', 'vesta', 'io', 'europa', 'ganymede', 'callisto', 'enceladus', 'pluto', 'charon']) expect(names).toContain(name);
  });

  it('Mercury: Rachmaninoff basin holds the planet\'s lowest ground, about 5.4 km down', () => {
    // Becker et al. 2016 (MESSENGER global DEM): heights span -5.38 km (Rachmaninoff)
    // to +4.48 km about the 2439.4 km sphere. Rachmaninoff: 27.6 N, 57.6 E (IAU).
    const w = world('mercury');
    let low = Infinity;
    for (let r = 0; r <= 120; r += 15) for (const [x, y] of r ? ring(w, 27.6, 57.6, r) : [[57.6, 27.6] as [number, number]]) low = Math.min(low, heightAt(w.body, x, y));
    console.log(`Mercury: Rachmaninoff floor ${low.toFixed(2)} km (Becker et al. 2016: -5.38)`);
    expect(low).toBeLessThan(-4.4);
    expect(low).toBeGreaterThan(-5.6);
  });

  it('Ceres: Ahuna Mons stands 4 to 5 km above its surroundings', () => {
    // Ruesch et al. 2016 (Science): a dome 17 x 21 km across, 4 km high on average and
    // 5 km at its highest; IAU centre 10.48 S, 43.80 W.
    const w = world('ceres');
    const top = peak(w, -10.48, -43.8, 12);
    const base = mean(ring(w, -10.48, -43.8, 25).map(([x, y]) => heightAt(w.body, x, y)));
    console.log(`Ceres: Ahuna Mons ${(top - base).toFixed(2)} km above the ground 25 km from its centre (Ruesch et al. 2016: 4-5)`);
    expect(top - base).toBeGreaterThan(3.5);
    expect(top - base).toBeLessThan(5.5);
  });

  it('Vesta: Rheasilvia\'s central peak rises 20-25 km above the basin floor', () => {
    // Schenk et al. 2012 (Science): the central mound stands 20-25 km above the floor of
    // the 500 km basin, in heights above Vesta's 285 x 229 km reference ellipsoid. IAU
    // centre 71.95 S, 86.30 E (the Claudia double-prime system of the Dawn maps and the
    // IAU rotation model).
    const w = world('vesta');
    const aboveEllipsoid = (lon: number, lat: number) =>
      w.radius + heightAt(w.body, lon, lat) - 1 / Math.hypot(Math.cos(lat * DEG) / 285, Math.sin(lat * DEG) / 229);
    // The mound is about 180 km across; the floor is the ring between it and the rim.
    let top = -Infinity;
    for (let r = 0; r <= 60; r += 10) for (const [x, y] of r ? ring(w, -71.95, 86.3, r, 72) : [[86.3, -71.95] as [number, number]]) top = Math.max(top, aboveEllipsoid(x, y));
    const floor = mean([100, 125, 150].flatMap((r) => ring(w, -71.95, 86.3, r, 72)).map(([x, y]) => aboveEllipsoid(x, y)));
    console.log(`Vesta: Rheasilvia central peak ${(top - floor).toFixed(1)} km above the basin floor (Schenk et al. 2012: 20-25)`);
    expect(top - floor).toBeGreaterThan(17);
    expect(top - floor).toBeLessThan(27);
  });

  it('Pluto: Sputnik Planitia lies 2.5 to 3.5 km below the surrounding uplands', () => {
    // Schenk et al. 2018 (Icarus): the ice sheet's surface is 2.5-3.5 km below the
    // uplands around it. IAU centre 19.51 N, 178.69 E; about 1000 km across. Uplands:
    // the highest tenth of the ground 600 to 900 km from the centre.
    const w = world('pluto');
    const inside = mean(ring(w, 19.51, 178.69, 150).concat(ring(w, 19.51, 178.69, 75)).map(([x, y]) => heightAt(w.body, x, y)));
    const around = [600, 700, 800, 900].flatMap((r) => ring(w, 19.51, 178.69, r, 90)).map(([x, y]) => heightAt(w.body, x, y)).sort((a, b) => a - b);
    const uplands = around[Math.floor(around.length * 0.9)];
    console.log(`Pluto: Sputnik Planitia ${(uplands - inside).toFixed(2)} km below the uplands (Schenk et al. 2018: 2.5-3.5)`);
    expect(uplands - inside).toBeGreaterThan(2.3);
    expect(uplands - inside).toBeLessThan(3.7);
  });

  it('Venus: Maxwell Montes rises about 11 km above the mean planetary radius', () => {
    // Ford and Pettengill 1992 (Magellan altimetry): mean planetary radius 6051.84 km;
    // Maxwell Montes peaks 10.8-11.0 km above it. IAU centre 65.2 N, 3.3 E. The tiles'
    // 9 km cells average the summit down by about half a kilometre.
    const w = world('venus');
    const top = peak(w, 65.2, 3.3, 300) + w.radius - 6051.84;
    console.log(`Venus: Maxwell Montes ${top.toFixed(2)} km above the mean radius (Ford and Pettengill 1992: 10.8-11)`);
    expect(top).toBeGreaterThan(10.0);
    expect(top).toBeLessThan(11.5);
  });

  it('Titan: its seas lie below the equatorial ground and are liquid, flat', () => {
    // Corlies et al. 2017: the poles are 300-500 m lower than the equator; Kraken,
    // Ligeia and Punga Maria share a level (Hayes et al. 2017). IAU centres.
    const w = world('titan');
    const equator = mean(ring(w, 0, 0, 0.1, 4).concat([0, 60, 120, 180, -60, -120].map((lon) => [lon, 0] as [number, number])).map(([x, y]) => heightAt(w.body, x, y)));
    const seas = [['Ligeia', 79.7, 112.1], ['Kraken', 68, 50], ['Punga', 85.1, 20.3]] as const;
    const levels = seas.map(([, lat, lon]) => heightAt(w.body, lon, lat));
    console.log(`Titan: seas at ${levels.map((h) => (h * 1000).toFixed(0)).join(', ')} m, equator ${(equator * 1000).toFixed(0)} m`);
    for (const h of levels) expect(h).toBeLessThan(equator - 0.2);
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(0.5);
  });

  it('bodies without an elevation model take their IAU shape: Iapetus is 34 km flatter at the poles', () => {
    // pck00011: 745.7 x 745.7 x 712.1 km.
    const w = world('iapetus');
    const equator = w.radius + heightAt(w.body, 0, 0);
    const pole = w.radius + heightAt(w.body, 0, 89.9);
    expect(equator).toBeCloseTo(745.7, 1);
    expect(pole).toBeCloseTo(712.1, 0);
  });
});

describe('Worlds: walking at their gravity', () => {
  const STAND: WalkInput = { move: [0, 0], run: false, jump: false };
  it('weighs what NASA lists on Mercury, Venus, Europa, Ceres, Titan and Pluto', () => {
    // NASA planetary fact sheets / JPL SSD, equatorial surface gravity (m/s^2).
    const cases: Array<[string, number, number, number]> = [
      ['mercury', 3.7, 0.03, 58.6462 * 86400],
      ['europa', 1.315, 0.02, 3.551181 * 86400],
      ['ceres', 0.28, 0.02, 9.074 * 3600],
      ['pluto', 0.62, 0.02, 6.387 * 86400],
      ['venus', 8.87, 0.03, 243.0226 * 86400],
      ['titan', 1.352, 0.02, 15.945 * 86400],
    ];
    for (const [name, nasa, tol, day] of cases) {
      const w = world(name);
      const ww: WalkWorld = { shape: { a: w.radius, b: w.radius }, gm: GM[w.body], spin: [0, 0, (2 * Math.PI) / day], ground: () => 0 };
      const walker = new Walker(ww.shape, 0, 0, 0);
      walker.onGround = true;
      walker.step(ww, 0.5, STAND);
      const g = Math.hypot(...walker.gravity(ww)) * 1000;
      console.log(`${name}: g = ${g.toFixed(3)} m/s^2 (NASA ${nasa})`);
      expect(Math.abs(g - nasa)).toBeLessThan(tol);
    }
  });
});
