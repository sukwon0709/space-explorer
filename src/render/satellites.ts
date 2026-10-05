import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { earthFixedPosition, periodMinutes, type Satellite } from '../core/satellites';

/** Satellites drawn with a trail and a label. */
export const NAMED_SATELLITES = new Map([
  [25544, 'ISS'],
  [48274, 'Tiangong'],
]);

const TRAIL_SAMPLES = 180;
const EARTH_RADIUS = 6371;

const vertexShader = /* glsl */ `
attribute vec3 color;
attribute float size;
varying vec3 vColor;
uniform float pixelRatio;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vColor = color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * pixelRatio;
  #include <logdepthbuf_vertex>
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vColor;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(vColor * (1.0 - d * d * 0.6), 1.0);
}
`;

/**
 * Earth satellites from SGP4, placed every frame relative to the camera. Positions are
 * worked out in Earth-fixed axes, then turned into scene axes with Earth's orientation
 * at the same instant.
 */
export class SatelliteLayer {
  readonly group = new THREE.Group();
  private satellites: Satellite[] = [];
  private points!: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly trails = new Map<number, { line: THREE.Line; sampledAt: number; positions: Float32Array }>();
  /** Scene-axis position of each satellite relative to Earth's centre, km (NaN when unknown). */
  private relative = new Float64Array(0);
  private readonly scratch: Vec3 = [0, 0, 0];
  private readonly rotation = new Float64Array(9);

  constructor(
    satellites: Satellite[],
    /** Earth's body-fixed to scene rotation (row-major) at a UTC instant. */
    private readonly earthToScene: (unixMs: number, out: Float64Array) => void,
    pixelRatio: number,
  ) {
    this.material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: { pixelRatio: { value: pixelRatio } } });
    for (const [id] of NAMED_SATELLITES) {
      const positions = new Float32Array(TRAIL_SAMPLES * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const line = new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.45 }));
      line.frustumCulled = false;
      line.visible = false;
      this.group.add(line);
      this.trails.set(id, { line, sampledAt: NaN, positions });
    }
    this.setSatellites(satellites);
  }

  /** Replace the catalogue (for example with fresher elements). */
  setSatellites(satellites: Satellite[]): void {
    this.satellites = satellites;
    if (this.points) {
      this.group.remove(this.points);
      this.points.geometry.dispose();
    }
    const n = satellites.length;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n), 1));
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this.relative = new Float64Array(n * 3);
    for (const trail of this.trails.values()) trail.sampledAt = NaN;
  }

  /** Position of a satellite relative to Earth's centre in scene axes, or null. */
  relativePosition(id: number): Vec3 | null {
    const i = this.satellites.findIndex((s) => s.id === id);
    if (i < 0 || Number.isNaN(this.relative[i * 3])) return null;
    return [this.relative[i * 3], this.relative[i * 3 + 1], this.relative[i * 3 + 2]];
  }

  /**
   * @param unixMs UTC instant
   * @param earthRel Earth's centre minus the camera, scene axes, km
   * @param sunDir unit vector from Earth to the Sun, scene axes
   */
  update(unixMs: number, earthRel: Vec3, sunDir: Vec3): void {
    const pos = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.points.geometry.getAttribute('color') as THREE.BufferAttribute;
    const size = this.points.geometry.getAttribute('size') as THREE.BufferAttribute;
    const m = this.rotation;
    this.earthToScene(unixMs, m);
    const p = this.scratch;
    this.satellites.forEach((sat, i) => {
      if (!earthFixedPosition(sat, unixMs, p)) {
        this.relative.fill(NaN, i * 3, i * 3 + 3);
        pos.setXYZ(i, 0, 0, 0);
        size.setX(i, 0);
        return;
      }
      for (let k = 0; k < 3; k++) this.relative[i * 3 + k] = m[k * 3] * p[0] + m[k * 3 + 1] * p[1] + m[k * 3 + 2] * p[2];
      const x = this.relative[i * 3], y = this.relative[i * 3 + 1], z = this.relative[i * 3 + 2];
      pos.setXYZ(i, earthRel[0] + x, earthRel[1] + y, earthRel[2] + z);
      // In Earth's shadow: behind Earth and within a radius of the Sun-Earth line.
      const along = x * sunDir[0] + y * sunDir[1] + z * sunDir[2];
      const eclipsed = along < 0 && x * x + y * y + z * z - along * along < EARTH_RADIUS * EARTH_RADIUS;
      const named = NAMED_SATELLITES.has(sat.id);
      const [r, g, b] = named ? [1, 0.82, 0.48] : sat.groups.includes('gps-ops') ? [0.55, 0.85, 1] : [0.9, 0.92, 0.95];
      const light = eclipsed ? 0.18 : 1;
      col.setXYZ(i, r * light, g * light, b * light);
      size.setX(i, named ? 6 : 3.5);
    });
    pos.needsUpdate = col.needsUpdate = size.needsUpdate = true;

    for (const [id, trail] of this.trails) {
      const sat = this.satellites.find((s) => s.id === id);
      trail.line.visible = false;
      if (!sat || !earthFixedPosition(sat, unixMs, p)) continue;
      const period = periodMinutes(sat) * 60000;
      if (!(Math.abs(unixMs - trail.sampledAt) < period / TRAIL_SAMPLES)) this.sampleTrail(sat, unixMs, period, trail);
      trail.line.visible = true;
      trail.line.position.set(earthRel[0], earthRel[1], earthRel[2]);
    }
  }

  /** One revolution centred on now, in scene axes relative to Earth (an inertial path). */
  private sampleTrail(sat: Satellite, unixMs: number, period: number, trail: { line: THREE.Line; sampledAt: number; positions: Float32Array }): void {
    const p = this.scratch;
    const m = new Float64Array(9);
    for (let i = 0; i < TRAIL_SAMPLES; i++) {
      const t = unixMs + ((i / TRAIL_SAMPLES) - 0.5) * period;
      this.earthToScene(t, m);
      if (!earthFixedPosition(sat, t, p)) p.fill(0);
      for (let k = 0; k < 3; k++) trail.positions[i * 3 + k] = m[k * 3] * p[0] + m[k * 3 + 1] * p[1] + m[k * 3 + 2] * p[2];
    }
    trail.line.geometry.getAttribute('position').needsUpdate = true;
    trail.line.geometry.computeBoundingSphere();
    trail.sampledAt = unixMs;
  }
}
