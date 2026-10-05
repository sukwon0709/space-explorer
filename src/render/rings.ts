import * as THREE from 'three';
import { RINGS } from '../core/bodies';
import type { BodyFrame } from './planets';
import { toBody } from './planets';
import { SHADOW_GLSL } from './shadow';

/**
 * Planetary rings as a flat disc in the planet's equator plane, coloured by single
 * scattering in a layer of normal optical depth tau (Chandrasekhar; Cuzzi et al. 1984):
 *
 *   lit face:    I/F = w mu0 / (mu0 + mu) (1 - exp(-tau (1/mu0 + 1/mu)))
 *   unlit face:  I/F = w mu0 / (mu - mu0) (exp(-tau/mu) - exp(-tau/mu0))
 *
 * with mu, mu0 the cosines of the viewing and Sun elevations above the ring plane and
 * w = particle albedo x phase function / 4. Opacity is 1 - exp(-tau/mu), so the planet
 * shows through the thin C ring and the Cassini Division and not through the B ring.
 * The planet's shadow falls across the rings as the same disc-overlap eclipse used for
 * moons.
 */

const SAMPLES = 8192;

export interface RingProfile {
  inner: number;
  outer: number;
  tau: Float32Array;
}

/**
 * Optical depth sampled across a ring system: Saturn's measured profile where the
 * occultation covers it, and the listed bands elsewhere. Rings narrower than a sample
 * keep their equivalent depth (tau x width), so they stay visible without growing.
 */
export function ringProfile(planet: number, measured?: { inner_km: number; outer_km: number; tau: number[] }): RingProfile {
  const bands = RINGS[planet].bands;
  const inner = Math.min(...bands.map((b) => b.inner), measured?.inner_km ?? Infinity);
  const outer = Math.max(...bands.map((b) => b.outer), measured?.outer_km ?? -Infinity);
  const step = (outer - inner) / SAMPLES;
  const tau = new Float32Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) {
    const r0 = inner + i * step, r1 = r0 + step, r = r0 + step / 2;
    if (measured && r >= measured.inner_km && r < measured.outer_km) {
      const n = measured.tau.length;
      const x = ((r - measured.inner_km) / (measured.outer_km - measured.inner_km)) * n - 0.5;
      const k = Math.max(0, Math.min(n - 2, Math.floor(x)));
      const f = Math.min(1, Math.max(0, x - k));
      tau[i] = measured.tau[k] * (1 - f) + measured.tau[k + 1] * f;
      continue;
    }
    let sum = 0;
    for (const b of bands) sum += b.tau * Math.max(0, Math.min(r1, b.outer) - Math.max(r0, b.inner));
    tau[i] = sum / step;
  }
  return { inner, outer, tau };
}

/**
 * Optical depth as a half-float texture with hand-made mip levels that average
 * transmission (not tau), so rings seen from afar keep their true overall opacity and
 * fine structure does not shimmer.
 */
export function tauTexture(profile: RingProfile): THREE.DataTexture {
  const levels: Float32Array[] = [profile.tau.map((t) => Math.exp(-t))];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next = new Float32Array(Math.max(1, prev.length >> 1));
    for (let i = 0; i < next.length; i++) next[i] = (prev[2 * i] + prev[Math.min(prev.length - 1, 2 * i + 1)]) / 2;
    levels.push(next);
  }
  const toTau = (trans: Float32Array) => {
    const data = new Uint16Array(trans.length);
    for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(Math.min(-Math.log(Math.max(trans[i], 1e-6)), 60000));
    return data;
  };
  const texture = new THREE.DataTexture(toTau(levels[0]), levels[0].length, 1, THREE.RedFormat, THREE.HalfFloatType);
  texture.mipmaps = levels.map((l) => ({ data: toTau(l), width: l.length, height: 1 })) as unknown as typeof texture.mipmaps;
  texture.generateMipmaps = false;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

const vertexShader = /* glsl */ `
varying vec3 vBody;
varying vec3 vRel;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vBody = position;
  vRel = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uTau;
uniform vec2 uRange;
uniform mat3 uSceneToBody;
uniform vec3 uSunDir;
uniform vec3 uSunPos;
uniform float uSunRadius;
uniform vec3 uPlanetRadii;
uniform vec3 uColor;
uniform float uAlbedo;
uniform float uIntensity;
varying vec3 vBody;
varying vec3 vRel;
#include <common>
#include <logdepthbuf_pars_fragment>
${SHADOW_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vBody.xy);
  if (r < uRange.x || r > uRange.y) discard;
  float tau = texture2D(uTau, vec2((r - uRange.x) / (uRange.y - uRange.x), 0.5)).r;
  vec3 v = normalize(uSceneToBody * vRel);
  float mu = max(abs(v.z), 1e-3);
  float mu0 = abs(uSunDir.z);
  float alpha = 1.0 - exp(-tau / mu);
  if (alpha < 1e-5) discard;
  // Phase: ring particles scatter mostly back toward the Sun.
  float cosPhase = dot(-v, uSunDir);
  float w = uAlbedo * (0.6 + 0.4 * cosPhase);
  float iof;
  bool litFace = (-v.z) * uSunDir.z > 0.0;
  if (mu0 < 1e-4) iof = 0.0;
  else if (litFace) iof = w * mu0 / (mu0 + mu) * (1.0 - exp(-tau * (1.0 / mu0 + 1.0 / mu)));
  else if (abs(mu - mu0) < 1e-3) iof = w * tau / mu * exp(-tau / mu);
  else iof = w * mu0 / (mu - mu0) * (exp(-tau / mu) - exp(-tau / mu0));
  // The planet's shadow: an oblate planet becomes a sphere with z scaled by a/c.
  float k = uPlanetRadii.x / uPlanetRadii.z;
  float sun = occlusion(vBody, vec3(uSunPos.xy, uSunPos.z * k), uSunRadius, vec4(0.0, 0.0, 0.0, uPlanetRadii.x));
  vec3 color = uColor * max(iof, 0.0) * sun * uIntensity;
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class RingView {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly tau: THREE.DataTexture;
  private readonly m4 = new THREE.Matrix4();

  constructor(readonly planet: number, readonly radii: [number, number, number], readonly profile: RingProfile) {
    const rings = RINGS[planet];
    this.tau = tauTexture(profile);
    const c = new THREE.Color(rings.color);
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTau: { value: this.tau },
        uRange: { value: new THREE.Vector2(profile.inner, profile.outer) },
        uSceneToBody: { value: new THREE.Matrix3() },
        uSunDir: { value: new THREE.Vector3() },
        uSunPos: { value: new THREE.Vector3() },
        uSunRadius: { value: 695700 },
        uPlanetRadii: { value: new THREE.Vector3(...radii) },
        uColor: { value: new THREE.Vector3(c.r / lum, c.g / lum, c.b / lum) },
        uAlbedo: { value: rings.albedo },
        uIntensity: { value: 7 },
      },
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    // A disc in the body frame's xy plane (the equator); the mesh is rotated with the planet.
    this.mesh = new THREE.Mesh(new THREE.RingGeometry(profile.inner, profile.outer, 720, 8), this.material);
    this.mesh.renderOrder = 2;
    this.mesh.name = `rings-${planet}`;
  }

  update(f: BodyFrame): void {
    const b = f.bodyToScene;
    this.m4.set(b[0], b[1], b[2], 0, b[3], b[4], b[5], 0, b[6], b[7], b[8], 0, 0, 0, 0, 1);
    this.mesh.quaternion.setFromRotationMatrix(this.m4);
    this.mesh.position.set(f.centerRel[0], f.centerRel[1], f.centerRel[2]);
    const u = this.material.uniforms;
    u.uSceneToBody.value.set(b[0], b[3], b[6], b[1], b[4], b[7], b[2], b[5], b[8]);
    const sun = toBody(b, f.sunRel);
    const d = Math.hypot(sun[0], sun[1], sun[2]);
    u.uSunPos.value.set(sun[0], sun[1], sun[2]);
    u.uSunDir.value.set(sun[0] / d, sun[1] / d, sun[2] / d);
    u.uSunRadius.value = f.sunRadius;
    u.uIntensity.value = f.intensity;
  }
}
