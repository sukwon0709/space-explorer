import * as THREE from 'three';
import { BODIES, SATURN_RINGS, bodyById, type Body } from '../core/bodies';
import type { Ephemeris, Vec3 } from '../core/ephemeris';
import { icrfToScene, raDecToIcrf, sub } from '../core/frames';

const ORBIT_SAMPLES = 512;

interface BodyView {
  body: Body;
  /** Scene-axis position relative to the barycentre, km, float64. Updated each frame. */
  pos: Vec3;
  object: THREE.Object3D;
  orbit?: OrbitView;
}

interface OrbitView {
  line: THREE.LineLoop | THREE.Line;
  sampledAt: number;
}

/**
 * The Solar System scene. Every position is kept in float64 (JS numbers) relative to the
 * barycentre; each frame the camera's float64 position is subtracted before anything is
 * handed to three.js, so the GPU only ever sees small camera-relative float32 values.
 */
export class SolarSystem {
  readonly group = new THREE.Group();
  readonly views = new Map<number, BodyView>();
  private readonly sunLight = new THREE.PointLight(0xffffff, 3.2, 0, 0);
  private readonly scratch: Vec3 = [0, 0, 0];

  constructor(private readonly ephemeris: Ephemeris) {
    this.group.add(this.sunLight);
    for (const body of BODIES) {
      const object = body.emissive ? makeSun(body) : makePlanet(body);
      this.group.add(object);
      const view: BodyView = { body, pos: [0, 0, 0], object };
      if (body.orbit) {
        const line = makeOrbitLine(body);
        this.group.add(line);
        view.orbit = { line, sampledAt: NaN };
      }
      this.views.set(body.id, view);
    }
  }

  /** Recompute float64 positions for the epoch. */
  update(tdb: number): void {
    for (const view of this.views.values()) {
      icrfToScene(this.ephemeris.position(view.body.id, tdb, this.scratch), view.pos);
      if (view.orbit && view.body.orbit) {
        const periodSeconds = view.body.orbit.periodDays * 86400;
        if (!(Math.abs(tdb - view.orbit.sampledAt) < periodSeconds / 256)) {
          this.sampleOrbit(view, tdb);
        }
      }
    }
  }

  /** Place every object relative to the camera (floating origin) and fade orbits near the camera. */
  placeRelativeTo(camera: Vec3): void {
    const rel: Vec3 = [0, 0, 0];
    for (const view of this.views.values()) {
      sub(view.pos, camera, rel);
      view.object.position.set(rel[0], rel[1], rel[2]);
      if (view.body.emissive) {
        this.sunLight.position.set(rel[0], rel[1], rel[2]);
        // Keep the Sun's glow at least a few percent of the view wide so it stays findable
        // from the outer planets, where its true disk is under a pixel.
        const glow = view.object.children[1] as THREE.Sprite;
        glow.scale.setScalar(Math.max(view.body.radius[0] * 12, Math.hypot(rel[0], rel[1], rel[2]) * 0.06));
      }
      if (view.orbit && view.body.orbit) {
        const parent = this.views.get(view.body.orbit.around)!;
        sub(parent.pos, camera, rel);
        view.orbit.line.position.set(rel[0], rel[1], rel[2]);
        // Hide a body's own orbit line once you are close to it: at that range the line is
        // just a streak through the planet.
        const d = Math.hypot(view.pos[0] - camera[0], view.pos[1] - camera[1], view.pos[2] - camera[2]);
        const fade = THREE.MathUtils.clamp((d / view.body.radius[0] - 40) / 160, 0, 1);
        const material = view.orbit.line.material as THREE.LineBasicMaterial;
        material.opacity = 0.45 * fade;
        view.orbit.line.visible = fade > 0;
      }
    }
  }

  position(id: number): Vec3 {
    return this.views.get(id)!.pos;
  }

  private sampleOrbit(view: BodyView, tdb: number): void {
    const { orbit } = view.body;
    if (!orbit) return;
    const period = orbit.periodDays * 86400;
    // One full revolution centred on now, clipped to the ephemeris range (Pluto's
    // 248-year orbit is longer than the bundled 61 years, so it draws as an arc).
    const t0 = Math.max(this.ephemeris.start, tdb - period / 2);
    const t1 = Math.min(this.ephemeris.end, tdb + period / 2);
    const closed = t1 - t0 >= period * 0.999;
    const positions = new Float32Array(ORBIT_SAMPLES * 3);
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [0, 0, 0];
    const rel: Vec3 = [0, 0, 0];
    for (let i = 0; i < ORBIT_SAMPLES; i++) {
      const t = t0 + ((t1 - t0) * i) / (closed ? ORBIT_SAMPLES : ORBIT_SAMPLES - 1);
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
      this.group.remove(view.orbit!.line);
      this.group.add(replacement);
      view.orbit!.line = replacement;
    }
    view.orbit!.sampledAt = tdb;
  }
}

/** Rotation taking the mesh's +y axis onto the body's IAU north pole. */
function poleQuaternion(body: Body): THREE.Quaternion {
  const pole = icrfToScene(raDecToIcrf(body.pole[0], body.pole[1]));
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...pole).normalize());
}

function makePlanet(body: Body): THREE.Object3D {
  const [eq, polar] = body.radius;
  const geometry = new THREE.SphereGeometry(1, 96, 64);
  const material = new THREE.MeshStandardMaterial({ color: body.color, roughness: 0.9, metalness: 0 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.set(eq, polar, eq); // true oblateness
  const holder = new THREE.Group();
  holder.quaternion.copy(poleQuaternion(body));
  holder.add(mesh);
  if (body.id === 6) holder.add(makeSaturnRings());
  holder.name = body.name;
  return holder;
}

function makeSaturnRings(): THREE.Mesh {
  const inner = SATURN_RINGS[0].inner;
  const outer = SATURN_RINGS[SATURN_RINGS.length - 1].outer;
  // Radial opacity profile as a 1D texture across the ring's width.
  const width = 1024;
  const data = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    const r = inner + ((outer - inner) * (i + 0.5)) / width;
    const band = SATURN_RINGS.find((b) => r >= b.inner && r < b.outer) ?? SATURN_RINGS[SATURN_RINGS.length - 1];
    data.set([226, 210, 180, Math.round(band.opacity * 255)], i * 4);
  }
  const texture = new THREE.DataTexture(data, width, 1);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  texture.colorSpace = THREE.SRGBColorSpace;

  const geometry = new THREE.RingGeometry(inner, outer, 256, 1);
  // Map u to the radial direction so the texture runs from the inner to the outer edge.
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    uv.setXY(i, (r - inner) / (outer - inner), 0.5);
  }
  const material = new THREE.MeshStandardMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, roughness: 1, depthWrite: false });
  const rings = new THREE.Mesh(geometry, material);
  rings.rotation.x = -Math.PI / 2; // ring plane = Saturn's equator (mesh xz plane)
  return rings;
}

function makeSun(body: Body): THREE.Object3D {
  const group = new THREE.Group();
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(body.radius[0], 64, 32),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(body.color).multiplyScalar(4), toneMapped: true }),
  );
  group.add(sphere);
  group.add(makeGlow(body.radius[0]));
  group.name = body.name;
  return group;
}

function makeGlow(radius: number): THREE.Sprite {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,248,230,1)');
  g.addColorStop(0.12, 'rgba(255,236,200,0.55)');
  g.addColorStop(0.35, 'rgba(255,210,150,0.12)');
  g.addColorStop(1, 'rgba(255,200,140,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  sprite.scale.setScalar(radius * 12);
  return sprite;
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
