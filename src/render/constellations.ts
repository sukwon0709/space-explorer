import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { KMS_TO_PCYR } from '../core/stars';

/** Stellarium's modern constellation figures, with each figure star's catalogue position. */
export interface ConstellationData {
  /** x, y, z (pc, ICRS J2016.0), vx, vy, vz (km/s) per figure star. */
  stars: number[][];
  figures: Array<{ id: string; name: string; lines: number[][] }>;
}

const vertexShader = /* glsl */ `
attribute vec3 velocity;
uniform vec3 uCamHigh;
uniform vec3 uCamLow;
uniform float uYears;
uniform mat3 uIcrfToScene;
void main() {
  vec3 rel = (position - uCamHigh) + (velocity * (uYears * ${KMS_TO_PCYR.toExponential(10)}) - uCamLow);
  vec4 view = modelViewMatrix * vec4(uIcrfToScene * normalize(rel), 0.0);
  gl_Position = projectionMatrix * vec4(view.xyz, 1.0);
  gl_Position.z = gl_Position.w * 0.999998;
}
`;

const fragmentShader = /* glsl */ `
uniform float uOpacity;
void main() {
  gl_FragColor = vec4(vec3(0.35, 0.5, 0.8) * uOpacity, 1.0);
}
`;

/**
 * Constellation figures drawn between their stars' true 3D positions, so they hold their
 * shapes from Earth and come apart as you travel.
 */
export class Constellations {
  readonly lines: THREE.LineSegments;
  private readonly material: THREE.ShaderMaterial;

  constructor(readonly data: ConstellationData, starUniforms: Record<string, THREE.IUniform>) {
    const positions: number[] = [];
    const velocities: number[] = [];
    for (const figure of data.figures) {
      for (const poly of figure.lines) {
        for (let k = 0; k + 1 < poly.length; k++) {
          const a = poly[k], b = poly[k + 1];
          if (a < 0 || b < 0) continue;
          for (const s of [data.stars[a], data.stars[b]]) {
            positions.push(s[0], s[1], s[2]);
            velocities.push(s[3], s[4], s[5]);
          }
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('velocity', new THREE.Float32BufferAttribute(velocities, 3));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCamHigh: starUniforms.uCamHigh,
        uCamLow: starUniforms.uCamLow,
        uYears: starUniforms.uYears,
        uIcrfToScene: starUniforms.uIcrfToScene,
        uOpacity: { value: 0.6 },
      },
      vertexShader,
      fragmentShader,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.lines = new THREE.LineSegments(g, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = -9;
  }

  set opacity(value: number) {
    this.material.uniforms.uOpacity.value = value;
    this.lines.visible = value > 0.001;
  }

  /** Mean direction of each figure's stars from the camera (pc, ICRS), for labels. */
  centres(camera: Vec3, years: number): Array<{ name: string; dir: Vec3 }> {
    const k = years * KMS_TO_PCYR;
    return this.data.figures.map((f) => {
      const sum: Vec3 = [0, 0, 0];
      const seen = new Set<number>();
      for (const poly of f.lines) for (const i of poly) {
        if (i < 0 || seen.has(i)) continue;
        seen.add(i);
        const s = this.data.stars[i];
        const v: Vec3 = [s[0] + s[3] * k - camera[0], s[1] + s[4] * k - camera[1], s[2] + s[5] * k - camera[2]];
        const d = Math.hypot(v[0], v[1], v[2]);
        for (let a = 0; a < 3; a++) sum[a] += v[a] / d;
      }
      const d = Math.hypot(sum[0], sum[1], sum[2]);
      return { name: f.name, dir: [sum[0] / d, sum[1] / d, sum[2] / d] };
    });
  }
}
