import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { icrfToScene } from '../core/frames';
import { Track } from '../core/track';

/**
 * An asteroid or comet on a close pass by Earth, from its Horizons track: a point where
 * it is now and its path past Earth as a line. The path is drawn around Earth (it is
 * geocentric), so the bend of the flyby shows plainly. Too small to see as a disc.
 */
export class Visitor {
  readonly group = new THREE.Group();
  private readonly point: THREE.Points;
  private readonly scratch: Vec3 = [0, 0, 0];

  constructor(readonly track: Track, readonly name: string, comet: boolean) {
    const colour = comet ? 0x9fe3ff : 0xffc27a;
    // The path, sampled every 10 minutes or at the track's own step if longer.
    const n = Math.min(4000, Math.ceil((track.end - track.start) / 600));
    const path = new Float32Array((n + 1) * 3);
    const p: Vec3 = [0, 0, 0];
    for (let i = 0; i <= n; i++) {
      icrfToScene(track.position(track.start + ((track.end - track.start) * i) / n, p), p);
      path.set(p, i * 3);
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(path, 3)),
      new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    line.frustumCulled = false;
    this.point = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3)),
      new THREE.PointsMaterial({ color: colour, size: 5, sizeAttenuation: false, depthWrite: false }),
    );
    this.point.frustumCulled = false;
    this.group.add(line, this.point);
  }

  /** Geocentric position (scene axes, km), or undefined outside the track. */
  position(tdb: number, out: Vec3 = [0, 0, 0]): Vec3 | undefined {
    if (!this.track.covers(tdb)) return undefined;
    return icrfToScene(this.track.position(tdb, this.scratch), out);
  }

  /** `earthRel`: Earth's centre relative to the camera. */
  update(earthRel: Vec3, tdb: number): void {
    const p = this.position(tdb);
    this.group.visible = p !== undefined;
    if (!p) return;
    this.group.position.set(earthRel[0], earthRel[1], earthRel[2]);
    const attr = this.point.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.setXYZ(0, p[0], p[1], p[2]);
    attr.needsUpdate = true;
  }

  static async load(url: string, name: string, comet: boolean): Promise<Visitor> {
    const json = await (await fetch(url)).json();
    return new Visitor(new Track(json), name, comet);
  }
}
