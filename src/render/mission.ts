import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { icrfToScene } from '../core/frames';
import type { BodyPosition, Trajectory } from '../core/mission';
import type { Mission } from '../ui/missions';
import { buildModel, detach, lightModel } from './spacecraft';
import { utcToTdb } from '../core/time';

/** Cassini released Huygens on 25 December 2004 at 02:00 UTC. */
const HUYGENS_RELEASE = utcToTdb(Date.UTC(2004, 11, 25, 2, 0));
const IMPACTOR_RELEASE = utcToTdb(Date.UTC(2005, 6, 3, 6, 0));

const DEG = Math.PI / 180;
/** Most points drawn for one trail. */
const MAX_POINTS = 120000;

/**
 * A spacecraft on its trajectory: the model up close, a dot from afar, and its path.
 *
 * The path is drawn in one body's frame and moves with it: the Sun's in cruise, a
 * planet's (or the Moon's) while the spacecraft is inside its sphere of influence and
 * the camera is too, so orbits and flybys show their true shape around the body.
 * Points are kept in float64 relative to that body and written relative to the camera
 * every frame, and the stretch around the spacecraft is resampled finely, so the line
 * passes through the model even from a few metres away.
 */
export class MissionView {
  readonly group = new THREE.Group();
  readonly model: THREE.Group;
  private readonly marker: THREE.Points;
  private readonly past: THREE.Line;
  private readonly future: THREE.Line;
  private readonly uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunIntensity: { value: 7 },
    uAmbient: { value: new THREE.Vector3() },
  };
  /** Trail points per frame body and stretch: times and float64 positions relative to the body (scene axes). */
  private readonly trails = new Map<string, { t: Float64Array; p: Float64Array }>();
  /** Rows [first, last] of each stretch spent in one body's frame. */
  private readonly runs: Array<{ centre: number; first: number; last: number }> = [];
  private readonly scratch: Vec3 = [0, 0, 0];
  private readonly scratch2: Vec3 = [0, 0, 0];
  private readonly icrf: Vec3 = [0, 0, 0];
  private readonly basis = new THREE.Matrix4();
  private readonly buffers: [Float32Array, Float32Array];
  /** The frame the trail is drawn in this frame. */
  frameBody = 10;
  /** Size of the model, m (for the dot/model switch). */
  readonly size: number;

  constructor(readonly mission: Mission, readonly traj: Trajectory, private readonly at: BodyPosition) {
    this.model = buildModel(mission.model, this.uniforms);
    this.model.scale.setScalar(0.001); // metres to the scene's km
    const box = new THREE.Box3().setFromObject(this.model);
    this.size = box.getSize(new THREE.Vector3()).length() * 1000;
    const colour = new THREE.Color(mission.color);
    this.marker = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3)),
      new THREE.PointsMaterial({ color: colour, size: 6, sizeAttenuation: false, depthWrite: false, transparent: true, toneMapped: false }),
    );
    this.marker.frustumCulled = false;
    this.buffers = [new Float32Array(MAX_POINTS * 3 + 600), new Float32Array(MAX_POINTS * 3 + 600)];
    const line = (buffer: Float32Array, opacity: number) => {
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(buffer, 3).setUsage(THREE.DynamicDrawUsage));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity, depthWrite: false, toneMapped: false }));
      l.frustumCulled = false;
      return l;
    };
    for (let i = 0; i < traj.length; i++) {
      const run = this.runs[this.runs.length - 1];
      if (run && run.centre === traj.centres[i]) run.last = i;
      else this.runs.push({ centre: traj.centres[i], first: i, last: i });
    }
    this.past = line(this.buffers[0], 0.85);
    this.future = line(this.buffers[1], 0.28);
    this.group.add(this.past, this.future, this.marker, this.model);
  }

  /** Spacecraft position in the scene (km, barycentric). */
  position(tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    return icrfToScene(this.traj.position(tdb, this.at, this.icrf), out);
  }

  /** Spacecraft velocity in the scene axes (km/s, barycentric). */
  velocity(tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    return icrfToScene(this.traj.velocity(tdb, this.at, this.icrf), out);
  }

  /** A body's scene position at any epoch. */
  bodyAt(id: number, tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    return icrfToScene(this.at(id, tdb, this.icrf), out);
  }

  /** Position relative to `frame` at tdb (scene axes, km). */
  private relativeTo(frame: number, tdb: number, out: Vec3): Vec3 {
    if (this.traj.centre(tdb) === frame) return icrfToScene(this.traj.relative(tdb, this.icrf), out);
    this.position(tdb, out);
    const b = this.bodyAt(frame, tdb, this.scratch2);
    for (let k = 0; k < 3; k++) out[k] -= b[k];
    return out;
  }

  /**
   * The trail in a body's frame: every row, with each interval cut into pieces that
   * turn at most half a degree about the body, so long cruise steps still curve.
   * The Sun's frame covers the whole mission; a planet's only the stretch in its
   * sphere of influence around `tdb`.
   */
  private trail(frame: number, tdb: number): { t: Float64Array; p: Float64Array } {
    const traj = this.traj;
    let first = 0, last = traj.length - 1;
    if (frame !== 10) {
      const i = traj.index(tdb);
      const run = this.runs.find((r) => r.centre === frame && r.first <= i + 1 && r.last >= i);
      if (run) ({ first, last } = run);
      else {
        // A short pass the table keeps in the parent's frame (the Moon inside Earth's
        // sphere): the days around it.
        first = traj.index(tdb - 2 * 86400);
        last = Math.min(traj.length - 1, traj.index(tdb + 2 * 86400) + 1);
      }
    }
    const key = `${frame}:${first}`;
    let trail = this.trails.get(key);
    if (trail) return trail;
    const times: number[] = [];
    const v: Vec3 = [0, 0, 0], r: Vec3 = [0, 0, 0];
    for (let i = first; i < last; i++) {
      const c = traj.centres[i];
      const t0 = traj.t[i], t1 = traj.t[i + 1];
      if (!(t1 > t0)) continue;
      // Angle swept about the frame body over the interval, from the row's own state.
      if (c === frame) {
        for (let k = 0; k < 3; k++) {
          r[k] = traj.p[i * 3 + k];
          v[k] = traj.v[i * 3 + k];
        }
      } else {
        this.relativeTo(frame, t0, r);
        this.relativeTo(frame, t0 + 1, v);
        for (let k = 0; k < 3; k++) v[k] -= r[k];
      }
      const swept = (Math.hypot(v[0], v[1], v[2]) * (t1 - t0)) / Math.max(1, Math.hypot(r[0], r[1], r[2]));
      const n = Math.min(64, Math.max(1, Math.ceil(swept / (0.5 * DEG))));
      for (let k = 0; k < n; k++) times.push(t0 + ((t1 - t0) * k) / n);
    }
    times.push(traj.t[last]);
    // Thin evenly if there are too many.
    const stride = Math.ceil(times.length / MAX_POINTS);
    const kept = times.filter((_, k) => k % stride === 0 || k === times.length - 1);
    const p = new Float64Array(kept.length * 3);
    kept.forEach((t, k) => {
      this.relativeTo(frame, t, this.scratch);
      p.set(this.scratch, k * 3);
    });
    trail = { t: Float64Array.from(kept), p };
    this.trails.set(key, trail);
    return trail;
  }

  /**
   * Draw for this frame. `eye` is the camera (scene), `frame` the body to draw the trail
   * around, `earth` and `sun` positions (scene), `exposure` the scene's, `ppr` pixels per
   * radian.
   */
  update(tdb: number, eye: Vec3, frame: number, sun: Vec3, earth: Vec3, exposure: number, ppr: number, showTrail: boolean): void {
    const traj = this.traj;
    const visible = traj.covers(tdb);
    this.group.visible = visible;
    if (!visible) return;
    const p = this.position(tdb, [0, 0, 0]);
    const rel: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
    const d = Math.hypot(rel[0], rel[1], rel[2]);

    // The model: oriented, lit, and shown once it spans a few pixels.
    const toSun = norm([sun[0] - p[0], sun[1] - p[1], sun[2] - p[2]]);
    const toEarth = norm([earth[0] - p[0], earth[1] - p[1], earth[2] - p[2]]);
    let z = toEarth;
    if (this.mission.model === 'parker') z = toSun;
    else if (this.mission.model === 'orion') {
      // Nose along the velocity relative to Earth.
      const v = this.velocity(tdb, this.scratch);
      const e0 = this.bodyAt(399, tdb - 0.5, this.scratch2);
      const e1 = this.bodyAt(399, tdb + 0.5, [0, 0, 0]);
      z = norm([v[0] - (e1[0] - e0[0]), v[1] - (e1[1] - e0[1]), v[2] - (e1[2] - e0[2])]);
    }
    // Roll so the Sun lies in the x-z plane (wings and panels turned to it).
    let x = sub3(toSun, scale3(z, dot3(toSun, z)));
    if (Math.hypot(x[0], x[1], x[2]) < 1e-6) x = Math.abs(z[1]) < 0.9 ? cross3([0, 1, 0], z) : cross3([1, 0, 0], z);
    x = norm(x);
    const y = cross3(z, x);
    this.basis.makeBasis(new THREE.Vector3(...x), new THREE.Vector3(...y), new THREE.Vector3(...z));
    this.model.quaternion.setFromRotationMatrix(this.basis);
    this.model.position.set(rel[0], rel[1], rel[2]);
    const r2 = (sun[0] - p[0]) ** 2 + (sun[1] - p[1]) ** 2 + (sun[2] - p[2]) ** 2;
    const AU = 149597870.7;
    lightModel(this.uniforms, toSun, (7 * exposure * AU * AU) / r2);
    const pixels = ((this.size / 1000) * ppr) / Math.max(d, 1e-9);
    this.model.visible = pixels > 1.5;
    this.marker.visible = pixels < 8;
    const attr = this.marker.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.setXYZ(0, rel[0], rel[1], rel[2]);
    attr.needsUpdate = true;
    if (this.mission.model === 'cassini') detach(this.model, 'huygens', tdb < HUYGENS_RELEASE);
    if (this.mission.model === 'deepimpact') detach(this.model, 'impactor', tdb < IMPACTOR_RELEASE);

    // The trail, relative to the camera.
    this.past.visible = this.future.visible = showTrail;
    if (!showTrail) return;
    this.frameBody = frame;
    const trail = this.trail(frame, tdb);
    const origin = frame === 10 ? sun : this.bodyAt(frame, tdb, [0, 0, 0]);
    const ox = origin[0] - eye[0], oy = origin[1] - eye[1], oz = origin[2] - eye[2];
    // The stretch around now: the trail's neighbours of tdb, resampled ever closer to it.
    const t = trail.t;
    let lo = 0, hi = t.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= tdb) lo = mid;
      else hi = mid;
    }
    const a = Math.max(0, lo - 1), b = Math.min(t.length - 1, lo + 2);
    const [pastBuf, futureBuf] = this.buffers;
    let np = 0, nf = 0;
    const put = (buf: Float32Array, n: number, q: ArrayLike<number>, j: number) => {
      buf[n * 3] = q[j] + ox;
      buf[n * 3 + 1] = q[j + 1] + oy;
      buf[n * 3 + 2] = q[j + 2] + oz;
    };
    for (let k = 0; k <= a; k++) put(pastBuf, np++, trail.p, k * 3);
    const near: number[] = [];
    const before = tdb - t[a], after = t[b] - tdb;
    for (let k = 1; k <= 48; k++) {
      const f = Math.pow(0.6, k);
      if (before > 0) near.push(tdb - before * (1 - f));
      if (after > 0) near.push(tdb + after * (1 - f));
    }
    near.push(tdb);
    near.sort((u, w) => u - w);
    const q: Vec3 = [0, 0, 0];
    for (const tn of near) {
      if (tn <= t[a] || tn >= t[b]) continue;
      this.relativeTo(frame, tn, q);
      if (tn <= tdb) put(pastBuf, np++, q, 0);
      if (tn >= tdb) put(futureBuf, nf++, q, 0);
    }
    for (let k = b; k < t.length; k++) put(futureBuf, nf++, trail.p, k * 3);
    for (const [line, n] of [[this.past, np], [this.future, nf]] as const) {
      const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.needsUpdate = true;
      line.geometry.setDrawRange(0, n);
    }
  }
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
