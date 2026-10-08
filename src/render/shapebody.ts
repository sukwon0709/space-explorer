import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import type { Mat3 } from '../core/orientation';
import { boxOf, parseChunk, Polyhedron, TriangleGrid, type Chunk, type Hit, type NodeEntry, type ShapeIndex } from '../core/shape';

/**
 * A small body drawn from its shape model (core/shape.ts): the octree's chunks, chosen
 * each frame so no triangle strays more than about a pixel from the full model, lit by
 * the Sun with shadows cast by the body itself (two shadow maps: the whole body, and a
 * close one around the camera), and below the model's resolution, computed rubble.
 *
 * What is computed, not measured: the boulders smaller than the model resolves (sizes
 * from each body's measured size-frequency power law, placed at random), and a grain
 * on the ground below them. The model's own boulders, ridges and craters are real.
 */

/** Refine a chunk while its error would show as more than this many pixels. */
const ERROR_PIXELS = 1.5;
/** Computed boulders drawn at once, nearest first by size class. */
const MAX_ROCKS = 40000;
const SHADOW_SIZE = 2048;

export interface ShapeFrame {
  /** Camera position in the body frame, km. */
  eyeBody: Vec3;
  /** Body centre minus camera, scene axes, km. */
  centerRel: Vec3;
  bodyToScene: Mat3;
  /** Unit vector to the Sun, body frame. */
  sunBody: Vec3;
  pixelsPerRadian: number;
  /** Exposure-scaled sunlight. */
  intensity: number;
  /** Light from a nearby lit companion (Didymos on Dimorphos, and back), linear. */
  ambient?: number;
  /** Height of the camera above the ground (km), if known. */
  altitude?: number;
}

interface NodeState {
  entry: NodeEntry;
  children: NodeState[];
  chunk?: Chunk;
  mesh?: THREE.Mesh;
  shadow?: THREE.Mesh;
  grid?: TriangleGrid;
  /** Box centre and half-diagonal, for distances. */
  centre: Vec3;
  reach: number;
}

const common = /* glsl */ `
uniform vec3 uOrigin;
varying vec3 vBody;
varying vec3 vNormal;
varying float vSkirt;
`;

const bodyVertex = /* glsl */ `
${common}
#include <common>
#include <logdepthbuf_pars_vertex>
#ifndef ROCK
attribute float skirt;
#endif
void main() {
#ifdef ROCK
  vec4 local = instanceMatrix * vec4(position, 1.0);
  vNormal = normalize(transpose(inverse(mat3(instanceMatrix))) * normal);
  vSkirt = 0.0;
#else
  vec4 local = vec4(position, 1.0);
  vNormal = normal;
  vSkirt = skirt;
#endif
  vBody = uOrigin + local.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * local;
  #include <logdepthbuf_vertex>
}
`;

const bodyFragment = /* glsl */ `
${common}
uniform vec3 uSun;
uniform vec3 uCamBody;
uniform vec3 uAlbedo;
uniform float uIntensity;
uniform float uAmbient;
uniform float uResolution;
uniform mat4 uLight0;
uniform mat4 uLight1;
uniform sampler2D uShadow0;
uniform sampler2D uShadow1;
uniform float uLocal;
uniform vec2 uBias;
uniform vec2 uTexel;
uniform float uRockTone;
#include <common>
#include <logdepthbuf_pars_fragment>

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// Gradient of the noise by finite differences: tilts the normal (bumps below the data).
vec3 bump(vec3 p, float scale) {
  float e = 0.15;
  vec3 q = p / scale;
  float c = vnoise(q);
  return vec3(vnoise(q + vec3(e, 0, 0)) - c, vnoise(q + vec3(0, e, 0)) - c, vnoise(q + vec3(0, 0, e)) - c) / e;
}

float shadowAt(sampler2D map, mat4 light, vec3 p, float bias) {
  vec4 c = light * vec4(p, 1.0);
  vec3 s = c.xyz / c.w * 0.5 + 0.5;
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || s.z > 1.0) return -1.0;
  float lit = 0.0;
  vec2 texel = vec2(1.0 / ${SHADOW_SIZE.toFixed(1)});
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    float d = texture2D(map, s.xy + vec2(float(i), float(j)) * texel).r;
    lit += s.z - bias <= d ? 1.0 : 0.0;
  }
  return lit / 9.0;
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 rel = vBody - uCamBody;
  float dist = length(rel);
  vec3 view = rel / dist;
  vec3 n = normalize(vNormal);
  if (dot(n, view) > 0.0 && !gl_FrontFacing) n = -n;
  // Shadows are looked up a little off the surface (along the mesh's own normal) so a
  // face doesn't shadow itself. A skirt, which hangs below its edge, is looked up back at
  // the edge, else the ground beside it shadows it into a dark seam.
  vec3 lifted0 = vBody + n * (uTexel.x * 1.5 + vSkirt);
  vec3 lifted1 = vBody + n * (uTexel.y * 1.5 + vSkirt);
  // Grain under the model's resolution: rock and gravel, fading in close up (computed).
  float near = 1.0 - smoothstep(uResolution * 8.0, uResolution * 40.0, dist);
  float tone = 1.0;
  if (near > 0.0) {
    vec3 p = vBody * 1000.0; // metres
    vec3 g = bump(p, 0.35) * 0.5 + bump(p, 0.09) * 0.35 + bump(p, 1.6) * 0.6;
    n = normalize(n - near * (g - n * dot(g, n)) * 0.6);
    tone = 1.0 + near * (0.25 * (vnoise(p / 0.7) - 0.5) + 0.2 * (vnoise(p / 0.12) - 0.5));
  }
  // Patches of brighter and darker material, as on Bennu and Ryugu.
  tone *= 1.0 + 0.18 * (vnoise(vBody * 1000.0 / 9.0) - 0.5) + uRockTone;
  float mu0 = dot(n, uSun);
  float mu = max(dot(n, -view), 0.0);
  float lit = 1.0;
  if (mu0 > 0.0) {
    float s1 = uLocal > 0.5 ? shadowAt(uShadow1, uLight1, lifted1, uBias.y) : -1.0;
    lit = s1 >= 0.0 ? s1 : max(shadowAt(uShadow0, uLight0, lifted0, uBias.x), 0.0);
  }
  mu0 = max(mu0, 0.0);
  // Mostly Lommel-Seeliger, as dark regolith scatters; plus the opposition surge that makes
  // rubble brighten sharply with the Sun behind the viewer (Bennu: Golish et al. 2021).
  float ls = 2.0 * mu0 / (mu0 + mu + 1e-4);
  float phase = acos(clamp(dot(uSun, -view), -1.0, 1.0));
  float surge = 1.0 + 0.4 * exp(-phase / 0.09);
  vec3 color = uAlbedo * tone * (mix(mu0, ls * 0.5, 0.75) * surge * lit * uIntensity + uAmbient * (0.6 + 0.4 * mu));
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const depthVertex = /* glsl */ `
uniform vec3 uOrigin;
uniform mat4 uLight;
void main() {
#ifdef ROCK
  vec4 local = instanceMatrix * vec4(position, 1.0);
#else
  vec4 local = vec4(position, 1.0);
#endif
  gl_Position = uLight * vec4(uOrigin + local.xyz, 1.0);
}
`;
const depthFragment = /* glsl */ `
void main() { gl_FragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); }
`;

interface Rock {
  /** Centre (body frame, km), unit axes (columns) and semi-axes (km). */
  c: Vec3;
  ax: Vec3;
  ay: Vec3;
  az: Vec3;
  s: Vec3;
}

export class ShapeBody {
  readonly group = new THREE.Group();
  index?: ShapeIndex;
  gravity?: Polyhedron;
  private root?: NodeState;
  private readonly byPath = new Map<string, NodeState>();
  private readonly files = new Map<string, Promise<void>>();
  private readonly rockMaterial: THREE.ShaderMaterial;
  private readonly depthMaterial: THREE.ShaderMaterial;
  private readonly rockDepthMaterial: THREE.ShaderMaterial;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly shadowScene = new THREE.Scene();
  private readonly targets: THREE.WebGLRenderTarget[];
  private readonly lights = [new THREE.Matrix4(), new THREE.Matrix4()];
  private readonly drawn = new Set<NodeState>();
  private loaded = false;
  /** Whether the local shadow map covers the camera this frame. */
  private local = false;
  private localCentre: Vec3 = [0, 0, 0];
  private localHalf = 0;
  /** Computed boulders near the camera. */
  private rocks: Rock[] = [];
  private readonly rockMesh: THREE.InstancedMesh;
  private readonly rockShadow: THREE.InstancedMesh;
  private rockCentre: Vec3 | undefined;
  private rockGrids = new Map<string, Rock[]>();
  private rockStale = false;
  private rockTime = 0;
  /** The rocks in 2 m cells, for short ray casts (feet on the ground). */
  private rockCells = new Map<string, Rock[]>();
  /** How far a rock can reach from its cell (its largest semi-axis), km. */
  private rockPad = 0.002;
  pending = 0;

  constructor(readonly slug: string, private readonly base: string, albedo: Vec3) {
    this.uniforms = {
      uOrigin: { value: new THREE.Vector3() },
      uSun: { value: new THREE.Vector3(1, 0, 0) },
      uCamBody: { value: new THREE.Vector3() },
      uAlbedo: { value: new THREE.Vector3(...albedo) },
      uIntensity: { value: 7 },
      uAmbient: { value: 0 },
      uResolution: { value: 0.001 },
      uLight0: { value: this.lights[0] },
      uLight1: { value: this.lights[1] },
      uShadow0: { value: null },
      uShadow1: { value: null },
      uLocal: { value: 0 },
      uBias: { value: new THREE.Vector2(0.002, 0.004) },
      uTexel: { value: new THREE.Vector2(0.001, 0.001) },
      uRockTone: { value: 0 },
    };
    this.rockMaterial = new THREE.ShaderMaterial({
      vertexShader: bodyVertex, fragmentShader: bodyFragment, defines: { ROCK: 1 },
      uniforms: { ...this.uniforms, uOrigin: { value: new THREE.Vector3() }, uRockTone: { value: 0.08 } },
    });
    const depthUniforms = () => ({ uOrigin: { value: new THREE.Vector3() }, uLight: { value: new THREE.Matrix4() } });
    this.depthMaterial = new THREE.ShaderMaterial({ vertexShader: depthVertex, fragmentShader: depthFragment, uniforms: depthUniforms(), side: THREE.DoubleSide });
    this.rockDepthMaterial = new THREE.ShaderMaterial({ vertexShader: depthVertex, fragmentShader: depthFragment, uniforms: depthUniforms(), defines: { ROCK: 1 } });
    this.targets = [0, 1].map(() => {
      const t = new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, { type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
      return t;
    });
    this.uniforms.uShadow0.value = this.targets[0].texture;
    this.uniforms.uShadow1.value = this.targets[1].texture;
    const rockGeometry = makeRock();
    this.rockMesh = new THREE.InstancedMesh(rockGeometry, this.rockMaterial, MAX_ROCKS);
    this.rockMesh.count = 0;
    this.rockMesh.frustumCulled = false;
    this.rockMesh.matrixAutoUpdate = false;
    this.rockShadow = new THREE.InstancedMesh(rockGeometry, this.rockDepthMaterial, MAX_ROCKS);
    this.rockShadow.instanceMatrix = this.rockMesh.instanceMatrix;
    this.rockShadow.count = 0;
    this.rockShadow.frustumCulled = false;
    this.group.add(this.rockMesh);
    this.shadowScene.add(this.rockShadow);
    this.group.visible = false;
  }

  get ready(): boolean {
    return this.loaded;
  }

  /** Load the index, the gravity model and the top of the octree. */
  async load(): Promise<void> {
    if (this.root) return;
    const index = (await fetch(`${this.base}${this.slug}/index.json`).then((r) => r.json())) as ShapeIndex;
    this.index = index;
    this.uniforms.uResolution.value = index.resolution;
    const states = index.nodes.map((entry): NodeState => {
      const { lo, size } = boxOf(entry[0], index.half);
      return { entry, children: [], centre: [lo[0] + size / 2, lo[1] + size / 2, lo[2] + size / 2], reach: size * 0.866 };
    });
    for (const s of states) this.byPath.set(s.entry[0], s);
    for (const s of states) if (s.entry[0].length) this.byPath.get(s.entry[0].slice(0, -1))!.children.push(s);
    this.root = this.byPath.get('');
    const [gravity] = await Promise.all([
      fetch(`${this.base}${this.slug}/gravity.bin`).then((r) => r.arrayBuffer()),
      this.loadFile('top'),
    ]);
    this.gravity = Polyhedron.parse(gravity, index.gm);
    this.loaded = true;
  }

  private loadFile(file: string): Promise<void> {
    let p = this.files.get(file);
    if (!p) {
      this.pending++;
      p = fetch(`${this.base}${this.slug}/${file}.bin`).then((r) => {
        if (!r.ok) throw new Error(`${this.slug}/${file}: ${r.status}`);
        return r.arrayBuffer();
      }).then((buffer) => {
        for (const s of this.byPath.values()) {
          if (s.entry[1] !== file) continue;
          s.chunk = parseChunk(s.entry[0], buffer, s.entry[2]);
          this.makeMesh(s);
        }
      }).catch((err) => console.warn(err)).finally(() => this.pending--);
      this.files.set(file, p);
    }
    return p;
  }

  private makeMesh(s: NodeState): void {
    const c = s.chunk!;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(c.normals, 3));
    g.setIndex(new THREE.BufferAttribute(c.indices, 1));
    g.setAttribute('skirt', new THREE.BufferAttribute(skirtDepth(c), 1));
    const origin = new THREE.Vector3(...c.origin);
    // Uniforms shared with the body's, but each chunk's own origin (no clone: that would
    // copy the shadow maps' render-target textures).
    const material = new THREE.ShaderMaterial({ vertexShader: bodyVertex, fragmentShader: bodyFragment, uniforms: { ...this.uniforms, uOrigin: { value: origin } }, side: THREE.DoubleSide });
    s.mesh = new THREE.Mesh(g, material);
    s.mesh.frustumCulled = false;
    s.mesh.matrixAutoUpdate = false;
    s.mesh.visible = false;
    this.group.add(s.mesh);
    const depth = new THREE.ShaderMaterial({ vertexShader: depthVertex, fragmentShader: depthFragment, uniforms: { uOrigin: { value: origin }, uLight: this.depthMaterial.uniforms.uLight }, side: THREE.DoubleSide });
    s.shadow = new THREE.Mesh(g, depth);
    s.shadow.frustumCulled = false;
    s.shadow.visible = false;
    this.shadowScene.add(s.shadow);
  }

  /** Choose and place the chunks for this frame. */
  update(f: ShapeFrame): void {
    if (!this.root || !this.root.mesh || !this.index) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    const u = this.uniforms;
    u.uSun.value.set(...f.sunBody);
    u.uCamBody.value.set(...f.eyeBody);
    u.uIntensity.value = f.intensity;
    u.uAmbient.value = f.ambient ?? 0;
    for (const s of this.drawn) {
      s.mesh!.visible = false;
      s.shadow!.visible = false;
    }
    this.drawn.clear();
    this.select(this.root, f);
    const b = f.bodyToScene;
    for (const s of this.drawn) {
      const o = s.chunk!.origin;
      const t = [0, 1, 2].map((k) => f.centerRel[k] + b[k * 3] * o[0] + b[k * 3 + 1] * o[1] + b[k * 3 + 2] * o[2]);
      s.mesh!.matrix.set(b[0], b[1], b[2], t[0], b[3], b[4], b[5], t[1], b[6], b[7], b[8], t[2], 0, 0, 0, 1);
      s.mesh!.matrixWorldNeedsUpdate = true;
      s.mesh!.visible = true;
      s.shadow!.visible = true;
    }
    // Rocks: placed in the body frame relative to their own origin (near the camera).
    if (this.rockCentre) {
      const o = this.rockCentre;
      const t = [0, 1, 2].map((k) => f.centerRel[k] + b[k * 3] * o[0] + b[k * 3 + 1] * o[1] + b[k * 3 + 2] * o[2]);
      this.rockMesh.matrix.set(b[0], b[1], b[2], t[0], b[3], b[4], b[5], t[1], b[6], b[7], b[8], t[2], 0, 0, 0, 1);
      this.rockMesh.matrixWorldNeedsUpdate = true;
    }
    this.updateRocks(f.eyeBody);
  }

  private select(s: NodeState, f: ShapeFrame): void {
    const e = f.eyeBody;
    const d = Math.max(1e-6, Math.hypot(e[0] - s.centre[0], e[1] - s.centre[1], e[2] - s.centre[2]) - s.reach);
    const refine = !s.entry[5] && s.children.length > 0 && (s.entry[4] / d) * f.pixelsPerRadian > ERROR_PIXELS;
    if (refine) {
      const ready = s.children.every((c) => c.mesh);
      if (!ready) for (const c of s.children) this.loadFile(c.entry[1]);
      else {
        for (const c of s.children) this.select(c, f);
        return;
      }
    }
    if (s.mesh) this.drawn.add(s);
  }

  /**
   * Render the two shadow maps: the whole body seen from the Sun, and (near the
   * ground) a box around the camera at much finer resolution.
   */
  renderShadows(renderer: THREE.WebGLRenderer, f: ShapeFrame): void {
    if (!this.group.visible || !this.index) return;
    const R = this.index.radius * 1.02;
    const sun = new THREE.Vector3(...f.sunBody);
    const e = f.eyeBody;
    // Height above the surface, roughly: how far the camera is from the nearest drawn ground.
    const r = Math.hypot(e[0], e[1], e[2]);
    const alt = Math.max(0.0005, f.altitude ?? r - this.index.minRadius);
    this.local = alt < R * 0.5 && r < R * 1.5;
    const boxes: Array<{ centre: Vec3; half: number }> = [{ centre: [0, 0, 0], half: R }];
    if (this.local) {
      this.localHalf = Math.min(R, Math.max(0.03, alt * 3));
      this.localCentre = [...e];
      boxes.push({ centre: this.localCentre, half: this.localHalf });
    }
    this.uniforms.uLocal.value = this.local ? 1 : 0;
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearAlpha();
    const clear = new THREE.Color();
    renderer.getClearColor(clear);
    renderer.setClearColor(0xffffff, 1);
    const cam = new THREE.Camera();
    boxes.forEach((box, k) => {
      // Light view: looking along -sun from beyond the body; depth spans the whole body.
      const up = Math.abs(sun.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
      const c = new THREE.Vector3(...box.centre);
      // Push the eye out to the body's far side along the Sun so every caster is in front.
      const along = c.dot(sun);
      const eyeL = c.clone().addScaledVector(sun, R * 2 - along);
      const view = new THREE.Matrix4().lookAt(eyeL, c, up).setPosition(eyeL).invert();
      const depth = R * 4;
      const proj = new THREE.Matrix4().makeOrthographic(-box.half, box.half, box.half, -box.half, 0.0, depth);
      this.lights[k].multiplyMatrices(proj, view);
      (this.depthMaterial.uniforms.uLight.value as THREE.Matrix4).copy(this.lights[k]);
      (this.rockDepthMaterial.uniforms.uLight.value as THREE.Matrix4).copy(this.lights[k]);
      this.rockShadow.visible = k === 1;
      renderer.setRenderTarget(this.targets[k]);
      renderer.clear();
      renderer.render(this.shadowScene, cam);
    });
    // Texel sizes (km), and a texel's worth of depth as the bias (depth spans 4 R).
    const t0 = (2 * R) / SHADOW_SIZE, t1 = this.local ? (2 * this.localHalf) / SHADOW_SIZE : t0;
    this.uniforms.uTexel.value.set(t0, t1);
    this.uniforms.uBias.value.set(t0 / (4 * R), t1 / (4 * R));
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(clear, prevClear);
  }

  // ---- the ground: what the feet and the camera stand on ---------------------------

  /** The finest loaded chunks whose boxes the segment from `a` to `b` passes near. */
  private finest(a: Vec3, b: Vec3, pad: number): NodeState[] {
    const out: NodeState[] = [];
    const visit = (s: NodeState) => {
      if (!s.chunk) return;
      if (segmentDistance(s.centre, a, b) > s.reach + pad) return;
      if (s.children.length && s.children.every((c) => c.chunk)) {
        for (const c of s.children) visit(c);
        return;
      }
      out.push(s);
    };
    if (this.root) visit(this.root);
    return out;
  }

  /** First surface hit along a ray (body frame), within `maxT` km, rocks included. */
  raycast(origin: Vec3, dir: Vec3, maxT: number, rocks = true): Hit | undefined {
    const end: Vec3 = [origin[0] + dir[0] * maxT, origin[1] + dir[1] * maxT, origin[2] + dir[2] * maxT];
    let best: Hit | undefined;
    for (const s of this.finest(origin, end, 0.001)) {
      if (!s.grid) s.grid = new TriangleGrid(s.chunk!);
      const h = s.grid.raycast(origin, dir, best ? best.t : maxT);
      if (h && (!best || h.t < best.t)) best = h;
    }
    if (rocks) {
      const r = this.rockHit(origin, dir, best ? best.t : maxT);
      if (r) best = r;
    }
    return best;
  }

  /** Whether the finest ground at a point is loaded to full resolution. */
  fullResolutionAt(p: Vec3): boolean {
    const list = this.finest(p, p, 0);
    return list.length > 0 && list.every((s) => s.entry[5] === 1);
  }

  /** Load the full-resolution chunks around a point (for standing there). */
  requestAround(p: Vec3, radius: number): void {
    const visit = (s: NodeState) => {
      if (Math.hypot(p[0] - s.centre[0], p[1] - s.centre[1], p[2] - s.centre[2]) > s.reach + radius) return;
      if (!s.chunk) {
        this.loadFile(s.entry[1]);
        return;
      }
      for (const c of s.children) visit(c);
    };
    if (this.root) visit(this.root);
  }

  // ---- computed rubble ------------------------------------------------------------

  /**
   * Boulders below the model's resolution around the camera, by size class: each class
   * is placed out to a distance where it still covers a few pixels. Their numbers follow
   * the body's cumulative size-frequency law N(>D) = k D^slope per square metre, with
   * k set by the fraction of the ground covered by boulders over a metre.
   */
  private updateRocks(eye: Vec3): void {
    const index = this.index!;
    const b = index.boulders;
    const res = index.resolution * 1000; // m
    const dMax = Math.min(b.max, res * 1.8);
    const r = Math.hypot(eye[0], eye[1], eye[2]);
    const near = r - index.minRadius < 0.4;
    if (b.cover <= 0 || !near || dMax <= 0.25) {
      this.rockMesh.count = this.rockShadow.count = 0;
      this.rocks = [];
      return;
    }
    const moved = !this.rockCentre || Math.hypot(eye[0] - this.rockCentre[0], eye[1] - this.rockCentre[1], eye[2] - this.rockCentre[2]) >= 0.002;
    // Until the ground around has loaded to full resolution, place them again now and then.
    const now = performance.now();
    if (!moved && (!this.rockStale || now - this.rockTime < 500)) return;
    this.rockTime = now;
    this.rockStale = false;
    const alpha = -b.slope;
    const k = (b.cover * (4 / Math.PI) * (alpha - 2)) / alpha;
    const N = (d: number) => k * Math.pow(d, -alpha);
    const classes: Array<[number, number]> = [];
    for (let d = 0.25; d < dMax; d *= 2) classes.push([d, Math.min(d * 2, dMax)]);
    const centre: Vec3 = [...eye];
    const rocks: Rock[] = [];
    for (const [d0, d1] of classes) {
      const reach = Math.min(0.4, (d0 * 130) / 1000); // km
      const density = N(d0) - N(d1); // per m^2
      // Placed cell by cell (cells as big as the reach), only in the cells around.
      const lo = eye.map((v) => Math.floor((v - reach) / reach)), hi = eye.map((v) => Math.floor((v + reach) / reach));
      for (const s of this.finest(eye, eye, reach)) {
        if (!s.entry[5]) {
          // Only on full-resolution ground.
          this.rockStale = true;
          continue;
        }
        const half = s.reach / 1.732;
        for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
          // Cells the chunk's box doesn't reach have none of its triangles.
          if ((i + 1) * reach < s.centre[0] - half || i * reach > s.centre[0] + half
            || (j + 1) * reach < s.centre[1] - half || j * reach > s.centre[1] + half
            || (k + 1) * reach < s.centre[2] - half || k * reach > s.centre[2] + half) continue;
          const key = `${s.entry[0]}:${d0}:${i},${j},${k}`;
          let list = this.rockGrids.get(key);
          if (!list) this.rockGrids.set(key, (list = scatter(s.chunk!, density, d0, d1, alpha, `${s.entry[0]}:${d0}`, [i, j, k], reach)));
          for (const rock of list) {
            if (rocks.length < MAX_ROCKS && Math.hypot(rock.c[0] - eye[0], rock.c[1] - eye[1], rock.c[2] - eye[2]) < reach) rocks.push(rock);
          }
        }
      }
    }
    this.rocks = rocks;
    this.rockCentre = centre;
    this.rockCells.clear();
    this.rockPad = Math.max(0.002, dMax / 2000);
    for (const rock of rocks) {
      const key = cellKey(rock.c[0], rock.c[1], rock.c[2]);
      let list = this.rockCells.get(key);
      if (!list) this.rockCells.set(key, (list = []));
      list.push(rock);
    }
    const m = new THREE.Matrix4();
    rocks.forEach((rock, i) => {
      const c = rock.c;
      m.set(
        rock.ax[0] * rock.s[0], rock.ay[0] * rock.s[1], rock.az[0] * rock.s[2], c[0] - centre[0],
        rock.ax[1] * rock.s[0], rock.ay[1] * rock.s[1], rock.az[1] * rock.s[2], c[1] - centre[1],
        rock.ax[2] * rock.s[0], rock.ay[2] * rock.s[1], rock.az[2] * rock.s[2], c[2] - centre[2],
        0, 0, 0, 1,
      );
      this.rockMesh.setMatrixAt(i, m);
    });
    this.rockMesh.count = this.rockShadow.count = rocks.length;
    this.rockMesh.instanceMatrix.needsUpdate = true;
    (this.rockMaterial.uniforms.uOrigin.value as THREE.Vector3).set(...centre);
    (this.rockDepthMaterial.uniforms.uOrigin.value as THREE.Vector3).set(...centre);
    // Keep the cache from growing without bound.
    if (this.rockGrids.size > 20000) this.rockGrids.clear();
  }

  /** The nearest computed boulder hit by a ray (ellipsoids). */
  private rockHit(origin: Vec3, dir: Vec3, maxT: number): Hit | undefined {
    let best: Hit | undefined;
    let candidates = this.rocks;
    if (maxT < 0.01) {
      // A short ray: only the cells around it.
      candidates = [];
      const e = [origin[0] + dir[0] * maxT, origin[1] + dir[1] * maxT, origin[2] + dir[2] * maxT];
      const pad = this.rockPad;
      const lo = [0, 1, 2].map((k) => Math.floor((Math.min(origin[k], e[k]) - pad) / CELL));
      const hi = [0, 1, 2].map((k) => Math.floor((Math.max(origin[k], e[k]) + pad) / CELL));
      for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
        const list = this.rockCells.get(`${i},${j},${k}`);
        if (list) candidates.push(...list);
      }
    }
    for (const rock of candidates) {
      const dx = origin[0] - rock.c[0], dy = origin[1] - rock.c[1], dz = origin[2] - rock.c[2];
      const big = Math.max(rock.s[0], rock.s[1], rock.s[2]);
      // Quick reject: the ray's closest approach to the rock's bounding sphere.
      const along = -(dx * dir[0] + dy * dir[1] + dz * dir[2]);
      const cx = dx + dir[0] * along, cy = dy + dir[1] * along, cz = dz + dir[2] * along;
      if (cx * cx + cy * cy + cz * cz > big * big) continue;
      // In the rock's own axes, scaled to a unit sphere.
      const o = [(dx * rock.ax[0] + dy * rock.ax[1] + dz * rock.ax[2]) / rock.s[0], (dx * rock.ay[0] + dy * rock.ay[1] + dz * rock.ay[2]) / rock.s[1], (dx * rock.az[0] + dy * rock.az[1] + dz * rock.az[2]) / rock.s[2]];
      const d = [(dir[0] * rock.ax[0] + dir[1] * rock.ax[1] + dir[2] * rock.ax[2]) / rock.s[0], (dir[0] * rock.ay[0] + dir[1] * rock.ay[1] + dir[2] * rock.ay[2]) / rock.s[1], (dir[0] * rock.az[0] + dir[1] * rock.az[1] + dir[2] * rock.az[2]) / rock.s[2]];
      const A = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      const B = 2 * (o[0] * d[0] + o[1] * d[1] + o[2] * d[2]);
      const C = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - 1;
      const disc = B * B - 4 * A * C;
      if (disc < 0) continue;
      const t = (-B - Math.sqrt(disc)) / (2 * A);
      if (t < 0 || t > maxT || (best && t >= best.t)) continue;
      const q = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
      const nl = [q[0] / rock.s[0], q[1] / rock.s[1], q[2] / rock.s[2]];
      const n: Vec3 = [0, 1, 2].map((k) => rock.ax[k] * nl[0] + rock.ay[k] * nl[1] + rock.az[k] * nl[2]) as Vec3;
      const l = Math.hypot(n[0], n[1], n[2]);
      best = { t, point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t], normal: [n[0] / l, n[1] / l, n[2] / l] };
    }
    return best;
  }

  hide(): void {
    this.group.visible = false;
  }
}

/** Rock lookup cells, km. */
const CELL = 0.002;
const cellKey = (x: number, y: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;

/** Distance from a point to the segment a-b. */
function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = l2 > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2)) : 0;
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}

/** A small seeded random generator (mulberry32). */
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Boulders of diameters d0..d1 (m) at `density` per m^2 over the triangles of a chunk
 * whose first corner lies in one cell (index `cell`, `size` km). Each triangle's rocks
 * come from its own seed, so they are the same whichever cells are asked for.
 */
function scatter(chunk: Chunk, density: number, d0: number, d1: number, alpha: number, seed: string, cell: number[], size: number): Rock[] {
  const p = chunk.positions, idx = chunk.indices, o = chunk.origin;
  const out: Rock[] = [];
  for (let t = 0; t < chunk.surface; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    if (Math.floor((o[0] + p[a]) / size) !== cell[0] || Math.floor((o[1] + p[a + 1]) / size) !== cell[1] || Math.floor((o[2] + p[a + 2]) / size) !== cell[2]) continue;
    const random = rng(`${seed}:${t}`);
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const ln = Math.hypot(n[0], n[1], n[2]);
    if (ln === 0) continue;
    const area = (ln / 2) * 1e6; // m^2
    // Poisson count by inversion.
    const lambda = density * area;
    let count = 0;
    for (let L = Math.exp(-lambda), prod = random(); prod > L && count < 50; prod *= random()) count++;
    for (let i = 0; i < count; i++) {
      let u = random(), v = random();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      // Diameter from the power law between d0 and d1.
      const x = random();
      const D = Math.pow(Math.pow(d0, -alpha) - x * (Math.pow(d0, -alpha) - Math.pow(d1, -alpha)), -1 / alpha);
      const half = D / 2000; // km
      const nz: Vec3 = [n[0] / ln, n[1] / ln, n[2] / ln];
      const ref = Math.abs(nz[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      let ax: Vec3 = [nz[1] * ref[2] - nz[2] * ref[1], nz[2] * ref[0] - nz[0] * ref[2], nz[0] * ref[1] - nz[1] * ref[0]];
      const la = Math.hypot(...ax);
      ax = [ax[0] / la, ax[1] / la, ax[2] / la];
      const spin = random() * Math.PI * 2;
      const ay0: Vec3 = [nz[1] * ax[2] - nz[2] * ax[1], nz[2] * ax[0] - nz[0] * ax[2], nz[0] * ax[1] - nz[1] * ax[0]];
      const cs = Math.cos(spin), sn = Math.sin(spin);
      const axr: Vec3 = [ax[0] * cs + ay0[0] * sn, ax[1] * cs + ay0[1] * sn, ax[2] * cs + ay0[2] * sn];
      const ayr: Vec3 = [ay0[0] * cs - ax[0] * sn, ay0[1] * cs - ax[1] * sn, ay0[2] * cs - ax[2] * sn];
      // Boulders are flattened and half buried (axis ratios about 1 : 0.7 : 0.5).
      const s: Vec3 = [half, half * (0.6 + 0.25 * random()), half * (0.4 + 0.2 * random())];
      const lift = s[2] * (0.1 + 0.3 * random());
      const base = [p[a] + e1[0] * u + e2[0] * v, p[a + 1] + e1[1] * u + e2[1] * v, p[a + 2] + e1[2] * u + e2[2] * v];
      out.push({ c: [o[0] + base[0] + nz[0] * lift, o[1] + base[1] + nz[1] * lift, o[2] + base[2] + nz[2] * lift], ax: axr, ay: ayr, az: nz, s });
    }
  }
  return out;
}

/** A lumpy rock: an icosphere pushed in and out by a little noise, unit size. */
function makeRock(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const random = rng('rock');
  const bumps = Array.from({ length: 7 }, () => {
    const v = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
    return { v, k: (random() - 0.5) * 0.35 };
  });
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    let r = 1;
    for (const b of bumps) r += b.k * Math.max(0, v.dot(b.v)) ** 3;
    // Flat facets: a rock breaks along planes.
    v.multiplyScalar(r);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

/**
 * How far each vertex hangs below the edge it was dropped from (km): zero on the surface.
 * The skirt's first half of triangles are (b, a, a'), a' being a dropped below a.
 */
function skirtDepth(c: Chunk): Float32Array {
  const depth = new Float32Array(c.positions.length / 3);
  const quads = (c.indices.length / 3 - c.surface) / 2;
  const P = c.positions;
  for (let k = 0; k < quads; k++) {
    const t = (c.surface + k) * 3;
    const a = c.indices[t + 1], d = c.indices[t + 2];
    depth[d] = Math.hypot(P[d * 3] - P[a * 3], P[d * 3 + 1] - P[a * 3 + 1], P[d * 3 + 2] - P[a * 3 + 2]);
  }
  return depth;
}
