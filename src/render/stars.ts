import * as THREE from 'three';
import { icrfToScene, raDecToIcrf } from '../core/frames';
import type { Vec3 } from '../core/ephemeris';

/** B-V colour index to effective temperature (Ballesteros 2012). */
export function bvToKelvin(bv: number): number {
  return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
}

/** Blackbody temperature to linear RGB, normalised so the brightest channel is 1 (Planck fit, 1,000–40,000 K). */
export function kelvinToRgb(kelvin: number): [number, number, number] {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const srgb = [r, g, b].map((c) => Math.min(255, Math.max(0, c)) / 255);
  const linear = srgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  const max = Math.max(...linear);
  return [linear[0] / max, linear[1] / max, linear[2] / max];
}

/**
 * Background stars from XHIP (Hipparcos). Stars are drawn as directions at infinity,
 * which is exact to well under an arcsecond anywhere inside the Solar System;
 * parallax arrives with the Gaia catalogue in milestone 4.
 */
export function createStarField(buffer: ArrayBuffer): THREE.Points {
  const view = new DataView(buffer);
  const count = view.getUint32(0, true);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const dir: Vec3 = [0, 0, 0];
  const scene: Vec3 = [0, 0, 0];

  for (let i = 0; i < count; i++) {
    const at = 4 + i * 16;
    const ra = view.getFloat32(at, true);
    const dec = view.getFloat32(at + 4, true);
    const mag = view.getFloat32(at + 8, true);
    const bv = view.getFloat32(at + 12, true);
    icrfToScene(raDecToIcrf(ra, dec, dir), scene);
    positions.set(scene, i * 3);
    // Relative flux against a magnitude 6.5 star (naked-eye limit under dark skies).
    const flux = Math.pow(10, -0.4 * (mag - 6.5));
    const rgb = kelvinToRgb(bvToKelvin(Number.isNaN(bv) ? 0.65 : bv));
    const brightness = Math.min(1, flux);
    colors.set([rgb[0] * brightness, rgb[1] * brightness, rgb[2] * brightness], i * 3);
    // Bright stars grow a little instead of saturating, like a photograph's bloom.
    sizes[i] = 1.6 + Math.sqrt(Math.max(0, flux - 1)) * 0.9;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: { pixelRatio: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float size;
      varying vec3 vColor;
      uniform float pixelRatio;
      void main() {
        vColor = color;
        // Directions only: strip translation so stars sit at infinity.
        vec4 view = modelViewMatrix * vec4(position, 0.0);
        gl_Position = projectionMatrix * vec4(view.xyz, 1.0);
        gl_Position.z = gl_Position.w * 0.999999; // far plane
        gl_PointSize = min(size, 7.0) * pixelRatio;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = exp(-d * d * 4.0);
        if (a < 0.02) discard;
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    // Opaque pass + lowest render order: stars draw first and every body paints over them.
    transparent: false,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -10;
  return points;
}
