import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { bodyToGeodetic, type Shape } from '../core/geodesy';
import type { Mat3 } from '../core/orientation';
import { buildTileGeometry, type TileGeometry } from '../core/terrainmesh';
import { tileBounds, tileSize, type HeightTile, type TileRef, type TileStore } from '../core/tilestore';
import { ATMOSPHERE, MARS_ATMOSPHERE, atmosphereGlsl, type AtmosphereParams } from './atmosphere';
import { thickAirGlsl, type ThickAirParams } from './thickair';
import { CLOUD_GLSL } from './clouds';
import { computeHorizons, HORIZON_DIRECTIONS, HORIZON_MAX_DEG, HORIZON_MIN_DEG } from '../core/horizon';

const DEG = Math.PI / 180;
const GRID = 65;
const MAX_LEVEL = 20;
/** Split a tile once one of its texels would cover more than about this many pixels. */
const TEXEL_PIXELS = 1.15;
/** How many levels a tile may refine past its deepest height or colour data. */
const EXTRA_LEVELS = 3;

export type SurfaceKind = 'earth' | 'mars' | 'airless' | 'thick';

/** Per-frame inputs, all float64 until they are handed to three.js. */
export interface GlobeFrame {
  /** Camera position in the body frame, km. */
  eyeBody: Vec3;
  /** Body centre minus camera position, scene axes, km. */
  centerRel: Vec3;
  /** Body-fixed to scene rotation (row-major). */
  bodyToScene: Mat3;
  /** Unit vector to the Sun in the body frame. */
  sunBody: Vec3;
  /** Pixels per radian at the centre of the view. */
  pixelsPerRadian: number;
  frame: number;
  /** The camera's view volume in scene axes (camera at the origin). */
  frustum?: THREE.Frustum;
}

interface Node {
  level: number;
  x: number;
  y: number;
  children?: Node[];
  mesh?: THREE.Mesh;
  geometry?: TileGeometry;
  textures: TextureHandle[];
  building?: Promise<void>;
  failed?: boolean;
  lastUsed: number;
  /** Surface points (corners and centre, height 0) for LOD and horizon tests. */
  samples: Vec3[];
  /** Radius around samples[4] that holds the whole tile, km. */
  radius: number;
  /** The last frame this tile was drawn. */
  drawnFrame?: number;
  /** Deepest data level found for this tile, once built. */
  dataLevel?: number;
}

interface TextureHandle {
  key: string;
  texture: THREE.Texture;
  users: number;
}

const vertexShader = /* glsl */ `
attribute float water;
attribute vec2 detail;
attribute vec4 horizonA;
attribute vec4 horizonB;
varying vec4 vHorizonA;
varying vec4 vHorizonB;
varying vec2 vUv;
varying vec2 vDetail;
varying vec3 vNormal;
varying vec3 vRel;
varying float vWater;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vUv = uv;
  vNormal = normal;
  vWater = water;
  vDetail = detail;
  vHorizonA = horizonA;
  vHorizonB = horizonB;
  vRel = (modelMatrix * vec4(position, 1.0)).xyz; // camera-relative, scene axes
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const fragmentShader = (atmosphere: string) => /* glsl */ `
uniform sampler2D uDay;
uniform vec4 uDayXform;
uniform sampler2D uNight;
uniform vec4 uNightXform;
uniform float uHasNight;
uniform vec3 uSun;
uniform mat3 uSceneToBody;
uniform vec3 uCamBody;
uniform float uFlatten;
uniform float uSunIntensity;
uniform vec3 uEclTint;
uniform vec3 uAlbedoScale;
uniform sampler2D uDetailMap;
uniform float uDetail;
varying vec2 vUv;
varying vec2 vDetail;
varying vec3 vNormal;
varying vec3 vRel;
varying float vWater;
#include <common>
#include <logdepthbuf_pars_fragment>
${atmosphere}

// Below the resolution of the data, the ground gets a fine grain: a periodic noise
// (tiling every DETAIL_PERIOD metres, see terrainmesh.ts) at three scales, which fades
// in only within a few tens of metres. It changes brightness and tilts the normal a
// little; it adds no information about the real surface.
vec3 surfaceDetail(vec3 n, float dist, out float shade) {
  shade = 1.0;
  float w = uDetail * (1.0 - smoothstep(15.0, 120.0, dist * 1000.0));
  if (w <= 0.0) return n;
  vec2 p = vDetail;
  vec3 a = texture2D(uDetailMap, p / 3.125).rgb - 0.5;
  vec3 b = texture2D(uDetailMap, p / 12.5 + 0.37).rgb - 0.5;
  vec3 c = texture2D(uDetailMap, p / 0.78125 + 0.71).rgb - 0.5;
  shade = 1.0 + w * (0.35 * a.r + 0.25 * b.r + 0.2 * c.r);
  // Tilt the normal by the noise's slope (green/blue hold its x/y derivatives).
  vec3 t = normalize(cross(vec3(0.0, 0.0, 1.0), n) + vec3(1e-6, 0.0, 0.0));
  vec3 bt = cross(n, t);
  vec2 slope = 0.5 * a.gb + 0.35 * b.gb + 0.35 * c.gb;
  return normalize(n + w * (t * slope.x + bt * slope.y));
}

vec3 srgbToLinear(vec3 c) { return pow(c, vec3(2.2)); }

// Terrain shadows from the tile's horizon map (core/horizon.ts): the horizon's elevation
// in the Sun's direction, interpolated between the eight stored directions, against the
// Sun's elevation. The Sun's disc (and the map's interpolation) make the edge soft.
varying vec4 vHorizonA;
varying vec4 vHorizonB;
uniform float uSunRadius;
float horizonAngle(float v) { return radians(${HORIZON_MIN_DEG.toFixed(1)} + v * ${(HORIZON_MAX_DEG - HORIZON_MIN_DEG).toFixed(1)}); }
float horizonIn(int k) {
  if (k == 0) return vHorizonA.x;
  if (k == 1) return vHorizonA.y;
  if (k == 2) return vHorizonA.z;
  if (k == 3) return vHorizonA.w;
  if (k == 4) return vHorizonB.x;
  if (k == 5) return vHorizonB.y;
  if (k == 6) return vHorizonB.z;
  return vHorizonB.w;
}
// Fraction of the Sun's disc above the terrain's horizon at body-frame point p.
float terrainSunlight(vec3 p) {
  vec3 up = normalize(p);
  vec3 east = normalize(vec3(-up.y, up.x, 0.0) + vec3(1e-6, 0.0, 0.0));
  vec3 north = cross(up, east);
  float el = asin(clamp(dot(up, uSun), -1.0, 1.0));
  float az = atan(dot(uSun, east), dot(uSun, north));
  if (az < 0.0) az += 2.0 * PI;
  float f = az / (PI / 4.0);
  int k = int(floor(f));
  float t = f - float(k);
  float hor = horizonAngle(mix(horizonIn(k), horizonIn(k == 7 ? 0 : k + 1), t));
  float w = uSunRadius + 0.006;
  return smoothstep(-w, w, el - hor);
}
// The share of the sky's dome left open by the terrain around (1 on open ground).
float terrainSkyView() {
  vec4 a = sin(max(vec4(horizonAngle(vHorizonA.x), horizonAngle(vHorizonA.y), horizonAngle(vHorizonA.z), horizonAngle(vHorizonA.w)), 0.0));
  vec4 b = sin(max(vec4(horizonAngle(vHorizonB.x), horizonAngle(vHorizonB.y), horizonAngle(vHorizonB.z), horizonAngle(vHorizonB.w)), 0.0));
  return 1.0 - (dot(a, a) + dot(b, b)) / 8.0;
}

${CLOUD_GLSL}
// The cloud deck between a point on the ground and the Sun: how much of the direct beam
// gets through, and how much of the sunlight arrives diffused by the cloud instead.
void cloudShadow(vec3 p, vec3 up, float mu0, inout float tDirect, inout float tDiffuse) {
  if (uHasClouds < 0.5) return;
  float below = max(ATM_BOTTOM + CLOUD_ALTITUDE - length(p), 0.0);
  vec3 q = p + uSun * below / max(mu0, 0.08);
  float tau = cloudTau(texture2D(uClouds, cloudUv(q)).r);
  tDirect = exp(-tau / max(mu0, 0.08));
  tDiffuse = max(1.0 - cloudReflectance(tau) - tDirect, 0.0);
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 albedo = srgbToLinear(texture2D(uDay, uDayXform.xy + vUv * uDayXform.zw).rgb) * uAlbedoScale;
  vec3 rel = uSceneToBody * vRel;
  vec3 viewDir = normalize(rel);
  float grain;
  vec3 n = surfaceDetail(normalize(vNormal), length(rel), grain);
  albedo *= grain;
  float ndl = dot(n, uSun);
  float eclipse = eclipseVisibility(uCamBody + rel);
#ifdef ATMOSPHERE
  // Atmosphere maths runs in the frame where the ellipsoid is a sphere (z scaled by a/b).
  vec3 cam = vec3(uCamBody.xy, uCamBody.z * uFlatten);
  vec3 p = cam + vec3(rel.xy, rel.z * uFlatten);
  vec3 up = normalize(p);
  vec3 sunT = atmSunTransmittance(p + up * 0.01, uSun);
  float sunUp = dot(up, uSun);
#ifdef DUSTY
  // Dusty regolith: mostly Lambert with some Lommel-Seeliger, lit by the Sun through the
  // dust and by the butterscotch sky (on Mars about a third of the light on the ground
  // comes from the sky at this dust load).
  float mu0 = max(ndl, 0.0);
  float mu = max(dot(n, -viewDir), 0.0);
  float ls = 2.0 * mu0 / (mu0 + mu + 1e-4);
  vec3 color = albedo * sunT * mix(mu0, ls * 0.5, 0.3) * terrainSunlight(uCamBody + rel);
  color += albedo * vec3(0.16, 0.11, 0.075) * smoothstep(-0.2, 0.5, sunUp) * (0.6 + 0.4 * dot(n, up)) * terrainSkyView();
#else
  // Rough rock and soil (Oren-Nayar, slope spread 0.4 rad): flatter than Lambert, with
  // some light thrown back toward the Sun, so sunlit slopes do not look like plastic.
  float nv = max(dot(n, -viewDir), 0.0);
  float nl = max(ndl, 0.0);
  vec3 lp = uSun - n * ndl;
  vec3 vp = -viewDir - n * dot(n, -viewDir);
  float cphi = max(dot(lp, vp), 0.0) / max(length(lp) * length(vp), 1e-4);
  float si = sqrt(max(1.0 - nl * nl, 0.0));
  float sv = sqrt(max(1.0 - nv * nv, 0.0));
  float rough = nl * (0.77 + 0.29 * cphi * max(si, sv) * min(si, sv) / max(max(nl, nv), 0.05));
  // The direct beam and, under a cloud, the part of it the cloud lets through diffusely.
  float tDirect = 1.0, tDiffuse = 0.0;
  cloudShadow(p, up, max(sunUp, 0.0), tDirect, tDiffuse);
  float skyView = (0.5 + 0.5 * dot(n, up)) * terrainSkyView();
  tDirect *= terrainSunlight(uCamBody + rel);
  vec3 color = albedo * sunT * (rough * tDirect + max(sunUp, 0.0) * tDiffuse * skyView);
  // Skylight from the part of the sky the slope faces, blue, fading through twilight
  // (about a seventh of the light on the ground with the Sun high in a clear sky).
  color += albedo * vec3(0.06, 0.085, 0.13) * skyView * smoothstep(-0.15, 0.4, sunUp) * mix(1.0, 1.6, 1.0 - tDirect);
  // Light thrown back by the sunlit ground around, onto slopes that face it: canyon
  // walls in shadow are lit warm by the opposite walls, not left blue-black.
  // (Lit walls across a valley keep lighting it when this point is in their shadow.)
  color += albedo * albedo * sunT * max(sunUp, 0.0) * (1.0 - skyView) * 1.4;
#endif
  color *= eclipse;
  if (vWater > 0.5) {
    vec3 h = normalize(uSun - viewDir);
    float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(n, -viewDir), 0.0), 5.0);
    color += sunT * pow(max(dot(n, h), 0.0), 220.0) * 6.0 * fresnel * step(0.0, ndl) * eclipse;
  }
  color *= uSunIntensity;
  if (uHasNight > 0.5) {
    float lights = srgbToLinear(texture2D(uNight, uNightXform.xy + vUv * uNightXform.zw).rgb).r;
    color += lights * vec3(1.0, 0.72, 0.42) * 3.0 * (1.0 - smoothstep(-0.12, 0.04, sunUp));
  }
  vec3 inscatter, transmittance;
  atmBetween(cam, p, uSun, inscatter, transmittance);
  color = color * transmittance + inscatter * uSunIntensity;
#elif defined(THICK)
  // Under a thick atmosphere (thickair.ts): the ground is lit by the whole sky, more on
  // slopes facing up, plus whatever direct sunbeam gets through; then the air between it
  // and the eye.
  vec3 cam = uCamBody;
  vec3 p = cam + rel;
  vec3 up = normalize(p);
  float h = length(p) - TA_R;
  float mu0 = dot(up, uSun);
  vec3 diffuse = taDiffuse(h, mu0);
  vec3 direct = taDirect(h, mu0);
  vec3 color = albedo * (diffuse * (0.55 + 0.45 * dot(n, up)) * terrainSkyView() + direct * max(ndl, 0.0) * terrainSunlight(p));
  if (vWater > 0.5) {
    // Liquid methane and ethane: dark, a mirror for the sky and the dim Sun.
    float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(n, -viewDir), 0.0), 5.0);
    vec3 hv = normalize(uSun - viewDir);
    color = albedo * 0.15 * diffuse + fresnel * diffuse + direct * pow(max(dot(n, hv), 0.0), 400.0) * 40.0 * fresnel * step(0.0, ndl);
  }
  color *= uSunIntensity;
  vec3 inscatter, transmittance;
  float dist = length(rel);
  taScatter(cam, rel / dist, 0.0, dist, uSun, inscatter, transmittance);
  color = color * transmittance + inscatter * uSunIntensity;
#else
  // Airless regolith: mostly Lommel-Seeliger (the flat, bright limb of the full Moon).
  float mu0 = max(ndl, 0.0);
  float mu = max(dot(n, -viewDir), 0.0);
  float ls = 2.0 * mu0 / (mu0 + mu + 1e-4);
  // The LROC mosaic is stretched for display (mean linear value 0.31); the Moon's
  // normal albedo is about 0.12, so scale it back.
  // In Earth's umbra the Moon is lit only by sunlight refracted through Earth's
  // atmosphere, reddened by the same scattering that makes sunsets red (uEclTint).
  vec3 color = albedo * mix(mu0, ls * 0.5, 0.7) * uSunIntensity * (eclipse + (1.0 - eclipse) * uEclTint) * terrainSunlight(uCamBody + rel);
#endif
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * A body's surface as a quadtree of terrain tiles streamed from the tile store. Each
 * tile is its own mesh, placed every frame at (tile centre - camera) computed in
 * float64, so vertices near the camera are always small numbers on the GPU.
 */
export class Globe {
  readonly group = new THREE.Group();
  private readonly roots: Node[];
  private readonly heightCache = new Map<string, Promise<HeightTile>>();
  private readonly textures = new Map<string, Promise<TextureHandle>>();
  private readonly quaternion = new THREE.Quaternion();
  private readonly drawn: Node[] = [];
  private readonly sphere = new THREE.Sphere();
  private frame = -1;
  readonly uniforms = {
    uSun: { value: new THREE.Vector3() },
    uSceneToBody: { value: new THREE.Matrix3() },
    uCamBody: { value: new THREE.Vector3() },
    uFlatten: { value: 1 },
    uSunIntensity: { value: 7 },
    uEclSun: { value: new THREE.Vector3() },
    uEclSunRadius: { value: 695700 },
    uEclOcc: { value: new THREE.Vector4() },
    uEclTint: { value: new THREE.Vector3() },
    uAlbedoScale: { value: new THREE.Vector3(1, 1, 1) },
    uDetailMap: { value: detailMap() },
    uDetail: { value: 0 },
    // Earth's cloud cover (set by EarthSky), for cloud shadows on the ground.
    uClouds: { value: blankTexture() as THREE.Texture },
    uHasClouds: { value: 0 },
    /** Angular radius of the Sun's disc seen from the body (radians), for soft terrain shadows. */
    uSunRadius: { value: 0.00465 },
  };
  private blankNight = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  pending = 0;
  readonly atmosphere?: AtmosphereParams;
  private readonly fragment: string;
  /** Computed relief below the data's resolution (relief.ts), if the world has any. */
  readonly relief?: (lon: number, lat: number, spacing: number) => number;
  /** Tiles wait for the relief's map, so every tile (and the walker's ground) has the same relief. */
  private readonly reliefReady?: Promise<unknown>;

  constructor(
    readonly bodyId: number,
    readonly shape: Shape,
    private readonly store: TileStore,
    /** Earth (air, oceans, city lights), Mars (dust), an airless body, or one under a thick atmosphere. */
    readonly kind: SurfaceKind,
    options: { air?: ThickAirParams; relief?: (lon: number, lat: number, spacing: number) => number; reliefReady?: Promise<unknown> } = {},
  ) {
    this.uniforms.uFlatten.value = shape.a / shape.b;
    this.atmosphere = kind === 'earth' ? ATMOSPHERE : kind === 'mars' ? MARS_ATMOSPHERE : undefined;
    this.relief = options.relief;
    this.reliefReady = options.reliefReady;
    this.fragment = fragmentShader(atmosphereGlsl(this.atmosphere ?? ATMOSPHERE) + (options.air ? thickAirGlsl(options.air) : ''));
    this.blankNight.needsUpdate = true;
    this.roots = [this.makeNode(0, 0, 0), this.makeNode(0, 1, 0)];
    this.group.name = `globe-${bodyId}`;
  }

  update(f: GlobeFrame): void {
    const b = f.bodyToScene;
    const m4 = new THREE.Matrix4().set(b[0], b[1], b[2], 0, b[3], b[4], b[5], 0, b[6], b[7], b[8], 0, 0, 0, 0, 1);
    this.quaternion.setFromRotationMatrix(m4);
    this.uniforms.uSun.value.set(f.sunBody[0], f.sunBody[1], f.sunBody[2]);
    // scene -> body is the transpose of body -> scene; Matrix3.set takes row-major input.
    this.uniforms.uSceneToBody.value.set(b[0], b[3], b[6], b[1], b[4], b[7], b[2], b[5], b[8]);
    this.uniforms.uCamBody.value.set(f.eyeBody[0], f.eyeBody[1], f.eyeBody[2]);

    for (const node of this.drawn) if (node.mesh) node.mesh.visible = false;
    this.drawn.length = 0;
    const [, , altitude] = bodyToGeodetic(this.shape, f.eyeBody);
    for (const root of this.roots) this.select(root, f, altitude);

    const rel = [0, 0, 0];
    for (const node of this.drawn) {
      const mesh = node.mesh!;
      const c = node.geometry!.center;
      for (let k = 0; k < 3; k++) rel[k] = f.centerRel[k] + b[k * 3] * c[0] + b[k * 3 + 1] * c[1] + b[k * 3 + 2] * c[2];
      mesh.position.set(rel[0], rel[1], rel[2]);
      mesh.quaternion.copy(this.quaternion);
      mesh.visible = true;
      node.drawnFrame = f.frame;
    }
    this.frame = f.frame;
    if (f.frame % 60 === 0) this.evict(f.frame);
  }

  /**
   * Terrain height (km) under a longitude/latitude (radians): on the tile drawn there
   * last frame, following its triangles, so it matches what is on screen; otherwise
   * from the finest built tile (always, with `finest`).
   */
  heightAt(lon: number, lat: number, finest = false): number {
    const lonD = lon / DEG, latD = lat / DEG;
    let best: Node | undefined;
    let nodes = this.roots;
    while (nodes) {
      const next = nodes.find((n) => {
        const [w, s, e, nn] = tileBounds(n.level, n.x, n.y);
        return lonD >= w && lonD <= e && latD >= s && latD <= nn;
      });
      if (!next || !next.geometry) break;
      best = next;
      if ((!finest && next.drawnFrame === this.frame) || !next.children) break;
      nodes = next.children;
    }
    if (!best) return 0;
    const [w, s, e, n] = tileBounds(best.level, best.x, best.y);
    const fx = ((lonD - w) / (e - w)) * (GRID - 1);
    const fy = ((n - latD) / (n - s)) * (GRID - 1);
    const x0 = Math.max(0, Math.min(GRID - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(GRID - 2, Math.floor(fy)));
    const tx = fx - x0, ty = fy - y0;
    const h = best.geometry!.heights;
    const a = h[y0 * GRID + x0], b = h[y0 * GRID + x0 + 1], c = h[(y0 + 1) * GRID + x0], d = h[(y0 + 1) * GRID + x0 + 1];
    // Each grid square is split along its b-c diagonal (see buildTileGeometry).
    return tx + ty <= 1 ? a + (b - a) * tx + (c - a) * ty : d + (c - d) * (1 - tx) + (b - d) * (1 - ty);
  }

  /**
   * The tile's horizon map (core/horizon.ts) as two byte vec4 attributes: directions
   * N, NE, E, SE and S, SW, W, NW. Skirt vertices copy their edge vertex.
   */
  private horizons(node: Node, geometry: TileGeometry): [Uint8Array, Uint8Array] {
    const [w, s, e, n] = tileBounds(node.level, node.x, node.y);
    const map = computeHorizons(geometry.heights, GRID, [w, s, e, n], this.shape.a, (lon, lat) => this.heightAt(lon * DEG, lat * DEG, true));
    const count = GRID * GRID;
    const total = geometry.positions.length / 3;
    const a = new Uint8Array(total * 4);
    const b = new Uint8Array(total * 4);
    const copy = (dst: number, src: number) => {
      for (let k = 0; k < 4; k++) {
        a[dst * 4 + k] = map[src * HORIZON_DIRECTIONS + k];
        b[dst * 4 + k] = map[src * HORIZON_DIRECTIONS + 4 + k];
      }
    };
    for (let k = 0; k < count; k++) copy(k, k);
    // Skirts follow the edges in buildTileGeometry's order: north, south, west, east.
    for (let i = 0; i < GRID; i++) {
      copy(count + i, i);
      copy(count + GRID + i, (GRID - 1) * GRID + i);
      copy(count + 2 * GRID + i, i * GRID);
      copy(count + 3 * GRID + i, i * GRID + GRID - 1);
    }
    return [a, b];
  }

  private makeNode(level: number, x: number, y: number): Node {
    const [w, s, e, n] = tileBounds(level, x, y);
    const pts: Array<[number, number]> = [[w, n], [e, n], [w, s], [e, s], [(w + e) / 2, (s + n) / 2]];
    const samples = pts.map(([lon, lat]) => {
      const sl = Math.sin(lat * DEG), cl = Math.cos(lat * DEG);
      const e2 = 1 - (this.shape.b / this.shape.a) ** 2;
      const nr = this.shape.a / Math.sqrt(1 - e2 * sl * sl);
      return [nr * cl * Math.cos(lon * DEG), nr * cl * Math.sin(lon * DEG), nr * (1 - e2) * sl] as Vec3;
    });
    const c = samples[4];
    const radius = Math.max(...samples.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]))) + 10;
    return { level, x, y, textures: [], lastUsed: 0, samples, radius };
  }

  private select(node: Node, f: GlobeFrame, altitude: number): void {
    node.lastUsed = f.frame;
    const eye = f.eyeBody;
    if (!this.aboveHorizon(node, eye)) return;
    const [w, s, e, n] = tileBounds(node.level, node.x, node.y);
    // Distance from the camera to the tile: its altitude if it is over the tile,
    // otherwise the nearest sample point.
    const [lon, lat] = bodyToGeodetic(this.shape, eye);
    let dist: number;
    if (lon / DEG >= w && lon / DEG <= e && lat / DEG >= s && lat / DEG <= n) {
      dist = Math.max(0.001, altitude);
    } else {
      dist = Infinity;
      for (const p of node.samples) dist = Math.min(dist, Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]));
      dist = Math.max(dist - tileSize(node.level) * DEG * this.shape.a * 0.25, 0.001);
    }
    const width = tileSize(node.level) * DEG * this.shape.a;
    const texelPixels = (width / this.store.image / dist) * f.pixelsPerRadian;
    // Past a few levels below the deepest data there is nothing new to show, and
    // tiles outside the view keep their current detail.
    const split =
      node.level < MAX_LEVEL &&
      texelPixels > TEXEL_PIXELS &&
      (node.dataLevel === undefined || this.relief !== undefined || node.level < node.dataLevel + EXTRA_LEVELS) &&
      this.inView(node, f);

    if (split) {
      if (!node.children) {
        const l = node.level + 1;
        node.children = [this.makeNode(l, node.x * 2, node.y * 2), this.makeNode(l, node.x * 2 + 1, node.y * 2), this.makeNode(l, node.x * 2, node.y * 2 + 1), this.makeNode(l, node.x * 2 + 1, node.y * 2 + 1)];
      }
      const ready = node.children.every((c) => c.mesh || c.failed);
      if (ready) {
        for (const child of node.children) if (child.mesh) this.select(child, f, altitude);
        return;
      }
      for (const child of node.children) this.ensureBuilt(child);
    }
    this.ensureBuilt(node);
    if (node.mesh) this.drawn.push(node);
  }

  private inView(node: Node, f: GlobeFrame): boolean {
    if (!f.frustum) return true;
    const b = f.bodyToScene, c = node.samples[4];
    for (let k = 0; k < 3; k++) this.sphere.center.setComponent(k, f.centerRel[k] + b[k * 3] * c[0] + b[k * 3 + 1] * c[1] + b[k * 3 + 2] * c[2]);
    this.sphere.radius = node.radius;
    return f.frustum.intersectsSphere(this.sphere);
  }

  /**
   * False when the whole tile is hidden behind the body: no sample, raised to the
   * highest terrain, is within line of sight over a sphere below the lowest terrain.
   */
  private aboveHorizon(node: Node, eye: Vec3): boolean {
    if (node.level < 2) return true;
    const r0 = Math.min(this.shape.a, this.shape.b) - 11; // below the deepest basins
    const lift = 1 + 12 / this.shape.a; // highest mountains (Maxwell Montes, 11.7 km)
    const eyeHorizon = Math.sqrt(Math.max(eye[0] ** 2 + eye[1] ** 2 + eye[2] ** 2 - r0 * r0, 0));
    // Margin: the tile's own width, since its interior can rise above its samples.
    const margin = tileSize(node.level) * DEG * this.shape.a;
    for (const p of node.samples) {
      const q = [p[0] * lift, p[1] * lift, p[2] * lift];
      const pointHorizon = Math.sqrt(Math.max(q[0] ** 2 + q[1] ** 2 + q[2] ** 2 - r0 * r0, 0));
      if (Math.hypot(q[0] - eye[0], q[1] - eye[1], q[2] - eye[2]) < eyeHorizon + pointHorizon + margin) return true;
    }
    return false;
  }

  private ensureBuilt(node: Node): void {
    if (node.mesh || node.building || node.failed) return;
    this.pending++;
    // A pack that fails to load is marked missing in the store, so one retry builds the
    // tile from coarser data instead of leaving a hole.
    node.building = this.build(node)
      .catch(() => this.build(node))
      .catch((err) => {
        node.failed = true;
        console.warn(`tile ${node.level}/${node.x}/${node.y}:`, err);
      })
      .finally(() => {
        node.building = undefined;
        this.pending--;
      });
  }

  private async build(node: Node): Promise<void> {
    if (this.reliefReady) await this.reliefReady.catch(() => undefined);
    const { level, x, y } = node;
    const heightRef = this.store.locate(this.bodyId, 'height', level, x, y);
    const colorRef = this.store.locate(this.bodyId, 'color', level, x, y);
    const nightRef = this.kind === 'earth' ? this.store.locate(this.bodyId, 'night', level, x, y) : null;
    const [heights, color, night] = await Promise.all([
      heightRef ? this.heightTile(heightRef) : Promise.resolve(null),
      colorRef ? this.texture(colorRef) : Promise.resolve(null),
      nightRef ? this.texture(nightRef) : Promise.resolve(null),
    ]);
    node.dataLevel = Math.max(heightRef?.level ?? 0, colorRef?.level ?? 0);
    const geometry = buildTileGeometry(this.shape, level, x, y, GRID, heights && heightRef ? { tile: heights, level: heightRef.level, x: heightRef.x, y: heightRef.y, grid: this.store.grid } : null, this.relief);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(geometry.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(geometry.normals, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(geometry.uvs, 2));
    g.setAttribute('water', new THREE.BufferAttribute(geometry.water, 1));
    g.setAttribute('detail', new THREE.BufferAttribute(geometry.detail, 2));
    const [horizonA, horizonB] = this.horizons(node, geometry);
    g.setAttribute('horizonA', new THREE.BufferAttribute(horizonA, 4, true));
    g.setAttribute('horizonB', new THREE.BufferAttribute(horizonB, 4, true));
    g.setIndex(new THREE.BufferAttribute(geometry.indices, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), geometry.radius);

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: this.fragment,
      defines: this.kind === 'earth' ? { ATMOSPHERE: '' } : this.kind === 'mars' ? { ATMOSPHERE: '', DUSTY: '' } : this.kind === 'thick' ? { THICK: '' } : {},
      side: THREE.DoubleSide,
      uniforms: {
        ...this.uniforms,
        uDay: { value: color?.texture ?? this.blankNight },
        uDayXform: { value: xform(node, colorRef) },
        uNight: { value: night?.texture ?? this.blankNight },
        uNightXform: { value: xform(node, nightRef) },
        uHasNight: { value: night ? 1 : 0 },
      },
    });
    const mesh = new THREE.Mesh(g, material);
    mesh.frustumCulled = true;
    mesh.visible = false;
    mesh.matrixAutoUpdate = true;
    node.geometry = geometry;
    node.textures = [color, night].filter((t): t is TextureHandle => !!t);
    node.mesh = mesh;
    this.group.add(mesh);
  }

  private heightTile(ref: TileRef): Promise<HeightTile> {
    const key = `${ref.layer.id}/${ref.level}/${ref.x}/${ref.y}`;
    let p = this.heightCache.get(key);
    if (!p) {
      p = this.store.heights(ref);
      this.heightCache.set(key, p);
      p.catch(() => this.heightCache.delete(key));
    }
    return p;
  }

  private texture(ref: TileRef): Promise<TextureHandle> {
    const key = `${ref.layer.id}/${ref.level}/${ref.x}/${ref.y}`;
    let p = this.textures.get(key);
    if (!p) {
      p = this.store.bytes(ref).then(async (bytes) => {
        const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }), { imageOrientation: 'none', colorSpaceConversion: 'none' });
        const texture = new THREE.Texture(bitmap as unknown as HTMLImageElement);
        texture.flipY = false;
        texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.anisotropy = 4;
        texture.needsUpdate = true;
        return { key, texture, users: 0 };
      });
      this.textures.set(key, p);
      p.catch(() => this.textures.delete(key));
    }
    return p.then((h) => {
      h.users++;
      return h;
    });
  }

  /** Free meshes of tiles that have not been needed for a while. */
  private evict(frame: number): void {
    const visit = (node: Node) => {
      if (node.children) {
        for (const c of node.children) visit(c);
        if (node.children.every((c) => !c.mesh && !c.building && !c.children && frame - c.lastUsed > 300)) node.children = undefined;
      }
      if (node.mesh && node.level > 1 && frame - node.lastUsed > 300) {
        this.group.remove(node.mesh);
        node.mesh.geometry.dispose();
        (node.mesh.material as THREE.Material).dispose();
        node.mesh = undefined;
        node.geometry = undefined;
        for (const t of node.textures) {
          if (--t.users <= 0) {
            t.texture.dispose();
            (t.texture.image as ImageBitmap).close?.();
            this.textures.delete(t.key);
          }
        }
        node.textures = [];
      }
    };
    for (const r of this.roots) visit(r);
    if (this.heightCache.size > 600) this.heightCache.clear();
  }
}

/** Offset and scale taking a tile's 0..1 uv into the texture of the ancestor `ref`. */
function xform(node: { level: number; x: number; y: number }, ref: TileRef | null): THREE.Vector4 {
  if (!ref) return new THREE.Vector4(0, 0, 1, 1);
  const k = 2 ** (node.level - ref.level);
  return new THREE.Vector4((node.x - ref.x * k) / k, (node.y - ref.y * k) / k, 1 / k, 1 / k);
}

let sharedDetail: THREE.DataTexture | undefined;
/**
 * A 256 x 256 tiling noise for close-up grain: red is smooth value noise (several
 * octaves, all periodic over the tile), green and blue its x and y slopes.
 */
function detailMap(): THREE.DataTexture {
  if (sharedDetail) return sharedDetail;
  const n = 256;
  const h = new Float32Array(n * n);
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let octave = 0, cells = 8, amp = 1; octave < 5; octave++, cells *= 2, amp *= 0.55) {
    const g = new Float32Array(cells * cells).map(rand);
    const step = n / cells;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const fx = x / step, fy = y / step;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const at = (i: number, j: number) => g[((j % cells) * cells) + (i % cells)];
        const v = (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
        h[y * n + x] += (v - 0.5) * amp;
      }
    }
  }
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const k = y * n + x;
      const dx = h[y * n + ((x + 1) % n)] - h[y * n + ((x + n - 1) % n)];
      const dy = h[((y + 1) % n) * n + x] - h[((y + n - 1) % n) * n + x];
      data[k * 4] = Math.max(0, Math.min(255, 128 + h[k] * 160));
      data[k * 4 + 1] = Math.max(0, Math.min(255, 128 + dx * 900));
      data[k * 4 + 2] = Math.max(0, Math.min(255, 128 + dy * 900));
      data[k * 4 + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, n, n);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  sharedDetail = t;
  return t;
}

let blank: THREE.DataTexture | undefined;
function blankTexture(): THREE.DataTexture {
  if (!blank) {
    blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;
  }
  return blank;
}
