import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import type { GlobeFrame } from './globe';
import { latLonSphere } from './sky';

/**
 * Atmospheres too thick to see the ground through from space: Venus under its clouds,
 * Titan under its haze. Sunlight reaches their ground only after being scattered many
 * times, so it arrives from the whole sky at once: the ground is lit like an overcast
 * day, and the sky is the same colour everywhere. The light there is measured (Venera
 * and Pioneer Venus probes; Huygens), and what the eye sees in between is computed:
 *
 * - Diffuse light at height h. At the ground, a flux that follows the two-stream escape
 *   function of a thick conservative cloud, F = K mu0 (1 + 2 mu0) per channel (mu0: the
 *   cosine of the Sun's zenith angle), with K set from the probes. At the top of the
 *   deck, the sunlit cloud tops. In between, the light changes geometrically with the
 *   optical depth above h.
 * - The direct sunbeam, dimmed by exp(-tau above / mu0): nothing under Venus's clouds
 *   (tau about 30), soft shadows on Titan in red light.
 * - Extinction along any line of sight: the gas (Rayleigh, from density at the ground and
 *   its scale height), haze, and Venus's cloud deck. Light scattered into the line of
 *   sight is the diffuse light there, plus the direct beam scattered forward by haze.
 *
 * Units are those of globe.ts: the Sun's irradiance above the atmosphere is 1, and a
 * surface of albedo A under irradiance E has radiance A E.
 */
export interface ThickAirParams {
  /** Reference radius (km) heights are measured from. */
  radius: number;
  /** Top of the deck (km): above it the planet's cloud globe is drawn instead of terrain. */
  top: number;
  /** K of the ground's diffuse flux K mu0 (1 + 2 mu0), per channel. */
  ground: Vec3;
  /** Radiance of the deck's top per unit mu0. */
  topLight: Vec3;
  /** Gas extinction at the ground, km^-1, and its scale height, km. */
  gas: Vec3;
  gasHeight: number;
  /** Haze extinction at the ground, km^-1, and its scale height, km. */
  haze: Vec3;
  hazeHeight: number;
  /** A cloud deck between two heights (km) with this extinction (km^-1). */
  deck: [number, number];
  deckExtinction: Vec3;
  /** Forward-scattering asymmetry of haze and cloud particles. */
  g: number;
}

/**
 * Venus. Gas: CO2 at 92 bar and 737 K has 36 times the molecules of sea-level air and
 * each scatters 2.45 times as strongly, so Rayleigh extinction at the ground is about
 * 1 km^-1 in green (0.63 red, 2.1 blue): the far ground fades within a few km. Density
 * scale height near the ground 15.9 km. Deck: the main clouds from 48 to 70 km, optical
 * depth about 30 (Pioneer Venus nephelometer, Ragent et al. 1985). Light at the ground:
 * about 4% of the sunlight above the clouds with the Sun overhead, 17 W/m^2 averaged over
 * the planet (Tomasko et al. 1980), reddened (Venera 11-14 spectrophotometers, Ekonomov
 * et al. 1983: little light below 500 nm).
 */
export const VENUS_AIR: ThickAirParams = {
  radius: 6051.0,
  top: 70,
  ground: [0.0202, 0.0121, 0.0050],
  topLight: [0.8, 0.77, 0.66],
  gas: [0.63, 1.02, 2.1],
  gasHeight: 15.9,
  haze: [0, 0, 0],
  hazeHeight: 10,
  deck: [48, 70],
  deckExtinction: [1.36, 1.36, 1.36],
  g: 0.75,
};

/**
 * Titan. Gas: N2 at 1.47 bar and 94 K, 4.4 times the molecules of sea-level air, scale
 * height 20.6 km. Haze: vertical optical depth about 2.7 (red) to 3.5 (blue) above the
 * gas's, scale height 65 km, strongly forward scattering (Tomasko et al. 2008, Huygens
 * DISR). Light at the ground: about a tenth of the sunlight above the haze with the Sun
 * overhead, orange (Tomasko et al. 2005: the haze absorbs blue).
 */
export const TITAN_AIR: ThickAirParams = {
  radius: 2575.0,
  top: 300,
  ground: [0.0614, 0.0276, 0.0074],
  topLight: [0.45, 0.3, 0.15],
  gas: [0.0255, 0.06, 0.146],
  gasHeight: 20.6,
  haze: [0.042, 0.05, 0.054],
  hazeHeight: 65,
  deck: [0, 0],
  deckExtinction: [0, 0, 0],
  g: 0.65,
};

const v3 = (v: Vec3) => `vec3(${v.map((x) => x.toExponential(4)).join(', ')})`;

/** GLSL for one thick atmosphere: light at a height, and scattering along a ray. */
export function thickAirGlsl(a: ThickAirParams): string {
  return /* glsl */ `
const float TA_R = ${a.radius.toFixed(3)};
const float TA_TOP = ${a.top.toFixed(2)};
const vec3 TA_GROUND = ${v3(a.ground)};
const vec3 TA_TOPLIGHT = ${v3(a.topLight)};
const vec3 TA_GAS = ${v3(a.gas)};
const float TA_GAS_H = ${a.gasHeight.toFixed(2)};
const vec3 TA_HAZE = ${v3(a.haze)};
const float TA_HAZE_H = ${a.hazeHeight.toFixed(2)};
const vec2 TA_DECK = vec2(${a.deck[0].toFixed(2)}, ${a.deck[1].toFixed(2)});
const vec3 TA_DECK_E = ${v3(a.deckExtinction)};
const float TA_G = ${a.g.toFixed(3)};

// Extinction at height h (km^-1): gas, and particles (haze and cloud) on their own.
vec3 taParticles(float h) {
  return TA_HAZE * exp(-max(h, 0.0) / TA_HAZE_H) + TA_DECK_E * step(TA_DECK.x, h) * step(h, TA_DECK.y);
}
vec3 taExtinction(float h) {
  return TA_GAS * exp(-max(h, 0.0) / TA_GAS_H) + taParticles(h);
}
// Vertical optical depth above height h.
vec3 taAbove(float h) {
  h = max(h, 0.0);
  vec3 deck = TA_DECK_E * max(TA_DECK.y - max(h, TA_DECK.x), 0.0);
  return TA_GAS * TA_GAS_H * exp(-h / TA_GAS_H) + TA_HAZE * TA_HAZE_H * exp(-h / TA_HAZE_H) + deck;
}
float taLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Diffuse light (irradiance on a level surface, = radiance of the sky) at height h.
vec3 taDiffuse(float h, float mu0) {
  float m = clamp((mu0 + 0.12) / 1.12, 0.0, 1.0); // light lingers past sunset under a deep atmosphere
  vec3 ground = TA_GROUND * m * (1.0 + 2.0 * m);
  vec3 top = TA_TOPLIGHT * m;
  float f = clamp(taLum(taAbove(h)) / taLum(taAbove(0.0)), 0.0, 1.0);
  return exp(f * log(ground + 1e-7) + (1.0 - f) * log(top + 1e-7));
}
// The direct sunbeam at height h.
vec3 taDirect(float h, float mu0) {
  if (mu0 <= 0.0) return vec3(0.0);
  return exp(-taAbove(h) / max(mu0, 0.03));
}
float taPhase(float mu) {
  float g2 = TA_G * TA_G;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * TA_G * mu, 1.5));
}

// Light scattered toward the camera between ro + rd*t0 and ro + rd*t1 (body frame, km
// from the centre), and the transmittance over it.
void taScatter(vec3 ro, vec3 rd, float t0, float t1, vec3 sun, out vec3 inscatter, out vec3 transmittance) {
  const int N = 16;
  inscatter = vec3(0.0);
  vec3 depth = vec3(0.0);
  float mu = dot(rd, sun);
  // Steps grow along the ray: fine near the camera, where the air is densest.
  float span = t1 - t0;
  float prev = 0.0;
  for (int i = 1; i <= N; i++) {
    float s = float(i) / float(N);
    s = s * s;
    float t = t0 + span * (prev + s) * 0.5;
    float dt = span * (s - prev);
    prev = s;
    vec3 p = ro + rd * t;
    float r = length(p);
    float h = r - TA_R;
    float mu0 = dot(p, sun) / r;
    vec3 e = taExtinction(h);
    vec3 tr = exp(-depth); // light from this step is dimmed by the air before it
    vec3 source = taDiffuse(h, mu0) + taParticles(h) / max(e, vec3(1e-6)) * taDirect(h, mu0) * taPhase(mu) * PI;
    inscatter += tr * (1.0 - exp(-e * dt)) * source;
    depth += e * dt;
  }
  transmittance = exp(-depth);
}

// Distances along a ray to a sphere of radius r about the centre; (-1, -1) if missed.
vec2 taSphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}
`;
}

const shellVertex = /* glsl */ `
varying vec3 vRel;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vRel = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const skyFragment = (air: string) => /* glsl */ `
uniform vec3 uSun;
uniform mat3 uSceneToBody;
uniform vec3 uCamBody;
uniform float uSunIntensity;
varying vec3 vRel;
#include <common>
#include <logdepthbuf_pars_fragment>
${air}
void main() {
  #include <logdepthbuf_fragment>
  vec3 cam = uCamBody;
  vec3 rd = normalize(uSceneToBody * vRel);
  vec2 top = taSphere(cam, rd, TA_R + TA_TOP);
  if (top.y <= 0.0) discard;
  float t0 = max(top.x, 0.0);
  float t1 = top.y;
  // Below the horizon the terrain is drawn; the sky behind it ends at the ground.
  vec2 ground = taSphere(cam, rd, TA_R - 3.0);
  if (ground.x > 0.0) t1 = ground.x;
  vec3 inscatter, transmittance;
  taScatter(cam, rd, t0, t1, uSun, inscatter, transmittance);
  gl_FragColor = vec4(inscatter * uSunIntensity, taLum(transmittance));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** The sky of a thick atmosphere, seen from inside it. */
export class ThickSky {
  readonly group = new THREE.Group();
  private readonly shell: THREE.Mesh;
  private readonly quaternion = new THREE.Quaternion();

  constructor(
    readonly air: ThickAirParams,
    uniforms: Record<string, THREE.IUniform>,
  ) {
    this.shell = new THREE.Mesh(
      latLonSphere(128, 64),
      new THREE.ShaderMaterial({
        vertexShader: shellVertex,
        fragmentShader: skyFragment(thickAirGlsl(air)),
        uniforms,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.SrcAlphaFactor,
      }),
    );
    this.shell.renderOrder = 10;
    this.shell.frustumCulled = false;
    this.group.add(this.shell);
    this.group.visible = false;
  }

  update(f: GlobeFrame): void {
    const b = f.bodyToScene;
    this.quaternion.setFromRotationMatrix(new THREE.Matrix4().set(b[0], b[1], b[2], 0, b[3], b[4], b[5], 0, b[6], b[7], b[8], 0, 0, 0, 0, 1));
    const r = this.air.radius + this.air.top;
    this.shell.position.set(f.centerRel[0], f.centerRel[1], f.centerRel[2]);
    this.shell.quaternion.copy(this.quaternion);
    this.shell.scale.set(r, r, r);
  }
}

/** Height (km) above the reference radius below which the ground can be seen. */
export function belowDeck(air: ThickAirParams, eyeBody: Vec3): boolean {
  return Math.hypot(eyeBody[0], eyeBody[1], eyeBody[2]) - air.radius < air.top;
}

const lum = (c: Vec3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Vertical optical depth above height h (km), as taAbove in the shader. */
export function tauAbove(a: ThickAirParams, h: number): Vec3 {
  h = Math.max(h, 0);
  const deck = Math.max(a.deck[1] - Math.max(h, a.deck[0]), 0);
  return [0, 1, 2].map((k) => a.gas[k] * a.gasHeight * Math.exp(-h / a.gasHeight) + a.haze[k] * a.hazeHeight * Math.exp(-h / a.hazeHeight) + a.deckExtinction[k] * deck) as Vec3;
}

/** Luminance of the diffuse light at height h, as taDiffuse in the shader. */
export function diffuseLight(a: ThickAirParams, h: number, mu0: number): number {
  const m = Math.min(1, Math.max(0, (mu0 + 0.12) / 1.12));
  const f = Math.min(1, Math.max(0, lum(tauAbove(a, h)) / lum(tauAbove(a, 0))));
  const c = [0, 1, 2].map((k) => Math.exp(f * Math.log(a.ground[k] * m * (1 + 2 * m) + 1e-7) + (1 - f) * Math.log(a.topLight[k] * m + 1e-7))) as Vec3;
  return lum(c);
}

/** How much of the sky the atmosphere above height h veils (0 in space, 1 under the deck). */
export function veil(a: ThickAirParams, h: number): number {
  return 1 - Math.exp(-lum(tauAbove(a, h)));
}
