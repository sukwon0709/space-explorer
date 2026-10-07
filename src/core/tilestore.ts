/**
 * Reads the surface tile packs written by pipeline/build_tiles.py. Tiles are geographic:
 * level L has 2^(L+1) x 2^L tiles of 180/2^L degrees, x east from 180 W, y south from
 * 90 N. Packs (chunks) are fetched on demand and kept; tiles inside them are decoded
 * when asked for.
 */

export type LayerKind = 'color' | 'night' | 'height';

export interface LayerInfo {
  id: string;
  body: number;
  kind: LayerKind;
  /** west, south, east, north in degrees */
  bbox: [number, number, number, number];
  levels: [number, number];
  /** chunk key -> deepest level inside it */
  chunks: Record<string, number>;
  source: string;
  /** Height layers: metres per int16 step and the height of step 0, if not the scheme's. */
  heightUnit?: number;
  heightOffset?: number;
  /** Chunk roots, if not the scheme's (small layers keep every tile in one pack). */
  chunkRoots?: number[];
}

export interface Manifest {
  scheme: { image: number; grid: number; heightUnit: number; chunkRoots: number[] };
  layers: LayerInfo[];
}

export interface TileRef {
  layer: LayerInfo;
  level: number;
  x: number;
  y: number;
}

export interface HeightTile {
  /** grid x grid heights in km, rows north to south. */
  heights: Float32Array;
  /** 1 where the sample is water (ocean or lake). */
  water: Uint8Array;
}

export const tileSize = (level: number) => 180 / 2 ** level;

export function tileBounds(level: number, x: number, y: number): [number, number, number, number] {
  const s = tileSize(level);
  const west = -180 + x * s;
  const north = 90 - y * s;
  return [west, north - s, west + s, north];
}

interface Chunk {
  bytes: Uint8Array;
  index: Map<string, [number, number]>;
}

export class TileStore {
  private readonly chunks = new Map<string, Promise<Chunk>>();
  /** Chunks that failed to load: their tiles count as missing, so coarser data stands in. */
  private readonly failed = new Set<string>();
  readonly grid: number;
  readonly image: number;
  private readonly heightUnit: number;

  constructor(readonly manifest: Manifest, private readonly baseUrl: string, private readonly fetchFn: (url: string) => Promise<Response> = (url) => fetch(url)) {
    this.grid = manifest.scheme.grid;
    this.image = manifest.scheme.image;
    this.heightUnit = manifest.scheme.heightUnit;
  }

  layers(body: number, kind: LayerKind): LayerInfo[] {
    return this.manifest.layers.filter((l) => l.body === body && l.kind === kind);
  }

  hasBody(body: number): boolean {
    return this.manifest.layers.some((l) => l.body === body);
  }

  chunkKey(level: number, x: number, y: number, layer?: LayerInfo): string {
    const roots = layer?.chunkRoots ?? this.manifest.scheme.chunkRoots;
    let r = 0;
    for (const root of roots) if (root <= level) r = root;
    const shift = level - r;
    return `${r}-${x >> shift}-${y >> shift}`;
  }

  /** Whether `layer` holds tile (level, x, y), by the pipeline's own coverage rule. */
  covers(layer: LayerInfo, level: number, x: number, y: number): boolean {
    if (level < layer.levels[0] || level > layer.levels[1]) return false;
    const key = this.chunkKey(level, x, y, layer);
    const deepest = layer.chunks[key];
    if (deepest === undefined || deepest < level || this.failed.has(`${layer.id}/${key}`)) return false;
    const s = tileSize(level);
    const [w, south, e, n] = layer.bbox;
    const x0 = Math.floor((w + 180) / s), x1 = Math.ceil((e + 180) / s) - 1;
    const y0 = Math.floor((90 - n) / s), y1 = Math.ceil((90 - south) / s) - 1;
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  }

  /** The deepest tile at or above (level, x, y) that has data of this kind, or null. */
  locate(body: number, kind: LayerKind, level: number, x: number, y: number): TileRef | null {
    const layers = this.layers(body, kind).sort((a, b) => b.levels[1] - a.levels[1]);
    for (let l = level; l >= 0; l--) {
      const shift = level - l;
      for (const layer of layers) {
        if (this.covers(layer, l, x >> shift, y >> shift)) return { layer, level: l, x: x >> shift, y: y >> shift };
      }
    }
    return null;
  }

  /** Raw bytes of a tile. */
  async bytes(ref: TileRef): Promise<Uint8Array> {
    const key = this.chunkKey(ref.level, ref.x, ref.y, ref.layer);
    const id = `${ref.layer.id}/${key}`;
    let chunk = this.chunks.get(id);
    if (!chunk) {
      chunk = this.loadChunk(`${this.baseUrl}${id}.bin`);
      this.chunks.set(id, chunk);
      chunk.catch(() => {
        this.chunks.delete(id);
        this.failed.add(id);
      });
    }
    const c = await chunk;
    const entry = c.index.get(`${ref.level}/${ref.x}/${ref.y}`);
    if (!entry) throw new Error(`Tile ${ref.level}/${ref.x}/${ref.y} missing from ${id}`);
    return c.bytes.subarray(entry[0], entry[0] + entry[1]);
  }

  async heights(ref: TileRef): Promise<HeightTile> {
    const compressed = await this.bytes(ref);
    const raw = await inflate(compressed);
    const q = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    const heights = new Float32Array(q.length);
    const water = new Uint8Array(q.length);
    const unit = ref.layer.heightUnit ?? this.heightUnit;
    const offset = ref.layer.heightOffset ?? 0;
    for (let i = 0; i < q.length; i++) {
      water[i] = q[i] & 1;
      heights[i] = ((q[i] & ~1) * unit + offset) / 1000;
    }
    return { heights, water };
  }

  private async loadChunk(url: string): Promise<Chunk> {
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x4b415054) throw new Error(`${url} is not a tile pack`); // "TPAK"
    const count = view.getUint32(8, true);
    const index = new Map<string, [number, number]>();
    for (let i = 0; i < count; i++) {
      const at = 16 + i * 20;
      const level = view.getUint8(at);
      index.set(`${level}/${view.getUint32(at + 4, true)}/${view.getUint32(at + 8, true)}`, [view.getUint32(at + 12, true), view.getUint32(at + 16, true)]);
    }
    return { bytes, index };
  }
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
