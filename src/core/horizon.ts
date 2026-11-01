/**
 * Horizon maps: for every vertex of a terrain tile, how high the terrain around it rises
 * in each of eight directions, found by marching rays outward over the height field
 * (Max 1988, "Horizon mapping: shadows for bump-mapped surfaces"). The renderer compares
 * the Sun's elevation with the horizon in the Sun's direction to cast terrain shadows
 * (crater floors at the Moon's terminator, canyon walls, peaks catching the first light
 * while the plain below is still dark), and uses the open sky above each point to dim
 * the sky's light in valleys.
 *
 * The rays see the tile's own heights and, beyond it, whatever terrain is loaded around
 * it (`outside`), out to two tile widths; further hills are left out.
 */

const DEG = Math.PI / 180;

/** Directions, clockwise from north, at 45 degree steps. */
export const HORIZON_DIRECTIONS = 8;
/** Horizon elevations are stored as bytes over this range (degrees). */
export const HORIZON_MIN_DEG = -20;
export const HORIZON_MAX_DEG = 70;

/**
 * @param heights n x n heights (km), rows north to south, columns west to east
 * @param bounds the tile's [west, south, east, north] in degrees
 * @param radius the body's radius (km)
 * @param outside height (km) at a longitude/latitude (degrees) off the tile
 * @returns n x n x 8 bytes: horizon elevation per direction, 0..255 over HORIZON_MIN_DEG..HORIZON_MAX_DEG
 */
export function computeHorizons(
  heights: Float64Array,
  n: number,
  bounds: [number, number, number, number],
  radius: number,
  outside: (lonDeg: number, latDeg: number) => number,
): Uint8Array {
  const [west, south, east, north] = bounds;
  const width = east - west;
  const height = north - south;

  // The surroundings, two tile widths each way, on a coarser grid sampled once.
  const M = 49;
  const ew = west - 2 * width, en = north + 2 * height;
  const estep = (5 * width) / (M - 1), nstep = (5 * height) / (M - 1);
  const ext = new Float64Array(M * M);
  for (let j = 0; j < M; j++) {
    const lat = Math.max(-90, Math.min(90, en - j * nstep));
    for (let i = 0; i < M; i++) {
      let lon = ew + i * estep;
      lon = ((((lon + 180) % 360) + 360) % 360) - 180;
      ext[j * M + i] = outside(lon, lat);
    }
  }
  const bilinear = (grid: Float64Array, size: number, fx: number, fy: number) => {
    const x0 = Math.max(0, Math.min(size - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(size - 2, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - x0)), ty = Math.min(1, Math.max(0, fy - y0));
    const a = grid[y0 * size + x0], b = grid[y0 * size + x0 + 1];
    const c = grid[(y0 + 1) * size + x0], d = grid[(y0 + 1) * size + x0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
  const heightAt = (lon: number, lat: number) => {
    if (lon >= west && lon <= east && lat >= south && lat <= north) {
      return bilinear(heights, n, ((lon - west) / width) * (n - 1), ((north - lat) / height) * (n - 1));
    }
    return bilinear(ext, M, (lon - ew) / estep, (en - lat) / nstep);
  };

  // Rays from every second vertex (n odd), filled in between: a quarter of the work, and
  // the horizon changes slowly from one vertex to the next.
  const stride = n % 2 === 1 && n > 9 ? 2 : 1;
  const out = new Uint8Array(n * n * HORIZON_DIRECTIONS);
  const cellNorth = (height / (n - 1)) * DEG * radius;
  const reach = 2 * Math.max(width, height) * DEG * radius;
  const dirs = Array.from({ length: HORIZON_DIRECTIONS }, (_, k) => [Math.sin((k * 2 * Math.PI) / HORIZON_DIRECTIONS), Math.cos((k * 2 * Math.PI) / HORIZON_DIRECTIONS)]);
  const range = HORIZON_MAX_DEG - HORIZON_MIN_DEG;
  for (let j = 0; j < n; j += stride) {
    const lat = north - (j / (n - 1)) * height;
    const cosLat = Math.max(0.01, Math.cos(lat * DEG));
    const cellEast = (width / (n - 1)) * DEG * radius * cosLat;
    const first = 0.5 * Math.min(cellEast, cellNorth);
    for (let i = 0; i < n; i += stride) {
      const lon = west + (i / (n - 1)) * width;
      const h0 = heights[j * n + i];
      for (let k = 0; k < HORIZON_DIRECTIONS; k++) {
        const [de, dn] = dirs[k];
        let best = -Infinity; // tangent of the elevation
        // Steps growing by 45% each time: fine near the point, coarse far out.
        for (let d = first; d <= reach; d *= 1.45) {
          const h = heightAt(lon + ((d * de) / (radius * cosLat)) / DEG, lat + ((d * dn) / radius) / DEG);
          // The surface curves away below the local horizontal: d^2 / 2R lower.
          const slope = (h - h0 - (d * d) / (2 * radius)) / d;
          if (slope > best) best = slope;
        }
        const t = (Math.atan(best) / DEG - HORIZON_MIN_DEG) / range;
        out[(j * n + i) * HORIZON_DIRECTIONS + k] = Math.round(Math.min(1, Math.max(0, t)) * 255);
      }
    }
  }
  if (stride === 2) {
    const D = HORIZON_DIRECTIONS;
    const avg = (dst: number, a: number, b: number) => {
      for (let k = 0; k < D; k++) out[dst * D + k] = (out[a * D + k] + out[b * D + k] + 1) >> 1;
    };
    // Odd columns on even rows, then odd rows from the rows above and below.
    for (let j = 0; j < n; j += 2) for (let i = 1; i < n; i += 2) avg(j * n + i, j * n + i - 1, j * n + i + 1);
    for (let j = 1; j < n; j += 2) for (let i = 0; i < n; i++) avg(j * n + i, (j - 1) * n + i, (j + 1) * n + i);
  }
  return out;
}

/** Decodes a stored horizon byte to an elevation in degrees. */
export function horizonDegrees(byte: number): number {
  return HORIZON_MIN_DEG + (byte / 255) * (HORIZON_MAX_DEG - HORIZON_MIN_DEG);
}
