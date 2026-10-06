import type { Vec3 } from './ephemeris';
import { geodeticToBody, type Shape } from './geodesy';
import { tileBounds, type HeightTile } from './tilestore';

export interface TileGeometry {
  /** Tile centre in the body frame, km, float64. Vertices are stored relative to it. */
  center: Vec3;
  /** Vertex positions relative to `center`, km (float32 is plenty for these small offsets). */
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  water: Float32Array;
  /** Ground coordinates for close-up detail, metres, modulo DETAIL_PERIOD (see below). */
  detail: Float32Array;
  indices: Uint32Array;
  /** Radius of a sphere around `center` containing every vertex, km. */
  radius: number;
  /** Body-frame corner and centre points on the surface, for culling and LOD. */
  samples: Vec3[];
  minHeight: number;
  maxHeight: number;
  /** n x n heights (km) on the tile's grid, rows north to south. */
  heights: Float64Array;
}

const DEG = Math.PI / 180;
/**
 * Close-up detail is a noise that repeats every DETAIL_PERIOD metres. Each tile stores
 * east and north metres (R lon cos lat, R lat) less a whole number of periods, chosen
 * near its centre: small numbers on the GPU, and continuous from tile to tile.
 */
export const DETAIL_PERIOD = 100;

/**
 * Builds one terrain tile. Heights come from `source`, the tile itself or an ancestor
 * (sampled bilinearly over the matching sub-rectangle) when no deeper data exists.
 * Every position is computed in float64 and only the offset from the tile centre is
 * rounded to float32, so precision does not depend on the size of the planet.
 */
export function buildTileGeometry(
  shape: Shape,
  level: number,
  x: number,
  y: number,
  n: number,
  source: { tile: HeightTile; level: number; x: number; y: number; grid: number } | null,
): TileGeometry {
  const [west, south, east, north] = tileBounds(level, x, y);
  const count = n * n;
  const skirt = 4 * n;
  const lonLat = (i: number, j: number): [number, number] => [west + ((east - west) * i) / (n - 1), north - ((north - south) * j) / (n - 1)];

  const heights = new Float64Array(count);
  const wet = new Float32Array(count);
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  if (source) {
    const [sw, , se, sn] = tileBounds(source.level, source.x, source.y);
    const size = se - sw;
    const g = source.grid;
    const { heights: h, water } = source.tile;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const [lon, lat] = lonLat(i, j);
        const fx = Math.min(g - 1, Math.max(0, ((lon - sw) / size) * (g - 1)));
        const fy = Math.min(g - 1, Math.max(0, ((sn - lat) / size) * (g - 1)));
        const x0 = Math.min(g - 2, Math.floor(fx)), y0 = Math.min(g - 2, Math.floor(fy));
        const tx = fx - x0, ty = fy - y0;
        const k = y0 * g + x0;
        const v = (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - ty) + (h[k + g] * (1 - tx) + h[k + g + 1] * tx) * ty;
        const w = (water[k] * (1 - tx) + water[k + 1] * tx) * (1 - ty) + (water[k + g] * (1 - tx) + water[k + g + 1] * tx) * ty;
        heights[j * n + i] = v;
        wet[j * n + i] = w;
        minHeight = Math.min(minHeight, v);
        maxHeight = Math.max(maxHeight, v);
      }
    }
  } else {
    minHeight = maxHeight = 0;
  }

  // Float64 surface points.
  const points = new Float64Array(count * 3);
  const p: Vec3 = [0, 0, 0];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [lon, lat] = lonLat(i, j);
      geodeticToBody(shape, lon * DEG, lat * DEG, heights[j * n + i], p);
      points.set(p, (j * n + i) * 3);
    }
  }
  const [cLon, cLat] = lonLat((n - 1) / 2, (n - 1) / 2);
  const center = geodeticToBody(shape, cLon * DEG, cLat * DEG, (minHeight + maxHeight) / 2);

  const total = count + skirt;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  const water = new Float32Array(total);
  const detail = new Float32Array(total * 2);
  const R = shape.a * 1000;
  const ox = Math.floor((R * cLon * DEG * Math.cos(cLat * DEG)) / DETAIL_PERIOD) * DETAIL_PERIOD;
  const oy = Math.floor((R * cLat * DEG) / DETAIL_PERIOD) * DETAIL_PERIOD;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [lon, lat] = lonLat(i, j);
      const k = j * n + i;
      detail[k * 2] = R * lon * DEG * Math.cos(lat * DEG) - ox;
      detail[k * 2 + 1] = R * lat * DEG - oy;
    }
  }
  let radius = 0;
  for (let k = 0; k < count; k++) {
    const dx = points[k * 3] - center[0], dy = points[k * 3 + 1] - center[1], dz = points[k * 3 + 2] - center[2];
    positions[k * 3] = dx;
    positions[k * 3 + 1] = dy;
    positions[k * 3 + 2] = dz;
    radius = Math.max(radius, Math.hypot(dx, dy, dz));
    uvs[k * 2] = (k % n) / (n - 1);
    uvs[k * 2 + 1] = Math.floor(k / n) / (n - 1);
    water[k] = wet[k];
  }

  // Normals from neighbouring points (central differences, one-sided at the edges).
  const at = (i: number, j: number) => ((Math.min(n - 1, Math.max(0, j)) * n) + Math.min(n - 1, Math.max(0, i))) * 3;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const e = at(i + 1, j), w = at(i - 1, j), s = at(i, j + 1), nn = at(i, j - 1);
      const ex = points[e] - points[w], ey = points[e + 1] - points[w + 1], ez = points[e + 2] - points[w + 2];
      const nx = points[nn] - points[s], ny = points[nn + 1] - points[s + 1], nz = points[nn + 2] - points[s + 2];
      // east x north = up
      let ux = ey * nz - ez * ny, uy = ez * nx - ex * nz, uz = ex * ny - ey * nx;
      const len = Math.hypot(ux, uy, uz) || 1;
      ux /= len; uy /= len; uz /= len;
      const k = (j * n + i) * 3;
      normals[k] = ux;
      normals[k + 1] = uy;
      normals[k + 2] = uz;
    }
  }

  // Skirts: a copy of each edge dropped below the surface hides cracks between levels.
  // Deep enough for the small mismatches where a landing site's data meets the global data.
  const width = (east - west) * DEG * shape.a;
  const depth = Math.max(0.003, (width / (n - 1)) * 1.5, width * 0.04);
  const edges: number[] = [];
  for (let i = 0; i < n; i++) edges.push(i); // north edge
  for (let i = 0; i < n; i++) edges.push((n - 1) * n + i); // south
  for (let j = 0; j < n; j++) edges.push(j * n); // west
  for (let j = 0; j < n; j++) edges.push(j * n + n - 1); // east
  edges.forEach((src, s) => {
    const k = count + s;
    const ux = normals[src * 3], uy = normals[src * 3 + 1], uz = normals[src * 3 + 2];
    positions[k * 3] = positions[src * 3] - ux * depth;
    positions[k * 3 + 1] = positions[src * 3 + 1] - uy * depth;
    positions[k * 3 + 2] = positions[src * 3 + 2] - uz * depth;
    normals.copyWithin(k * 3, src * 3, src * 3 + 3);
    uvs[k * 2] = uvs[src * 2];
    uvs[k * 2 + 1] = uvs[src * 2 + 1];
    water[k] = water[src];
    detail[k * 2] = detail[src * 2];
    detail[k * 2 + 1] = detail[src * 2 + 1];
  });

  const indices: number[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const strip = (from: number, skirtFrom: number, step: number, flip: boolean) => {
    for (let s = 0; s < n - 1; s++) {
      const a = from + s * step, b = from + (s + 1) * step;
      const sa = skirtFrom + s, sb = skirtFrom + s + 1;
      if (flip) indices.push(a, b, sa, b, sb, sa);
      else indices.push(a, sa, b, b, sa, sb);
    }
  };
  strip(0, count, 1, true); // north
  strip((n - 1) * n, count + n, 1, false); // south
  strip(0, count + 2 * n, n, false); // west
  strip(n - 1, count + 3 * n, n, true); // east

  const samples: Vec3[] = [0, n - 1, (n - 1) * n, count - 1, Math.floor(count / 2)].map((k) => [points[k * 3], points[k * 3 + 1], points[k * 3 + 2]]);
  return { center, positions, normals, uvs, water, detail, indices: new Uint32Array(indices), radius, samples, minHeight, maxHeight, heights };
}
