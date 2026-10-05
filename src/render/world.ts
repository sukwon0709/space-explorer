import * as THREE from 'three';
import { BODIES, RINGS, bodyById, type Body } from '../core/bodies';
import type { Ephemeris, Vec3 } from '../core/ephemeris';
import { icrfToScene, sub } from '../core/frames';
import { eulerMatrix, hasRotation, iauBodyToScene, icrfToBodyAsScene } from '../core/iau';
import type { Mat3, Orientation } from '../core/orientation';
import { MAX_OCCLUDERS, PlanetGlobe, type BodyFrame } from './planets';
import { RingView, ringProfile } from './rings';
import { SunView } from './sun';

const ORBIT_SAMPLES = 512;
const DEG = Math.PI / 180;
export const AU = 149597870.7;
export const SUN_RADIUS = 695700;

interface BodyView {
  body: Body;
  /** Scene-axis position relative to the barycentre, km, float64. Updated each frame. */
  pos: Vec3;
  /** Body-fixed -> scene rotation. */
  bodyToScene: Mat3;
  /** False until the ephemeris has this body (moons load on demand). */
  available: boolean;
  globe?: PlanetGlobe;
  rings?: RingView;
  orbit?: OrbitView;
}

interface OrbitView {
  line: THREE.LineLoop | THREE.Line;
  sampledAt: number;
}

export interface WorldAssets {
  sunMap?: THREE.Texture;
  sunScale: number;
  saturnRings?: { inner_km: number; outer_km: number; tau: number[] };
}

/**
 * The Solar System scene. Every position is kept in float64 (JS numbers) relative to the
 * barycentre; each frame the camera's float64 position is subtracted before anything is
 * handed to three.js, so the GPU only ever sees small camera-relative float32 values.
 */
export class SolarSystem {
  readonly group = new THREE.Group();
  readonly views = new Map<number, BodyView>();
  readonly sun: SunView;
  /** Exposure: 1 shows sunlit ground at 1 AU as is; raised in the dim outer system. */
  exposure = 1;
  /** Multiplies every orbit line's opacity. */
  orbitOpacity = 1;

  constructor(private readonly ephemeris: Ephemeris, private readonly orientation: Orientation, assets: WorldAssets) {
    this.sun = new SunView(SUN_RADIUS, assets.sunMap, assets.sunScale);
    this.group.add(this.sun.group);
    for (const body of BODIES) {
      const view: BodyView = { body, pos: [0, 0, 0], bodyToScene: new Float64Array(9), available: false };
      if (!body.emissive) {
        view.globe = new PlanetGlobe(body);
        this.group.add(view.globe.mesh);
      }
      if (RINGS[body.id]) {
        view.rings = new RingView(body.id, body.radii, ringProfile(body.id, body.id === 699 ? assets.saturnRings : undefined));
        view.globe?.setRingShadow(view.rings.tau, view.rings.profile.inner, view.rings.profile.outer);
        this.group.add(view.rings.mesh);
      }
      if (body.orbit) {
        const line = makeOrbitLine(body);
        this.group.add(line);
        view.orbit = { line, sampledAt: NaN };
      }
      this.views.set(body.id, view);
    }
  }

  /** Recompute float64 positions and orientations for the epoch. */
  update(tdb: number): void {
    const scratch: Vec3 = [0, 0, 0];
    for (const view of this.views.values()) {
      const id = view.body.id;
      view.available = this.ephemeris.available(id, tdb);
      if (!view.available) continue;
      icrfToScene(this.ephemeris.position(id, tdb, scratch), view.pos);
      if (this.orientation.has(id)) this.orientation.bodyToScene(id, tdb, view.bodyToScene);
      else if (hasRotation(id)) iauBodyToScene(id, tdb, view.bodyToScene);
      else icrfToBodyAsScene(eulerMatrix(view.body.pole[0] * DEG, view.body.pole[1] * DEG, 0), view.bodyToScene);
      if (view.orbit && view.body.orbit && this.ephemeris.available(view.body.orbit.around, tdb)) {
        const periodSeconds = view.body.orbit.periodDays * 86400;
        if (!(Math.abs(tdb - view.orbit.sampledAt) < periodSeconds / 256)) this.sampleOrbit(view, tdb);
      }
    }
  }

  /**
   * Place every object relative to the camera (floating origin), light it, and fade
   * orbit lines near the camera.
   * @param hidden bodies drawn by something else (Earth and the Moon's terrain).
   * @param sunVisible fraction of the Sun's disc the camera sees.
   * @param sky daytime sky brightness at the camera, 0..1.
   */
  placeRelativeTo(camera: Vec3, hidden: Set<number>, sunVisible: number, sky: number): void {
    const rel: Vec3 = [0, 0, 0];
    const sunView = this.views.get(10)!;
    sub(sunView.pos, camera, rel);
    this.sun.update(rel, sunView.bodyToScene, sunVisible, this.exposure, sky);
    for (const view of this.views.values()) {
      const { body } = view;
      if (view.globe) view.globe.mesh.visible = view.available && !hidden.has(body.id);
      if (view.rings) view.rings.mesh.visible = view.available;
      if (view.orbit) view.orbit.line.visible = false;
      if (!view.available || body.emissive) continue;
      const frame = this.bodyFrame(body.id, camera);
      if (view.globe && !hidden.has(body.id)) view.globe.update(frame);
      view.rings?.update(frame);
      if (view.orbit && body.orbit && !Number.isNaN(view.orbit.sampledAt)) {
        const parent = this.views.get(body.orbit.around)!;
        sub(parent.pos, camera, rel);
        view.orbit.line.position.set(rel[0], rel[1], rel[2]);
        // Hide a body's own orbit line once you are close to it: at that range the line is
        // just a streak through the planet.
        const d = Math.hypot(view.pos[0] - camera[0], view.pos[1] - camera[1], view.pos[2] - camera[2]);
        const fade = THREE.MathUtils.clamp((d / body.radius[0] - 40) / 160, 0, 1);
        (view.orbit.line.material as THREE.LineBasicMaterial).opacity = 0.45 * fade * this.orbitOpacity;
        view.orbit.line.visible = fade * this.orbitOpacity > 0;
      }
    }
  }

  /** Brightness of sunlight at a body, including exposure. */
  intensity(id: number): number {
    const p = this.views.get(id)!.pos, s = this.views.get(10)!.pos;
    const r2 = (p[0] - s[0]) ** 2 + (p[1] - s[1]) ** 2 + (p[2] - s[2]) ** 2;
    return (7 * this.exposure * AU * AU) / Math.max(r2, (SUN_RADIUS * 2) ** 2);
  }

  /** Lighting inputs for a body: Sun, the bodies that can eclipse it, brightness. */
  bodyFrame(id: number, camera: Vec3): BodyFrame {
    const view = this.views.get(id)!;
    const sunRel = sub(this.views.get(10)!.pos, view.pos, [0, 0, 0]);
    return {
      centerRel: sub(view.pos, camera, [0, 0, 0]),
      bodyToScene: view.bodyToScene,
      sunRel,
      sunRadius: SUN_RADIUS,
      occluders: this.occluders(id, sunRel),
      intensity: this.intensity(id),
    };
  }

  /**
   * Up to four bodies of the same system nearest to the line toward the Sun, as seen
   * from this body: the only ones whose shadows can fall on it now.
   */
  occluders(id: number, sunRel: Vec3): Array<{ rel: Vec3; radius: number }> {
    const self = this.views.get(id)!;
    const system = systemOf(self.body);
    const ds = Math.hypot(sunRel[0], sunRel[1], sunRel[2]);
    const found: Array<{ rel: Vec3; radius: number; score: number }> = [];
    for (const other of this.views.values()) {
      if (other === self || !other.available || other.body.emissive || systemOf(other.body) !== system) continue;
      const rel = sub(other.pos, self.pos, [0, 0, 0]);
      const d = Math.hypot(rel[0], rel[1], rel[2]);
      const cos = (rel[0] * sunRel[0] + rel[1] * sunRel[1] + rel[2] * sunRel[2]) / (d * ds);
      if (cos <= 0 || d > ds) continue;
      const sep = Math.acos(Math.min(1, cos));
      const score = sep - (self.body.radii[0] + other.body.radii[0] * 1.2) / d - SUN_RADIUS / ds;
      if (score < 0) found.push({ rel, radius: (other.body.radii[0] + other.body.radii[1] + other.body.radii[2]) / 3, score });
    }
    return found.sort((a, b) => a.score - b.score).slice(0, MAX_OCCLUDERS);
  }

  /** Give every body that uses this global map its texture. */
  setMap(name: string, texture: THREE.Texture, mean: Vec3): void {
    for (const view of this.views.values()) if (view.body.map === name) view.globe?.setMap(texture, mean);
  }

  position(id: number): Vec3 {
    return this.views.get(id)!.pos;
  }

  available(id: number): boolean {
    return this.views.get(id)?.available ?? false;
  }

  orientationOf(id: number): Mat3 {
    return this.views.get(id)!.bodyToScene;
  }

  private sampleOrbit(view: BodyView, tdb: number): void {
    const { orbit } = view.body;
    if (!orbit) return;
    const period = orbit.periodDays * 86400;
    // One full revolution centred on now, clipped to the ephemeris range (Pluto's
    // 248-year orbit is longer than the bundled years, so it draws as an arc).
    const [s0, s1] = this.ephemeris.coverage(view.body.id);
    const [p0, p1] = this.ephemeris.coverage(orbit.around);
    const t0 = Math.max(s0, p0, tdb - period / 2);
    const t1 = Math.min(s1, p1, tdb + period / 2);
    const closed = t1 - t0 >= period * 0.999;
    const positions = new Float32Array(ORBIT_SAMPLES * 3);
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [0, 0, 0];
    const rel: Vec3 = [0, 0, 0];
    for (let i = 0; i < ORBIT_SAMPLES; i++) {
      // Clamped: rounding can push the last sample a hair past the ephemeris end.
      const t = Math.min(t1, t0 + ((t1 - t0) * i) / (closed ? ORBIT_SAMPLES : ORBIT_SAMPLES - 1));
      this.ephemeris.position(view.body.id, t, a);
      this.ephemeris.position(orbit.around, t, b);
      icrfToScene(sub(a, b, rel), rel);
      positions.set(rel, i * 3);
    }
    const geometry = view.orbit!.line.geometry;
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();
    if (closed !== view.orbit!.line instanceof THREE.LineLoop) {
      const replacement = closed ? new THREE.LineLoop(geometry, view.orbit!.line.material) : new THREE.Line(geometry, view.orbit!.line.material);
      replacement.frustumCulled = false;
      this.group.remove(view.orbit!.line);
      this.group.add(replacement);
      view.orbit!.line = replacement;
    }
    view.orbit!.sampledAt = tdb;
  }
}

/** The planet a body belongs with (itself for planets), or 10 for the Sun's own family. */
export function systemOf(body: Body): number {
  return body.orbit && body.orbit.around !== 10 ? body.orbit.around : body.id;
}

function makeOrbitLine(body: Body): THREE.LineLoop {
  const geometry = new THREE.BufferGeometry();
  const color = body.orbit!.around === 10 ? body.color : '#8899aa';
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false });
  const line = new THREE.LineLoop(geometry, material);
  line.frustumCulled = false;
  return line;
}

export { bodyById };
