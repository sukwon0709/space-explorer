import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import type { PlanetInfo, PlanetKind } from '../core/systems';
import { SUN_SURFACE_BRIGHTNESS } from './sun';
import { latLonSphere } from './sky';

/**
 * An exoplanet up close. Nobody has seen one as more than a point, so its look is an
 * estimate from what is measured: size, mass (so density) and temperature decide the
 * kind of world (core/systems.ts planetKind), the kind decides a palette and a pattern,
 * and the pattern is generated from the planet's name so it stays the same. Light and
 * heat are physical: sunlight from its star (or both stars of a binary) in the same
 * units as the solar system's planets, and thermal glow from a blackbody at the local
 * temperature, which only shows on the hottest worlds.
 */

const KIND_CODE: Record<PlanetKind, number> = {
  'gas giant': 0, 'ice giant': 1, 'sub-Neptune': 2, 'lava world': 3, 'hot rock': 4, 'temperate rock': 5, 'ice world': 6,
};

type Rgb = [number, number, number];

/** Palette (two base colours and an accent) for a kind and temperature. */
export function palette(kind: PlanetKind, teq: number): [Rgb, Rgb, Rgb] {
  switch (kind) {
    case 'gas giant':
      // Sudarsky et al. (2000) classes: ammonia clouds, water clouds, clear, alkali metals, silicate clouds.
      if (teq < 150) return [[0.80, 0.70, 0.55], [0.62, 0.45, 0.32], [0.75, 0.40, 0.28]];
      if (teq < 350) return [[0.92, 0.92, 0.90], [0.80, 0.83, 0.88], [0.70, 0.76, 0.86]];
      if (teq < 800) return [[0.30, 0.48, 0.85], [0.20, 0.35, 0.70], [0.45, 0.62, 0.92]];
      if (teq < 1400) return [[0.12, 0.18, 0.38], [0.08, 0.11, 0.26], [0.20, 0.26, 0.46]];
      return [[0.55, 0.50, 0.45], [0.40, 0.33, 0.30], [0.66, 0.56, 0.46]];
    case 'ice giant':
      return teq < 300 ? [[0.55, 0.78, 0.88], [0.45, 0.65, 0.85], [0.35, 0.50, 0.80]] : [[0.75, 0.75, 0.68], [0.62, 0.62, 0.58], [0.82, 0.80, 0.70]];
    case 'sub-Neptune':
      return teq < 350 ? [[0.70, 0.82, 0.88], [0.60, 0.72, 0.82], [0.80, 0.88, 0.92]] : [[0.82, 0.78, 0.66], [0.70, 0.66, 0.56], [0.88, 0.84, 0.72]];
    case 'lava world':
      return [[0.10, 0.09, 0.08], [0.20, 0.18, 0.16], [0.30, 0.26, 0.22]];
    case 'hot rock':
      return [[0.24, 0.21, 0.19], [0.55, 0.48, 0.40], [0.45, 0.36, 0.30]];
    case 'temperate rock':
      return [[0.28, 0.22, 0.18], [0.62, 0.54, 0.46], [0.90, 0.93, 0.97]];
    case 'ice world':
      return [[0.86, 0.89, 0.93], [0.62, 0.55, 0.50], [0.75, 0.82, 0.90]];
  }
}

const vertexShader = /* glsl */ `
uniform mat3 uSceneToBody;
varying vec3 vBody;
varying vec3 vView;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vBody = uSceneToBody * normalize(mat3(modelMatrix) * position);
  vView = uSceneToBody * world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
  #include <logdepthbuf_vertex>
}
`;

const fragmentShader = /* glsl */ `
uniform int uKind;
uniform float uSeed;
uniform vec3 uP0;
uniform vec3 uP1;
uniform vec3 uP2;
uniform float uAlbedo;
uniform vec3 uLightDir[2];
uniform vec3 uLight[2];
uniform float uThermal;
uniform float uTsub;
uniform float uTeq;
uniform float uLocked;
uniform float uBands;
varying vec3 vBody;
varying vec3 vView;
#include <common>
#include <logdepthbuf_pars_fragment>

float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123); }
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), u.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), u.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
float fbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { s += a * noise(p); p = p * 2.02 + 0.13; a *= 0.5; }
  return s;
}
float ridged(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * (1.0 - abs(2.0 * noise(p) - 1.0)); p = p * 2.07 + 0.31; a *= 0.5; }
  return s;
}
// Impact craters: a dark bowl and a bright rim in some cells of a jittered grid.
float craters(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float s = 0.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 h = vec3(hash(i + g), hash(i + g + 17.0), hash(i + g + 31.0));
    if (hash(i + g + 7.0) < 0.55) continue;
    float r = 0.15 + 0.3 * hash(i + g + 3.0);
    float d = length(g + h - f);
    s += -0.7 * smoothstep(r, 0.2 * r, d) + 0.9 * exp(-pow((d - r) / (0.18 * r), 2.0));
  }
  return s;
}
// Visual brightness of a blackbody at T relative to the Sun's photosphere (550 nm).
float planckV(float t) { return t < 300.0 ? 0.0 : 91.84 / (exp(26152.0 / t) - 1.0); }
vec3 kelvinToRgb(float kelvin) {
  float t = clamp(kelvin, 1000.0, 40000.0) / 100.0;
  float r = t <= 66.0 ? 255.0 : 329.698727446 * pow(t - 60.0, -0.1332047592);
  float g = t <= 66.0 ? 99.4708025861 * log(t) - 161.1195681661 : 288.1221695283 * pow(t - 60.0, -0.0755148492);
  float b = t >= 66.0 ? 255.0 : (t <= 19.0 ? 0.0 : 138.5177312231 * log(t - 10.0) - 305.0447927307);
  vec3 srgb = clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
  vec3 lin = mix(srgb / 12.92, pow((srgb + 0.055) / 1.055, vec3(2.4)), step(0.04045, srgb));
  return lin / dot(lin, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vBody);
  vec3 q = n + vec3(uSeed, uSeed * 0.7, uSeed * 1.3);
  float lat = n.z;
  vec3 c;
  float heat = 1.0; // local temperature relative to the expected one (cracks run hot)
  bool clouds = uKind <= 2;
  if (uKind == 0) {
    // Zonal bands, bent by turbulence, and a long-lived storm.
    float turb = fbm(q * 3.0) - 0.5;
    float b = sin((lat + 0.12 * turb + 0.04 * sin(lat * 40.0 + turb * 6.0)) * uBands);
    c = mix(uP0, uP1, smoothstep(-0.6, 0.6, b));
    c *= 0.9 + 0.2 * fbm(q * 12.0);
    vec3 stormCentre = normalize(vec3(cos(uSeed * 3.1), sin(uSeed * 3.1), -0.35 + 0.2 * sin(uSeed)));
    float storm = smoothstep(0.16, 0.06, length((n - stormCentre) * vec3(1.0, 1.0, 1.9)) + 0.03 * fbm(q * 20.0));
    c = mix(c, uP2, storm * 0.85);
  } else if (uKind == 1 || uKind == 2) {
    float turb = fbm(q * 2.5) - 0.5;
    float b = sin((lat + 0.06 * turb) * uBands);
    c = mix(uP0, uP1, 0.5 + 0.25 * b);
    c = mix(c, uP2, smoothstep(0.62, 0.8, fbm(q * 6.0)) * 0.5);
  } else if (uKind == 6) {
    // An ice shell cracked by tides: bright plains, darker lineae.
    float lines = smoothstep(0.86, 0.97, ridged(q * 4.0));
    c = mix(uP0, uP1, lines * 0.7 + 0.15 * fbm(q * 3.0));
    c = mix(c, uP2, smoothstep(0.55, 0.75, fbm(q * 1.5)) * 0.4);
  } else {
    // Rock: plains of light and dark terrain, mountain ranges, impact craters.
    float h = fbm(q * 2.0);
    float r = ridged(q * 4.5);
    c = mix(uP0, uP1, smoothstep(0.42, 0.58, h + 0.22 * (r - 0.5)));
    c *= 1.0 + 0.3 * (craters(q * 7.0) + 0.6 * craters(q * 21.0) + 0.35 * craters(q * 63.0));
    c *= 0.7 + 0.6 * fbm(q * 30.0);
    if (uKind == 5) {
      // Ice where it is coldest: the poles, or the night side of a world that keeps one
      // face to its star.
      float cold = uLocked > 0.5 ? -dot(n, vec3(1.0, 0.0, 0.0)) : abs(lat);
      float cap = smoothstep(uLocked > 0.5 ? 0.15 : 0.72, uLocked > 0.5 ? 0.35 : 0.85, cold + 0.12 * (fbm(q * 4.0) - 0.5));
      c = mix(c, uP2, cap);
    }
    if (uKind == 3) heat = 1.0 + 0.6 * smoothstep(0.82, 0.95, ridged(q * 6.0));
  }
  vec3 albedo = c / max(dot(0.5 * (uP0 + uP1), vec3(0.2126, 0.7152, 0.0722)), 1e-3) * uAlbedo;

  vec3 viewDir = normalize(vView);
  float mu = max(dot(n, -viewDir), 1e-3);
  vec3 light = vec3(0.0);
  float day = 0.0;
  for (int i = 0; i < 2; i++) {
    float mu0 = dot(n, uLightDir[i]);
    float l;
    if (clouds) l = pow(max(mu0, 0.0), 0.9) * pow(mu, -0.1);
    else {
      float lambert = max(mu0, 0.0);
      l = mix(lambert, lambert / (lambert + mu + 1e-4), 0.6);
    }
    light += uLight[i] * l;
    day = max(day, mu0);
  }
  vec3 color = albedo * (light + 0.0015 * (uLight[0] + uLight[1]));
  if (clouds) {
    // Haze brightens the lit limb.
    color += uP0 * uAlbedo * pow(1.0 - mu, 3.0) * 0.35 * max(day, 0.0) * (uLight[0] + uLight[1]);
  }

  // Heat: the substellar point at sqrt(2) T_eq on a world that keeps one face to its
  // star and has no air to carry heat around, evened out on gas planets.
  float mu0 = max(dot(n, uLightDir[0]), 0.0);
  float t;
  if (clouds) t = uTeq * (0.8 + 0.4 * mu0);
  else if (uLocked > 0.5) t = max(uTsub * pow(mu0, 0.25), 0.35 * uTeq);
  else t = uTeq * (0.9 + 0.2 * mu0);
  t *= heat;
  color += kelvinToRgb(t) * planckV(t) * uThermal;

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface PlanetLight {
  /** Unit vector from the planet toward the star, scene axes. */
  dir: Vec3;
  /** Exposure-scaled brightness of its light here (as SolarSystem.intensity). */
  intensity: number;
  color: THREE.Color;
}

const sphere = latLonSphere(160, 80);

export class ExoplanetGlobe {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private name = '';

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uKind: { value: 0 },
        uSeed: { value: 0 },
        uP0: { value: new THREE.Vector3() },
        uP1: { value: new THREE.Vector3() },
        uP2: { value: new THREE.Vector3() },
        uAlbedo: { value: 0.3 },
        uLightDir: { value: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 0)] },
        uLight: { value: [new THREE.Vector3(), new THREE.Vector3()] },
        uThermal: { value: 0 },
        uTsub: { value: 0 },
        uTeq: { value: 0 },
        uLocked: { value: 0 },
        uBands: { value: 30 },
        uSceneToBody: { value: new THREE.Matrix3() },
      },
    });
    this.mesh = new THREE.Mesh(sphere, this.material);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  /**
   * @param rel planet centre minus camera, scene axes, km.
   * @param bodyToScene the planet's body frame (row-major): x toward the star on a
   *   locked world, z its pole.
   * @param exposure the scene's exposure this frame (for the thermal glow).
   */
  update(info: PlanetInfo, seed: number, rel: Vec3, bodyToScene: Float64Array, lights: PlanetLight[], exposure: number): void {
    const u = this.material.uniforms;
    if (info.name !== this.name) {
      this.name = info.name;
      const [p0, p1, p2] = palette(info.kind, info.teq);
      u.uKind.value = KIND_CODE[info.kind];
      u.uP0.value.set(...p0);
      u.uP1.value.set(...p1);
      u.uP2.value.set(...p2);
      u.uSeed.value = (seed % 997) * 0.0137;
      u.uAlbedo.value = info.albedo;
      u.uTeq.value = info.teq;
      u.uTsub.value = info.teq * Math.SQRT2;
      u.uLocked.value = info.locked ? 1 : 0;
      // Fewer, broader bands on slow rotators (locked hot Jupiters), more on fast ones.
      u.uBands.value = info.locked ? 9 + (seed % 5) : 24 + (seed % 14);
    }
    this.mesh.visible = true;
    this.mesh.position.set(rel[0], rel[1], rel[2]);
    this.mesh.scale.setScalar(info.radius * 6371.0);
    const b = bodyToScene;
    const toBody = (v: Vec3, out: THREE.Vector3) => out.set(
      b[0] * v[0] + b[3] * v[1] + b[6] * v[2],
      b[1] * v[0] + b[4] * v[1] + b[7] * v[2],
      b[2] * v[0] + b[5] * v[1] + b[8] * v[2],
    );
    u.uSceneToBody.value.set(b[0], b[3], b[6], b[1], b[4], b[7], b[2], b[5], b[8]);
    for (let i = 0; i < 2; i++) {
      const l = lights[i];
      if (!l) {
        u.uLight.value[i].set(0, 0, 0);
        continue;
      }
      toBody(l.dir, u.uLightDir.value[i]);
      u.uLight.value[i].set(l.color.r, l.color.g, l.color.b).multiplyScalar(l.intensity);
    }
    u.uThermal.value = 7 * SUN_SURFACE_BRIGHTNESS * exposure;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}
