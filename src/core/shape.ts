import type { Vec3 } from './ephemeris';

/**
 * Small bodies as their mission teams' shape models (pipeline/build_shapes.py): an
 * octree of triangle-mesh chunks at decreasing error, streamed as the camera comes
 * close; the body's gravity from a simplified copy of the same mesh; and queries for
 * standing on it (the ground under a point, a ray's first hit).
 *
 * Everything is in the body-fixed frame, km.
 */

/** One octree node from index.json: path (octant digits from the root), file, byte offset and length, error (km), leaf. */
export type NodeEntry = [path: string, file: string, offset: number, length: number, error: number, leaf: 0 | 1];

export interface ShapeIndex {
  id: number;
  name: string;
  kind: string;
  /** Triangles in the published model, and in the finest level here. */
  faces: number;
  kept: number;
  /** km^3, km^3/s^2. */
  volume: number;
  gm: number;
  gmMeasured: boolean;
  /** kg/m^3. */
  density: number;
  albedo: number;
  color: string;
  /** Farthest and nearest surface point from the centre, and the volume-equivalent radius, km. */
  radius: number;
  minRadius: number;
  meanRadius: number;
  /** Half the octree root's size. */
  half: number;
  /** Mean triangle edge at full resolution, km. */
  resolution: number;
  boulders: { cover: number; slope: number; max: number };
  nodes: NodeEntry[];
}

export interface Chunk {
  path: string;
  /** Vertex positions (km, body frame), as float32 offsets from `origin`. */
  origin: Vec3;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** Triangles of the surface; the skirt's come after them in `indices`. */
  surface: number;
  /** How far (km) this level's triangles may stray from the full-resolution model. */
  error: number;
}

/** Read one chunk (layout in pipeline/build_shapes.py). */
export function parseChunk(path: string, buffer: ArrayBuffer, offset: number): Chunk {
  const view = new DataView(buffer, offset);
  const nv = view.getUint32(0, true);
  const ni = view.getUint32(4, true);
  const lo: Vec3 = [view.getFloat32(8, true), view.getFloat32(12, true), view.getFloat32(16, true)];
  const size = view.getFloat32(20, true);
  const error = view.getFloat32(24, true);
  const flags = view.getUint32(28, true);
  const wide = flags & 1;
  let p = offset + 32;
  const q = new Uint16Array(buffer.slice(p, p + nv * 6));
  p += nv * 6;
  const oct = new Int8Array(buffer, p, nv * 2);
  p += nv * 2;
  p += (4 - ((p - offset) % 4)) % 4;
  const indices = wide ? new Uint32Array(buffer.slice(p, p + ni * 4)) : new Uint16Array(buffer.slice(p, p + ni * 2));
  // Positions relative to the box centre keep float32 precise to a millimetre or so.
  const centre: Vec3 = [lo[0] + size / 2, lo[1] + size / 2, lo[2] + size / 2];
  const positions = new Float32Array(nv * 3);
  const normals = new Float32Array(nv * 3);
  const s = size / 65535;
  for (let i = 0; i < nv; i++) {
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = q[i * 3 + k] * s - size / 2;
    let x = oct[i * 2] / 127, y = oct[i * 2 + 1] / 127;
    const z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) {
      const ox = x;
      x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
      y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
    }
    const l = Math.hypot(x, y, z);
    normals[i * 3] = x / l;
    normals[i * 3 + 1] = y / l;
    normals[i * 3 + 2] = z / l;
  }
  return { path, origin: centre, positions, normals, indices, surface: flags >>> 1, error };
}

// ---- gravity ------------------------------------------------------------------------

/**
 * The gravity of a homogeneous polyhedron, exactly (Werner & Scheeres 1997): a sum over
 * faces of their solid angles and over edges of a logarithmic term. Outside the body it
 * tends to GM/r^2; inside it falls off toward the centre. With the mass the spacecraft
 * measured and the volume of the shape model, the density is the body's bulk density.
 */
export class Polyhedron {
  readonly verts: Float64Array;
  readonly faces: Uint32Array;
  /** G times density, km^3/s^2 per km^3. */
  readonly gRho: number;
  private readonly F: Float64Array; // face normal dyads, 9 per face
  private readonly E: Float64Array; // edge dyads, 9 per edge
  private readonly edgeEnds: Uint32Array;
  private readonly edgeLen: Float64Array;

  constructor(verts: Float64Array | Float32Array, faces: Uint32Array, gm: number) {
    this.verts = Float64Array.from(verts);
    this.faces = faces;
    const nf = faces.length / 3;
    const v = this.verts;
    let volume = 0;
    const normals = new Float64Array(nf * 3);
    for (let f = 0; f < nf; f++) {
      const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
      const ab = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]];
      const ac = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]];
      const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      volume += (v[a] * n[0] + v[a + 1] * n[1] + v[a + 2] * n[2]) / 6;
      const l = Math.hypot(n[0], n[1], n[2]);
      for (let k = 0; k < 3; k++) normals[f * 3 + k] = n[k] / l;
    }
    this.gRho = gm / volume;
    this.F = new Float64Array(nf * 9);
    for (let f = 0; f < nf; f++) {
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) this.F[f * 9 + i * 3 + j] = normals[f * 3 + i] * normals[f * 3 + j];
    }
    // Each edge is shared by two faces: E = n_A n_A12^T + n_B n_B21^T, with n_12 the
    // edge's outward normal in each face's plane.
    const edges = new Map<number, number>();
    const ends: number[] = [];
    const dyads: number[] = [];
    const nv = v.length / 3;
    for (let f = 0; f < nf; f++) {
      for (let k = 0; k < 3; k++) {
        const p = faces[f * 3 + k], q = faces[f * 3 + (k + 1) % 3];
        const d = [v[q * 3] - v[p * 3], v[q * 3 + 1] - v[p * 3 + 1], v[q * 3 + 2] - v[p * 3 + 2]];
        const n = [normals[f * 3], normals[f * 3 + 1], normals[f * 3 + 2]];
        const e = [d[1] * n[2] - d[2] * n[1], d[2] * n[0] - d[0] * n[2], d[0] * n[1] - d[1] * n[0]];
        const l = Math.hypot(e[0], e[1], e[2]);
        const key = Math.min(p, q) * nv + Math.max(p, q);
        let idx = edges.get(key);
        if (idx === undefined) {
          idx = ends.length / 2;
          edges.set(key, idx);
          ends.push(p, q);
          for (let m = 0; m < 9; m++) dyads.push(0);
        }
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) dyads[idx * 9 + i * 3 + j] += n[i] * e[j] / l;
      }
    }
    this.E = Float64Array.from(dyads);
    this.edgeEnds = Uint32Array.from(ends);
    this.edgeLen = new Float64Array(ends.length / 2);
    for (let e = 0; e < this.edgeLen.length; e++) {
      const p = ends[e * 2] * 3, q = ends[e * 2 + 1] * 3;
      this.edgeLen[e] = Math.hypot(v[q] - v[p], v[q + 1] - v[p + 1], v[q + 2] - v[p + 2]);
    }
  }

  /** Gravitational acceleration at `p` (km/s^2, body frame). */
  acceleration(p: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
    const v = this.verts, faces = this.faces, F = this.F, E = this.E;
    let ax = 0, ay = 0, az = 0;
    const nf = faces.length / 3;
    for (let f = 0; f < nf; f++) {
      const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
      const r1x = v[a] - p[0], r1y = v[a + 1] - p[1], r1z = v[a + 2] - p[2];
      const r2x = v[b] - p[0], r2y = v[b + 1] - p[1], r2z = v[b + 2] - p[2];
      const r3x = v[c] - p[0], r3y = v[c + 1] - p[1], r3z = v[c + 2] - p[2];
      const l1 = Math.sqrt(r1x * r1x + r1y * r1y + r1z * r1z);
      const l2 = Math.sqrt(r2x * r2x + r2y * r2y + r2z * r2z);
      const l3 = Math.sqrt(r3x * r3x + r3y * r3y + r3z * r3z);
      const num = r1x * (r2y * r3z - r2z * r3y) + r1y * (r2z * r3x - r2x * r3z) + r1z * (r2x * r3y - r2y * r3x);
      const den = l1 * l2 * l3 + l1 * (r2x * r3x + r2y * r3y + r2z * r3z) + l2 * (r3x * r1x + r3y * r1y + r3z * r1z) + l3 * (r1x * r2x + r1y * r2y + r1z * r2z);
      const w = 2 * Math.atan2(num, den);
      const o = f * 9;
      ax += w * (F[o] * r1x + F[o + 1] * r1y + F[o + 2] * r1z);
      ay += w * (F[o + 3] * r1x + F[o + 4] * r1y + F[o + 5] * r1z);
      az += w * (F[o + 6] * r1x + F[o + 7] * r1y + F[o + 8] * r1z);
    }
    const ends = this.edgeEnds, len = this.edgeLen;
    for (let e = 0; e < len.length; e++) {
      const a = ends[e * 2] * 3, b = ends[e * 2 + 1] * 3;
      const rax = v[a] - p[0], ray = v[a + 1] - p[1], raz = v[a + 2] - p[2];
      const la = Math.sqrt(rax * rax + ray * ray + raz * raz);
      const lb = Math.hypot(v[b] - p[0], v[b + 1] - p[1], v[b + 2] - p[2]);
      const L = Math.log((la + lb + len[e]) / Math.max(la + lb - len[e], 1e-300));
      const o = e * 9;
      ax -= L * (E[o] * rax + E[o + 1] * ray + E[o + 2] * raz);
      ay -= L * (E[o + 3] * rax + E[o + 4] * ray + E[o + 5] * raz);
      az -= L * (E[o + 6] * rax + E[o + 7] * ray + E[o + 8] * raz);
    }
    out[0] = this.gRho * ax;
    out[1] = this.gRho * ay;
    out[2] = this.gRho * az;
    return out;
  }

  /** Read gravity.bin: u32 vertex and face counts, float32 vertices, u32 faces. */
  static parse(buffer: ArrayBuffer, gm: number): Polyhedron {
    const view = new DataView(buffer);
    const nv = view.getUint32(0, true), nf = view.getUint32(4, true);
    const verts = new Float32Array(buffer.slice(8, 8 + nv * 12));
    const faces = new Uint32Array(buffer.slice(8 + nv * 12, 8 + nv * 12 + nf * 12));
    return new Polyhedron(verts, faces, gm);
  }
}

// ---- triangle queries ------------------------------------------------------------------

export interface Hit {
  /** Distance along the ray, km. */
  t: number;
  point: Vec3;
  normal: Vec3;
}

/**
 * The triangles of one chunk in a uniform grid, for ray casts: walking needs the ground
 * under the feet many times a frame.
 */
export class TriangleGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly n: number;
  private readonly lo: Vec3;
  private readonly cell: number;
  /** Triangles that belong to the surface (the skirt's are left out). */
  readonly count: number;

  constructor(readonly chunk: Chunk, triangles = chunk.surface) {
    const p = chunk.positions;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < p.length; i++) {
      min = Math.min(min, p[i]);
      max = Math.max(max, p[i]);
    }
    this.count = triangles;
    this.n = Math.max(1, Math.min(48, Math.round(Math.cbrt(triangles / 2))));
    this.lo = [min, min, min];
    this.cell = (max - min) / this.n + 1e-9;
    const idx = chunk.indices;
    for (let t = 0; t < triangles; t++) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k] * 3;
        x0 = Math.min(x0, p[v]); x1 = Math.max(x1, p[v]);
        y0 = Math.min(y0, p[v + 1]); y1 = Math.max(y1, p[v + 1]);
        z0 = Math.min(z0, p[v + 2]); z1 = Math.max(z1, p[v + 2]);
      }
      const [i0, j0, k0] = this.ijk(x0, y0, z0), [i1, j1, k1] = this.ijk(x1, y1, z1);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
        const key = (i * this.n + j) * this.n + k;
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(t);
      }
    }
  }

  private ijk(x: number, y: number, z: number): [number, number, number] {
    const c = (v: number, o: number) => Math.max(0, Math.min(this.n - 1, Math.floor((v - o) / this.cell)));
    return [c(x, this.lo[0]), c(y, this.lo[1]), c(z, this.lo[2])];
  }

  /** First hit of a ray (origin in the body frame, unit direction) within `maxT` km. */
  raycast(origin: Vec3, dir: Vec3, maxT: number): Hit | undefined {
    const o = this.chunk.origin;
    const ox = origin[0] - o[0], oy = origin[1] - o[1], oz = origin[2] - o[2];
    // Walk the grid cells the ray passes (Amanatides & Woo), testing their triangles.
    const lo = this.lo, cell = this.cell, n = this.n;
    const span = cell * n;
    // Clip the ray to the grid's box.
    let t0 = 0, t1 = maxT;
    const org = [ox, oy, oz], d = dir;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-12) {
        if (org[k] < lo[k] || org[k] > lo[k] + span) return undefined;
        continue;
      }
      let a = (lo[k] - org[k]) / d[k], b = (lo[k] + span - org[k]) / d[k];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      if (t0 > t1) return undefined;
    }
    const start = [org[0] + d[0] * t0, org[1] + d[1] * t0, org[2] + d[2] * t0];
    let [i, j, k] = this.ijk(start[0], start[1], start[2]);
    const step = [Math.sign(d[0]), Math.sign(d[1]), Math.sign(d[2])];
    const next = (c: number, axis: number) => (d[axis] === 0 ? Infinity : (lo[axis] + (c + (step[axis] > 0 ? 1 : 0)) * cell - org[axis]) / d[axis]);
    const tMax = [next(i, 0), next(j, 1), next(k, 2)];
    const tDelta = [Math.abs(cell / d[0]), Math.abs(cell / d[1]), Math.abs(cell / d[2])];
    let best: Hit | undefined;
    const seen = new Set<number>();
    for (let guard = 0; guard < 3 * n + 3; guard++) {
      const list = this.cells.get((i * n + j) * n + k);
      if (list) {
        for (const t of list) {
          if (seen.has(t)) continue;
          seen.add(t);
          const h = this.intersect(t, org, d);
          if (h !== undefined && h >= 0 && h <= maxT && (!best || h < best.t)) best = this.hitAt(t, h, origin, dir);
        }
      }
      const exit = Math.min(tMax[0], tMax[1], tMax[2]);
      if (best && best.t <= exit) return best;
      if (exit > t1) break;
      if (tMax[0] === exit) { i += step[0]; tMax[0] += tDelta[0]; if (i < 0 || i >= n) break; }
      else if (tMax[1] === exit) { j += step[1]; tMax[1] += tDelta[1]; if (j < 0 || j >= n) break; }
      else { k += step[2]; tMax[2] += tDelta[2]; if (k < 0 || k >= n) break; }
    }
    return best;
  }

  /** Möller-Trumbore, both sides; ray origin relative to the chunk origin. */
  private intersect(t: number, o: number[], d: Vec3): number | undefined {
    const p = this.chunk.positions, idx = this.chunk.indices;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-18) return undefined;
    const inv = 1 / det;
    const tx = o[0] - p[a], ty = o[1] - p[a + 1], tz = o[2] - p[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return undefined;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const w = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (w < 0 || u + w > 1) return undefined;
    return (e2x * qx + e2y * qy + e2z * qz) * inv;
  }

  private hitAt(t: number, dist: number, origin: Vec3, dir: Vec3): Hit {
    const p = this.chunk.positions, idx = this.chunk.indices;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const n: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    return {
      t: dist,
      point: [origin[0] + dir[0] * dist, origin[1] + dir[1] * dist, origin[2] + dir[2] * dist],
      normal: [n[0] / l, n[1] / l, n[2] / l],
    };
  }
}

/** The octree path of the node at `depth` containing a body-frame point. */
export function pathOf(p: Vec3, half: number, depth: number): string {
  let lo = [-half, -half, -half];
  let size = 2 * half;
  let path = '';
  for (let d = 0; d < depth; d++) {
    size /= 2;
    const ox = p[0] - lo[0] >= size ? 1 : 0, oy = p[1] - lo[1] >= size ? 1 : 0, oz = p[2] - lo[2] >= size ? 1 : 0;
    path += String(ox + 2 * oy + 4 * oz);
    lo = [lo[0] + ox * size, lo[1] + oy * size, lo[2] + oz * size];
  }
  return path;
}

/** The box (min corner, size) of an octree path. */
export function boxOf(path: string, half: number): { lo: Vec3; size: number } {
  const lo: Vec3 = [-half, -half, -half];
  let size = 2 * half;
  for (const ch of path) {
    size /= 2;
    const k = Number(ch);
    lo[0] += (k & 1) * size;
    lo[1] += ((k >> 1) & 1) * size;
    lo[2] += ((k >> 2) & 1) * size;
  }
  return { lo, size };
}
