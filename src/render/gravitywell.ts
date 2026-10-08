import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import type { Forecast } from '../core/forecast';

/** Colours of the forecast: the stretch in the ship's own frame, then each body passed. */
const PATH_COLOURS = [new THREE.Color('#7fd8ff'), new THREE.Color('#ffb15c'), new THREE.Color('#c7a6ff'), new THREE.Color('#9fe0b0')];

/**
 * The ship's coasting path ahead (core/forecast.ts), drawn relative to the camera. Each
 * stretch is drawn around its own body as that body is now, as the mission trails are.
 */
export class ForecastLine {
  readonly line: THREE.LineSegments;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;

  constructor(max = 6000) {
    this.pos = new Float32Array(max * 6);
    this.col = new Float32Array(max * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending }));
    this.line.frustumCulled = false;
    this.line.renderOrder = 5;
    this.line.visible = false;
  }

  /**
   * Draw from `tdb` on. `offset(frame)` is that body's position now relative to the
   * camera (km); `ship` the ship's own, so the line leaves from where it really is.
   */
  update(f: Forecast, tdb: number, offset: (frame: number) => Vec3, ship: Vec3, dim: boolean): void {
    let n = 0;
    const pos = this.pos, col = this.col;
    let prev: Vec3 | undefined = ship;
    let prevColour = PATH_COLOURS[0];
    let runIndex = 0;
    let o: Vec3 = [0, 0, 0];
    let frame = NaN;
    const fade = dim ? 0.45 : 1;
    for (let i = 0; i < f.n && n < pos.length / 6; i++) {
      if (f.t[i] <= tdb) continue;
      if (f.frames[i] !== frame) {
        frame = f.frames[i];
        o = offset(frame);
        while (runIndex + 1 < f.runs.length && f.runs[runIndex].last < i) runIndex++;
        // A new stretch starts its own line: no segment across the change of frame.
        if (n > 0 || prev !== ship) prev = undefined;
      }
      const p: Vec3 = [f.p[i * 3] + o[0], f.p[i * 3 + 1] + o[1], f.p[i * 3 + 2] + o[2]];
      const c = PATH_COLOURS[Math.min(runIndex, PATH_COLOURS.length - 1)];
      if (prev) {
        // Far along the path the line fades out.
        const a = fade * Math.max(0.25, 1 - i / Math.max(f.n, 1));
        pos.set(prev, n * 6);
        pos.set(p, n * 6 + 3);
        col[n * 6] = prevColour.r * a; col[n * 6 + 1] = prevColour.g * a; col[n * 6 + 2] = prevColour.b * a;
        col[n * 6 + 3] = c.r * a; col[n * 6 + 4] = c.g * a; col[n * 6 + 5] = c.b * a;
        n++;
      }
      prev = p;
      prevColour = c;
    }
    const g = this.line.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('color').needsUpdate = true;
    g.setDrawRange(0, n * 2);
    this.line.visible = n > 0;
  }
}

/** A mass that dents the sheet: position relative to the centre body (km), GM, radius. */
export interface Dent {
  rel: Vec3;
  gm: number;
  radius: number;
}

const RINGS = 26;
const SEGMENTS = 144;
const SPOKES = 36;

/**
 * The gravity well: a polar grid in the plane of the ship's orbit, sunk by the
 * gravitational potential (the familiar rubber sheet), and shaded by how deep it is.
 * Around a black hole it is not a cartoon: the sheet is Flamm's paraboloid, the true
 * shape of space around a non-spinning hole, z = 2 sqrt(rs (r - rs)), at true scale.
 */
export class WellGrid {
  readonly lines: THREE.LineSegments;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly grid: Float64Array;
  private readonly depth: Float64Array;

  constructor() {
    const vertices = RINGS * SEGMENTS * 2 + SPOKES * (RINGS - 1) * 2;
    this.pos = new Float32Array(vertices * 3);
    this.col = new Float32Array(vertices * 3);
    this.grid = new Float64Array(RINGS * SEGMENTS * 3);
    this.depth = new Float64Array(RINGS * SEGMENTS);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 4;
    this.lines.visible = false;
  }

  /**
   * Lay the sheet around the centre body. `centre` is its position relative to the
   * camera (km), `radius` its size, `normal` the sheet's (unit), `reach` how far out it
   * goes, `scale` the distance whose depth sets the look (the ship's), `dents` the
   * bodies (the centre first, at the origin) and `horizon` set for a black hole.
   * Elsewhere the depth is the Newtonian potential, exaggerated to read at any scale.
   */
  update(centre: Vec3, radius: number, normal: Vec3, reach: number, scale: number, dents: Dent[], horizon?: number): void {
    // In-plane axes.
    const a = Math.abs(normal[0]) < 0.9 ? cross(normal, [1, 0, 0]) : cross(normal, [0, 1, 0]);
    const u = unit(a), w = cross(normal, u);
    const inner = Math.max(radius, horizon ?? 0) * 1.02;
    const outer = Math.max(reach, inner * 4);
    const main = dents[0];
    // The well's true 1/r shape, as deep at the body's surface as the view allows: a
    // third of the ship's distance, but no more than a few body radii.
    const maxDepth = Math.min(0.3 * scale, 4 * inner);
    const k = maxDepth / (main.gm / inner - main.gm / outer);
    const flamm = (r: number) => 2 * Math.sqrt(horizon! * Math.max(0, r - horizon!));
    const grid = this.grid, depth = this.depth;
    let deepest = 0;
    for (let i = 0; i < RINGS; i++) {
      const r = inner * Math.pow(outer / inner, i / (RINGS - 1));
      for (let j = 0; j < SEGMENTS; j++) {
        const t = (j / SEGMENTS) * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
        const x = r * c * u[0] + r * s * w[0], y = r * c * u[1] + r * s * w[1], z = r * c * u[2] + r * s * w[2];
        let d: number;
        if (horizon !== undefined) {
          d = flamm(outer) - flamm(r);
        } else {
          let phi = 0;
          for (const dent of dents) {
            const dx = x - dent.rel[0], dy = y - dent.rel[1], dz = z - dent.rel[2];
            phi += dent.gm / Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), dent.radius);
          }
          // Measured from the rim, so the sheet is flat where the grid ends.
          d = Math.min(1.5 * maxDepth, k * (phi - main.gm / outer));
        }
        const m = i * SEGMENTS + j;
        grid[m * 3] = x - normal[0] * d;
        grid[m * 3 + 1] = y - normal[1] * d;
        grid[m * 3 + 2] = z - normal[2] * d;
        depth[m] = d;
        deepest = Math.max(deepest, d);
      }
    }
    let n = 0;
    const pos = this.pos, col = this.col;
    const put = (m: number, rim: number) => {
      pos[n * 3] = grid[m * 3] + centre[0];
      pos[n * 3 + 1] = grid[m * 3 + 1] + centre[1];
      pos[n * 3 + 2] = grid[m * 3 + 2] + centre[2];
      // Shallow: faint blue. Deep: bright amber. Fading toward the rim.
      const f = deepest > 0 ? Math.sqrt(depth[m] / deepest) : 0;
      const a = (0.05 + 0.3 * f) * rim;
      col[n * 3] = (0.25 + 0.75 * f) * a;
      col[n * 3 + 1] = (0.45 + 0.2 * f) * a;
      col[n * 3 + 2] = (1 - 0.7 * f) * a;
      n++;
    };
    const rimOf = (i: number) => Math.min(1, (RINGS - 1 - i) / 6 + 0.1);
    for (let i = 0; i < RINGS; i++) {
      for (let j = 0; j < SEGMENTS; j++) {
        put(i * SEGMENTS + j, rimOf(i));
        put(i * SEGMENTS + ((j + 1) % SEGMENTS), rimOf(i));
      }
    }
    const step = SEGMENTS / SPOKES;
    for (let j = 0; j < SEGMENTS; j += step) {
      for (let i = 0; i + 1 < RINGS; i++) {
        put(i * SEGMENTS + j, rimOf(i));
        put((i + 1) * SEGMENTS + j, rimOf(i + 1));
      }
    }
    const g = this.lines.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('color').needsUpdate = true;
    g.setDrawRange(0, n);
    this.lines.visible = true;
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
