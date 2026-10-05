import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ephemeris, type Vec3 } from '../src/core/ephemeris';
import { Orientation } from '../src/core/orientation';
import { icrfToScene } from '../src/core/frames';
import { enu, geodeticToBody, MOON_SPHERE, WGS84, type Shape } from '../src/core/geodesy';
import { buildTileGeometry } from '../src/core/terrainmesh';
import { tileSize } from '../src/core/tilestore';
import { utcToTdb } from '../src/core/time';

/**
 * The milestone 2 gate: fly from street level to the Moon with no visible jitter.
 * Jitter comes from float32 rounding on the GPU, so this replays the render path for
 * terrain (float64 on the CPU, then float32 vertex offsets, mesh position and model
 * matrix, and float32 arithmetic in the vertex shader) for camera positions from
 * 1.5 m above the Grand Canyon out to the Moon and down to 1.5 m above its surface,
 * and measures how far each vertex lands from where float64 maths puts it, in pixels.
 */

const load = (name: string) => {
  const file = readFileSync(new URL(`../public/data/${name}`, import.meta.url));
  return new Ephemeris(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
};
const ephemeris = load('de440.bin');
const orientation = new Orientation(load('orientation.bin'));
const tdb = utcToTdb(Date.parse('2026-10-05T17:30:00Z'));
const DEG = Math.PI / 180;
/** Pixels per radian for a 50 degree field of view on a 760 px tall window. */
const PIXELS_PER_RADIAN = 760 / (2 * Math.tan(25 * DEG));
const GRID = 65;
const f = Math.fround;

const scenePosition = (id: number): Vec3 => icrfToScene(ephemeris.position(id, tdb, [0, 0, 0]));

/** Float32 matrix-vector product with float32 rounding after every operation, as a GPU does it. */
function gpuApply(m: number[], v: Vec3, t: Vec3): Vec3 {
  const out: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let s = f(f(m[k * 3]) * v[0]);
    s = f(s + f(f(m[k * 3 + 1]) * v[1]));
    s = f(s + f(f(m[k * 3 + 2]) * v[2]));
    out[k] = f(s + f(t[k]));
  }
  return out;
}

const angle = (a: Vec3, b: Vec3) => {
  const cross = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  return Math.atan2(cross, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
};

/**
 * Worst on-screen error (pixels) of the vertices of the tile under `lon`/`lat` on `body`,
 * seen from `distance` km away at 30 degrees above the horizon. The tile level follows
 * the renderer's level of detail: tiles about as wide as the camera is far away.
 */
function worstPixelError(body: number, shape: Shape, lon: number, lat: number, height: number, distance: number): number {
  const centre = scenePosition(body);
  const b = orientation.bodyToScene(body, tdb);
  const toScene = (v: Vec3): Vec3 => [0, 1, 2].map((k) => b[k * 3] * v[0] + b[k * 3 + 1] * v[1] + b[k * 3 + 2] * v[2]) as Vec3;

  const ground = geodeticToBody(shape, lon * DEG, lat * DEG, height);
  const local = enu(lon * DEG, lat * DEG);
  const dir = [0, 1, 2].map((k) => Math.cos(30 * DEG) * local.north[k] + Math.sin(30 * DEG) * local.up[k]);
  const eyeBody: Vec3 = [0, 1, 2].map((k) => ground[k] + distance * dir[k]) as Vec3;
  const eye = [0, 1, 2].map((k) => centre[k] + toScene(eyeBody)[k]) as Vec3;

  const level = Math.max(0, Math.min(20, Math.round(Math.log2((180 * DEG * shape.a) / Math.max(distance, 0.001)))));
  const size = tileSize(level);
  const x = Math.min(2 ** (level + 1) - 1, Math.floor((lon + 180) / size));
  const y = Math.min(2 ** level - 1, Math.floor((90 - lat) / size));
  const tile = buildTileGeometry(shape, level, x, y, GRID, null);

  // Mesh position: tile centre minus camera, subtracted in float64, stored as float32.
  const c = toScene(tile.center);
  const meshPosition = [0, 1, 2].map((k) => f(centre[k] + c[k] - eye[k])) as Vec3;
  let worst = 0;
  const west = -180 + x * size, north = 90 - y * size;
  for (let j = 0; j < GRID; j += 8) {
    for (let i = 0; i < GRID; i += 8) {
      const vi = (j * GRID + i) * 3;
      const v: Vec3 = [tile.positions[vi], tile.positions[vi + 1], tile.positions[vi + 2]];
      const gpu = gpuApply(Array.from(b), v, meshPosition);
      const exactBody = geodeticToBody(shape, (west + (size * i) / (GRID - 1)) * DEG, (north - (size * j) / (GRID - 1)) * DEG, 0);
      const exact = [0, 1, 2].map((k) => centre[k] + toScene(exactBody)[k] - eye[k]) as Vec3;
      worst = Math.max(worst, angle(gpu, exact) * PIXELS_PER_RADIAN);
    }
  }
  return worst;
}

describe('jitter gate: street level to the Moon', () => {
  const steps = 48;
  const distances = Array.from({ length: steps }, (_, i) => 0.0015 * (384400 / 0.0015) ** (i / (steps - 1)));

  it('keeps Grand Canyon terrain within 0.05 px from 1.5 m up to Moon distance', () => {
    const errors = distances.map((d) => worstPixelError(399, WGS84, -112.1, 36.1, 0, d));
    console.log(`Earth terrain: worst ${Math.max(...errors).toFixed(4)} px (at ${distances[errors.indexOf(Math.max(...errors))].toPrecision(3)} km)`);
    expect(Math.max(...errors)).toBeLessThan(0.05);
  });

  it('keeps lunar terrain within 0.05 px from Earth distance down to 1.5 m', () => {
    const errors = distances.map((d) => worstPixelError(301, MOON_SPHERE, 23.47, 0.67, 0, d)); // Apollo 11 site
    console.log(`Moon terrain: worst ${Math.max(...errors).toFixed(4)} px (at ${distances[errors.indexOf(Math.max(...errors))].toPrecision(3)} km)`);
    expect(Math.max(...errors)).toBeLessThan(0.05);
  });

  it('would jitter without the floating origin (absolute float32 positions)', () => {
    // The same 1.5 m view with positions sent to the GPU relative to the solar system
    // barycentre: errors of hundreds of pixels, which is what the floating origin avoids.
    const earth = scenePosition(399);
    const eye = earth.map((v, k) => v + (k === 0 ? 6378.1385 : 0)) as Vec3;
    const point = earth.map((v, k) => v + (k === 0 ? 6378.137 : 0.001)) as Vec3;
    const rel = point.map((v, k) => f(v) - f(eye[k])) as Vec3;
    const exact = point.map((v, k) => v - eye[k]) as Vec3;
    expect(angle(rel, exact) * PIXELS_PER_RADIAN).toBeGreaterThan(100);
  });
});
