import type { Vec3 } from '../core/ephemeris';

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** A point the camera looks at, with a local east/north/up basis (scene axes, float64). */
export interface Frame {
  origin: Vec3;
  east: Vec3;
  north: Vec3;
  up: Vec3;
}

/** Longitude and latitude (radians) of the look point on a body with terrain. */
export interface Anchor {
  lon: number;
  lat: number;
}

/** The fixed (right-handed) basis used for bodies without terrain: up is ecliptic north. */
export const SCENE_BASIS = { east: [1, 0, 0] as Vec3, north: [0, 0, -1] as Vec3, up: [0, 1, 0] as Vec3 };

interface Flight {
  from: number;
  fromAnchor?: Anchor;
  fromDistance: number;
  fromYaw: number;
  fromPitch: number;
  start: number;
  duration: number;
}

/**
 * Camera that looks at a point: a body's centre, or (for Earth and the Moon) a point on
 * the ground, Google Earth style. `distance` is km from that point; `yaw` is the
 * heading the camera faces (radians from north toward east, in the local frame) and
 * `pitch` how high above the local horizon the camera sits, seen from the point
 * (pi/2 looks straight down). All state is float64.
 */
export class CameraRig {
  focus: number;
  anchor?: Anchor;
  distance: number;
  yaw = 0.6;
  pitch = 0.35;
  minDistance = 1;
  private flight?: Flight;
  private target: number;

  constructor(focus: number, distance: number, anchor?: Anchor) {
    this.focus = this.target = focus;
    this.distance = distance;
    this.anchor = anchor;
  }

  get flying(): boolean {
    return this.flight !== undefined;
  }

  /** Fly to `target`, ending `distance` km from its look point, seen from `yaw`/`pitch`. */
  flyTo(target: number, distance: number, now: number, yaw = this.yaw, pitch = this.pitch, anchor?: Anchor, duration?: number): void {
    this.flight = {
      from: this.focus,
      fromAnchor: this.anchor,
      fromDistance: this.distance,
      fromYaw: this.yaw,
      fromPitch: this.pitch,
      start: now,
      duration: duration ?? (target === this.focus ? 1.5 : 4),
    };
    // Turn the short way round.
    this.yaw = this.yaw + Math.atan2(Math.sin(yaw - this.yaw), Math.cos(yaw - this.yaw));
    this.pitch = pitch;
    this.distance = distance;
    this.focus = this.target = target;
    this.anchor = anchor;
  }

  orbit(dx: number, dy: number): void {
    if (this.flight) return;
    this.yaw += dx * 0.005;
    this.pitch = Math.max(this.anchor ? 0.005 : -1.55, Math.min(Math.PI / 2, this.pitch + dy * 0.005));
  }

  /** Slide the look point across the ground by a screen drag (anchored views only). */
  pan(dx: number, dy: number, pixelsPerRadian: number, radius: number): void {
    if (this.flight || !this.anchor) return;
    const km = Math.min(this.distance, radius * 1.5) / pixelsPerRadian;
    // Heading frame: forward along the ground and to the right, in east/north components.
    const fE = Math.sin(this.yaw), fN = Math.cos(this.yaw);
    const rE = fN, rN = -fE;
    const dE = (-dx * rE + dy * fE) * km;
    const dN = (-dx * rN + dy * fN) * km;
    const lat = Math.max(-1.5706, Math.min(1.5706, this.anchor.lat + dN / radius));
    const lon = this.anchor.lon + dE / (radius * Math.max(0.01, Math.cos(this.anchor.lat)));
    this.anchor = { lon: Math.atan2(Math.sin(lon), Math.cos(lon)), lat };
  }

  /** Exponential zoom: each wheel notch changes distance by the same ratio at any scale. */
  zoom(delta: number): void {
    if (this.flight) return;
    this.distance = Math.max(this.minDistance, this.distance * Math.exp(delta * 0.0015));
  }

  /**
   * Camera position, look point and up vector (scene axes, km, float64) for this frame.
   * During a flight the look point and its frame slide between the two ends while the
   * distance follows an arc in log space, rising high enough to show both ends.
   * `offset` is eye minus look point, exact even where the scene positions themselves
   * are too coarse (a stellar black hole hundreds of parsecs away).
   */
  solve(frameOf: (id: number, anchor?: Anchor) => Frame, now: number): { eye: Vec3; target: Vec3; up: Vec3; offset: Vec3 } {
    let frame = frameOf(this.target, this.anchor);
    let { distance, yaw, pitch } = this;
    if (this.flight) {
      const f = this.flight;
      const t = Math.min(1, (now - f.start) / f.duration);
      const e = easeInOut(t);
      const a = frameOf(f.from, f.fromAnchor);
      const b = frame;
      const separation = Math.hypot(b.origin[0] - a.origin[0], b.origin[1] - a.origin[1], b.origin[2] - a.origin[2]);
      const peak = Math.log(Math.max(f.fromDistance, this.distance, separation * 1.2));
      const l0 = Math.log(f.fromDistance);
      const l1 = Math.log(this.distance);
      // Quadratic Bezier in log-distance with the control point lifted to the peak.
      const ctrl = 2 * peak - (l0 + l1) / 2;
      distance = Math.exp((1 - e) * (1 - e) * l0 + 2 * (1 - e) * e * ctrl + e * e * l1);
      yaw = f.fromYaw + (this.yaw - f.fromYaw) * e;
      pitch = f.fromPitch + (this.pitch - f.fromPitch) * e;
      frame = blendFrames(a, b, e);
      if (t >= 1) this.flight = undefined;
    }
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const hE = Math.sin(yaw), hN = Math.cos(yaw);
    const { origin, east, north, up } = frame;
    const eye: Vec3 = [0, 0, 0];
    const offset: Vec3 = [0, 0, 0];
    const camUp: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const heading = hE * east[k] + hN * north[k];
      offset[k] = distance * (-cp * heading + sp * up[k]);
      eye[k] = origin[k] + offset[k];
      camUp[k] = sp * heading + cp * up[k];
    }
    return { eye, target: origin, up: camUp, offset };
  }
}

/** Interpolate look point linearly and the basis by rotation (slerp of the frames). */
function blendFrames(a: Frame, b: Frame, t: number): Frame {
  const origin: Vec3 = [0, 1, 2].map((k) => a.origin[k] + (b.origin[k] - a.origin[k]) * t) as Vec3;
  const qa = basisToQuat(a), qb = basisToQuat(b);
  let dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
  if (dot < 0) {
    for (let k = 0; k < 4; k++) qb[k] = -qb[k];
    dot = -dot;
  }
  const q = [0, 1, 2, 3].map((k) => qa[k] + (qb[k] - qa[k]) * t);
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  const [x, y, z, w] = q.map((v) => v / len);
  // Columns of the rotation matrix are east, north, up.
  return {
    origin,
    east: [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
    north: [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
    up: [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
  };
}

function basisToQuat(f: Frame): number[] {
  // Rotation matrix with columns east, north, up.
  const m00 = f.east[0], m10 = f.east[1], m20 = f.east[2];
  const m01 = f.north[0], m11 = f.north[1], m21 = f.north[2];
  const m02 = f.up[0], m12 = f.up[1], m22 = f.up[2];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    return [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}
