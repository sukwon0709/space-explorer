import * as THREE from 'three';
import type { Body } from '../core/bodies';
import type { Vec3 } from '../core/ephemeris';
import type { Mat3 } from '../core/orientation';
import { SHADOW_GLSL } from './shadow';
import { latLonSphere } from './sky';

/**
 * Planets, moons and asteroids drawn as textured triaxial ellipsoids, rotating by their
 * IAU models. Everything a fragment needs is in the body-fixed frame (z = north pole,
 * x = prime meridian), in km from the body's centre, so float32 holds it to well under
 * a pixel: the Sun's position, up to four other bodies that can eclipse this one, and
 * the ring plane (the planet's equator) for ring shadows.
 */

export const MAX_OCCLUDERS = 4;

const vertexShader = /* glsl */ `
uniform vec3 uRadii;
varying vec3 vBody;
varying vec3 vRel;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vBody = position * uRadii;
  vRel = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

/** Planetocentric equirectangular lookup (east longitude, -180 at u = 0), seam-free. */
export const MAP_GLSL = /* glsl */ `
vec3 sampleMap(sampler2D map, vec3 p) {
  float u = atan(p.y, p.x) / (2.0 * PI) + 0.5;
  float v = asin(clamp(p.z / length(p), -1.0, 1.0)) / PI + 0.5;
  // Derivatives of u jump by 1 across the 180th meridian; take those of u shifted half a
  // turn there, so the mip level stays right and no seam line appears.
  vec2 dx = vec2(dFdx(u), dFdx(v)), dy = vec2(dFdy(u), dFdy(v));
  float u2 = fract(u + 0.5);
  float dx2 = dFdx(u2), dy2 = dFdy(u2);
  if (abs(dx2) < abs(dx.x)) dx.x = dx2;
  if (abs(dy2) < abs(dy.x)) dy.x = dy2;
  return textureGrad(map, vec2(u, v), dx, dy).rgb;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uAlbedo;
uniform vec3 uRadii;
uniform mat3 uSceneToBody;
uniform vec3 uSunDir;
uniform vec3 uSunPos;
uniform float uSunRadius;
uniform vec4 uOccluders[${MAX_OCCLUDERS}];
uniform float uIntensity;
uniform int uShading;
uniform sampler2D uRingTau;
uniform vec3 uRing;
varying vec3 vBody;
varying vec3 vRel;
#include <common>
#include <logdepthbuf_pars_fragment>
${SHADOW_GLSL}
${MAP_GLSL}

void main() {
  #include <logdepthbuf_fragment>
  vec3 p = vBody;
  vec3 n = normalize(p / (uRadii * uRadii));
  vec3 viewDir = normalize(uSceneToBody * vRel);
  float mu0 = dot(n, uSunDir);
  float mu = max(dot(n, -viewDir), 1e-3);
  vec3 albedo = pow(sampleMap(uMap, p), vec3(2.2)) * uAlbedo;

  float light;
  if (uShading == 2) {
    // Cloud decks: Minnaert's law, I ~ mu0^k mu^(k-1); k = 0.9 darkens the limb as on
    // Jupiter and Saturn.
    light = pow(max(mu0, 0.0), 0.9) * pow(mu, -0.1);
  } else {
    // Regolith: Lommel-Seeliger (flat, bright limb) mixed with Lambert, more of the
    // former for dark rocky surfaces, more of the latter for bright icy ones.
    float lambert = max(mu0, 0.0);
    float ls = 2.0 * lambert / (lambert + mu + 1e-4);
    light = mix(lambert, 0.5 * ls, uShading == 0 ? 0.7 : 0.4);
  }

  float sun = 1.0;
  if (mu0 > -0.05) {
    for (int i = 0; i < ${MAX_OCCLUDERS}; i++) {
      if (uOccluders[i].w > 0.0) sun *= occlusion(p, uSunPos, uSunRadius, uOccluders[i]);
    }
    // Ring shadow: follow the ray toward the Sun to the equator plane, and dim by the
    // ring's slant optical depth there.
    if (uRing.z > 0.0 && abs(uSunDir.z) > 1e-4) {
      float t = -p.z / uSunDir.z;
      if (t > 0.0) {
        float r = length(p.xy + uSunDir.xy * t);
        if (r > uRing.x && r < uRing.y) {
          float tau = texture2D(uRingTau, vec2((r - uRing.x) / (uRing.y - uRing.x), 0.5)).r;
          sun *= exp(-tau / abs(uSunDir.z));
        }
      }
    }
  }
  vec3 color = albedo * (light * sun + 0.0015) * uIntensity;
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface BodyFrame {
  /** Body centre minus camera, scene axes, km (float64). */
  centerRel: Vec3;
  /** Body-fixed -> scene rotation, row-major. */
  bodyToScene: Mat3;
  /** Sun position relative to the body centre, scene axes, km. */
  sunRel: Vec3;
  sunRadius: number;
  /** Bodies that may eclipse this one: centre relative to this body (scene axes) and radius. */
  occluders: Array<{ rel: Vec3; radius: number }>;
  /** Exposure-scaled brightness of sunlight at this body. */
  intensity: number;
}

const toBody = (b: Mat3, v: Vec3): Vec3 => [
  b[0] * v[0] + b[3] * v[1] + b[6] * v[2],
  b[1] * v[0] + b[4] * v[1] + b[7] * v[2],
  b[2] * v[0] + b[5] * v[1] + b[8] * v[2],
];

const sphere = latLonSphere(192, 96);
const BLANK_TAU = new THREE.DataTexture(new Float32Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
BLANK_TAU.needsUpdate = true;

export class PlanetGlobe {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly quaternion = new THREE.Quaternion();
  private readonly m4 = new THREE.Matrix4();

  constructor(
    readonly body: Body,
    map?: THREE.Texture,
    /** Mean linear colour of the map, so its brightness can be set to the body's albedo. */
    mapMean?: Vec3,
  ) {
    const albedo = albedoScale(body, map ? mapMean : undefined);
    const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    blank.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uMap: { value: map ?? blank },
        uAlbedo: { value: new THREE.Vector3(...albedo) },
        uRadii: { value: new THREE.Vector3(...body.radii) },
        uSceneToBody: { value: new THREE.Matrix3() },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uSunPos: { value: new THREE.Vector3() },
        uSunRadius: { value: 695700 },
        uOccluders: { value: Array.from({ length: MAX_OCCLUDERS }, () => new THREE.Vector4()) },
        uIntensity: { value: 7 },
        uShading: { value: body.shading === 'rocky' ? 0 : body.shading === 'icy' ? 1 : 2 },
        uRingTau: { value: BLANK_TAU },
        uRing: { value: new THREE.Vector3() },
      },
    });
    this.mesh = new THREE.Mesh(sphere, this.material);
    this.mesh.scale.set(...body.radii);
    this.mesh.name = body.name;
  }

  /** Swap in a global map once it has loaded. */
  setMap(map: THREE.Texture, mean: Vec3): void {
    this.material.uniforms.uMap.value = map;
    this.material.uniforms.uAlbedo.value.set(...albedoScale(this.body, mean));
  }

  /** Let this globe show a ring system's shadow (tau texture over inner..outer km). */
  setRingShadow(tau: THREE.Texture, inner: number, outer: number): void {
    this.material.uniforms.uRingTau.value = tau;
    this.material.uniforms.uRing.value.set(inner, outer, 1);
  }

  update(f: BodyFrame): void {
    const b = f.bodyToScene;
    this.m4.set(b[0], b[1], b[2], 0, b[3], b[4], b[5], 0, b[6], b[7], b[8], 0, 0, 0, 0, 1);
    this.quaternion.setFromRotationMatrix(this.m4);
    this.mesh.quaternion.copy(this.quaternion);
    this.mesh.position.set(f.centerRel[0], f.centerRel[1], f.centerRel[2]);
    const u = this.material.uniforms;
    u.uSceneToBody.value.set(b[0], b[3], b[6], b[1], b[4], b[7], b[2], b[5], b[8]);
    const sun = toBody(b, f.sunRel);
    const d = Math.hypot(sun[0], sun[1], sun[2]);
    u.uSunPos.value.set(sun[0], sun[1], sun[2]);
    u.uSunDir.value.set(sun[0] / d, sun[1] / d, sun[2] / d);
    u.uSunRadius.value = f.sunRadius;
    u.uIntensity.value = f.intensity;
    const occ = u.uOccluders.value as THREE.Vector4[];
    for (let i = 0; i < MAX_OCCLUDERS; i++) {
      const o = f.occluders[i];
      if (!o) {
        occ[i].set(0, 0, 0, 0);
        continue;
      }
      const r = toBody(b, o.rel);
      occ[i].set(r[0], r[1], r[2], o.radius);
    }
  }
}

/**
 * Per-channel factors taking map (or colour) values to linear albedo: the map's mean
 * becomes the body's colour at its geometric albedo, so maps from different missions
 * and filters are colour-balanced alike while keeping their detail.
 */
export function albedoScale(body: Body, mapMean: Vec3 | undefined): Vec3 {
  const lum = (c: Vec3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const c = new THREE.Color(body.color); // sRGB hex -> linear
  const rgb: Vec3 = [c.r, c.g, c.b];
  const k = body.albedo / Math.max(lum(rgb), 1e-3);
  const mean = mapMean ?? [1, 1, 1];
  return [(rgb[0] * k) / Math.max(mean[0], 1e-3), (rgb[1] * k) / Math.max(mean[1], 1e-3), (rgb[2] * k) / Math.max(mean[2], 1e-3)];
}

export { toBody };
