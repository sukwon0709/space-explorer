import type { Vec3 } from '../core/ephemeris';

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Orbit-style camera around a focus body, with all state in float64.
 * `distance` is km from the focus centre; yaw/pitch are radians in scene axes.
 */
export class CameraRig {
  focus: number;
  distance: number;
  yaw = 0.6;
  pitch = 0.35;
  minDistance = 1;
  private flight?: {
    from: number; fromDistance: number; to: number; toDistance: number; start: number; duration: number;
    fromYaw: number; toYaw: number; fromPitch: number; toPitch: number;
  };

  constructor(focus: number, distance: number) {
    this.focus = focus;
    this.distance = distance;
  }

  get flying(): boolean {
    return this.flight !== undefined;
  }

  /** Fly to `target`, ending `distance` km from its centre and looking from `yaw`/`pitch`. */
  flyTo(target: number, distance: number, now: number, yaw = this.yaw, pitch = this.pitch): void {
    // Turn the short way round.
    const toYaw = this.yaw + Math.atan2(Math.sin(yaw - this.yaw), Math.cos(yaw - this.yaw));
    const angles = { fromYaw: this.yaw, toYaw, fromPitch: this.pitch, toPitch: pitch };
    const duration = target === this.focus ? 1.5 : 4;
    this.flight = { from: this.focus, fromDistance: this.distance, to: target, toDistance: distance, start: now, duration, ...angles };
    this.focus = target;
  }

  orbit(dx: number, dy: number): void {
    this.yaw -= dx * 0.005;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch + dy * 0.005));
  }

  /** Exponential zoom: each wheel notch changes distance by the same ratio at any scale. */
  zoom(delta: number): void {
    if (this.flight) return;
    this.distance = Math.max(this.minDistance, this.distance * Math.exp(delta * 0.0015));
  }

  /**
   * Camera position and look target (scene axes, km, float64) for this frame.
   * During a flight the look target slides between the two bodies while the distance
   * follows an arc in log space, rising high enough to show both ends of the trip.
   */
  solve(positionOf: (id: number) => Vec3, now: number): { eye: Vec3; target: Vec3 } {
    let target: Vec3;
    let distance = this.distance;
    if (this.flight) {
      const f = this.flight;
      const t = Math.min(1, (now - f.start) / f.duration);
      const e = easeInOut(t);
      const a = positionOf(f.from);
      const b = positionOf(f.to);
      target = [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e];
      const separation = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const peak = Math.log(Math.max(f.fromDistance, f.toDistance, separation * 1.2));
      const l0 = Math.log(f.fromDistance);
      const l1 = Math.log(f.toDistance);
      // Quadratic Bezier in log-distance with the control point lifted to the peak.
      const ctrl = 2 * peak - (l0 + l1) / 2;
      distance = Math.exp((1 - e) * (1 - e) * l0 + 2 * (1 - e) * e * ctrl + e * e * l1);
      this.yaw = f.fromYaw + (f.toYaw - f.fromYaw) * e;
      this.pitch = f.fromPitch + (f.toPitch - f.fromPitch) * e;
      if (t >= 1) {
        this.flight = undefined;
        this.yaw = f.toYaw;
        this.pitch = f.toPitch;
        this.distance = f.toDistance;
      } else {
        this.distance = distance;
      }
    } else {
      target = positionOf(this.focus);
    }
    const cp = Math.cos(this.pitch);
    const eye: Vec3 = [
      target[0] + distance * cp * Math.sin(this.yaw),
      target[1] + distance * Math.sin(this.pitch),
      target[2] + distance * cp * Math.cos(this.yaw),
    ];
    return { eye, target };
  }
}
