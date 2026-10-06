import { ECLIPSE_GLSL } from './shadow';

/**
 * A planet's atmosphere in single scattering: small molecules (Rayleigh), aerosols
 * (Mie, with a Henyey-Greenstein-like phase function) and an absorbing ozone layer,
 * integrated along each view ray. Coefficients are km^-1 at the bottom radius, per
 * colour channel (red, green, blue). Everything works in the body frame with z scaled
 * by a/b, which turns an ellipsoid of revolution into a sphere of radius a.
 */
export interface AtmosphereParams {
  bottom: number;
  top: number;
  rayleigh: [number, number, number];
  rayleighHeight: number;
  /** Aerosol scattering and extinction (scattering / extinction = single-scattering albedo). */
  mieScattering: [number, number, number];
  mieExtinction: [number, number, number];
  mieHeight: number;
  /** Phase function asymmetry: larger is more forward scattering. */
  mieG: [number, number, number];
  ozone: [number, number, number];
  /** Densities stay constant below this height (km): the ground can lie below `bottom`. */
  floor: number;
  /**
   * Single scattering leaves out light scattered more than once. In Earth's thin air
   * that is a small part of the sky; in Mars's dust it is most of it. A plain factor on
   * the scattered light stands in for it.
   */
  multiple: number;
}

/** Earth: the standard sea-level values of Bruneton's precomputed model (2017 reference implementation). */
export const ATMOSPHERE: AtmosphereParams = {
  bottom: 6378.137,
  top: 6378.137 + 80,
  rayleigh: [5.802e-3, 13.558e-3, 33.1e-3],
  rayleighHeight: 8,
  mieScattering: [3.996e-3, 3.996e-3, 3.996e-3],
  mieExtinction: [4.44e-3, 4.44e-3, 4.44e-3],
  mieHeight: 1.2,
  mieG: [0.8, 0.8, 0.8],
  ozone: [0.65e-3, 1.881e-3, 0.085e-3],
  floor: 0,
  multiple: 1,
};

/**
 * Mars: almost all of its sky is dust. CO2 at about 6 mbar and 210 K has 0.8% of the
 * molecules of sea-level air and scatters 2.4 times as strongly per molecule, so its
 * Rayleigh scattering is 2% of Earth's. The dust is a typical clear-season load:
 * vertical optical depth 0.5 above the 3389.5 km datum (about 0.42 above Jezero), with
 * an 11 km scale height. Its grains (about 1.5 µm) absorb blue: single-scattering
 * albedos of about 0.97, 0.92 and 0.72 in red, green and blue, and they throw blue light
 * further forward (Wolff et al. 2009, CRISM). So the daytime sky is butterscotch and the
 * sky around the setting Sun is blue. At this dust load most of the sky's light has been
 * scattered more than once; a factor of 3 on the single-scattered light makes the sky
 * above Jezero about as bright as the sunlit ground, as it is in Mastcam-Z images.
 */
const MARS_DUST = 0.5 / 11;
export const MARS_ATMOSPHERE: AtmosphereParams = {
  bottom: 3389.5,
  top: 3389.5 + 80,
  rayleigh: [0.02 * 5.802e-3, 0.02 * 13.558e-3, 0.02 * 33.1e-3],
  rayleighHeight: 11.1,
  mieScattering: [0.97 * MARS_DUST, 0.92 * MARS_DUST, 0.72 * MARS_DUST],
  mieExtinction: [MARS_DUST, MARS_DUST, MARS_DUST],
  mieHeight: 11,
  mieG: [0.63, 0.66, 0.71],
  ozone: [0, 0, 0],
  floor: -10,
  multiple: 3,
};

const vec3 = (v: number[]) => `vec3(${v.map((x) => x.toExponential(4)).join(', ')})`;

export function atmosphereGlsl(a: AtmosphereParams): string {
  return /* glsl */ `
${ECLIPSE_GLSL}
const float ATM_BOTTOM = ${a.bottom.toFixed(3)};
const float ATM_TOP = ${a.top.toFixed(3)};
const float ATM_FLOOR = ${a.floor.toFixed(2)};
const vec3 RAYLEIGH = ${vec3(a.rayleigh)};
const float RAYLEIGH_H = ${a.rayleighHeight.toFixed(1)};
const vec3 MIE_S = ${vec3(a.mieScattering)};
const vec3 MIE_E = ${vec3(a.mieExtinction)};
const float MIE_H = ${a.mieHeight.toFixed(2)};
const vec3 MIE_G = vec3(${a.mieG.map((g) => g.toFixed(3)).join(', ')});
const vec3 OZONE = ${vec3(a.ozone)};
const float PI_A = 3.14159265;
const float ATM_MULTIPLE = ${a.multiple.toFixed(2)};

// Densities relative to sea level: (rayleigh, mie, ozone). Ozone is a tent at 25 km.
vec3 atmDensity(float h) {
  h = max(h, ATM_FLOOR);
  return vec3(exp(-h / RAYLEIGH_H), exp(-h / MIE_H), max(0.0, 1.0 - abs(h - 25.0) / 15.0));
}

vec3 atmExtinction(vec3 d) {
  return RAYLEIGH * d.x + MIE_E * d.y + OZONE * d.z;
}

// Distances along the ray to a sphere of radius r centred at the origin; (-1,-1) if missed.
vec2 atmSphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

// Optical depth (summed extinction) from p toward the sun; large if the ground is in the way.
vec3 atmSunDepth(vec3 p, vec3 sunDir) {
  vec2 ground = atmSphere(p, sunDir, ATM_BOTTOM - 0.5);
  if (ground.x > 0.0) return vec3(1e4);
  float len = atmSphere(p, sunDir, ATM_TOP).y;
  const int N = 6;
  float dt = len / float(N);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 q = p + sunDir * (float(i) + 0.5) * dt;
    sum += atmDensity(length(q) - ATM_BOTTOM);
  }
  return sum * dt;
}

vec3 atmSunTransmittance(vec3 p, vec3 sunDir) {
  return exp(-atmExtinction(atmSunDepth(p, sunDir)));
}

float rayleighPhase(float mu) { return 3.0 / (16.0 * PI_A) * (1.0 + mu * mu); }
vec3 miePhase(float mu) {
  vec3 g2 = MIE_G * MIE_G;
  return 3.0 / (8.0 * PI_A) * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * MIE_G * mu, vec3(1.5)));
}

// Light scattered toward the camera along ro + rd*t for t in [t0, t1], and the
// transmittance over that segment. Irradiance of the sun is 1.
void atmScatter(vec3 ro, vec3 rd, float t0, float t1, vec3 sunDir, out vec3 inscatter, out vec3 transmittance) {
  const int N = 14;
  float dt = (t1 - t0) / float(N);
  vec3 depth = vec3(0.0);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * (t0 + (float(i) + 0.5) * dt);
    vec3 d = atmDensity(length(p) - ATM_BOTTOM) * dt;
    depth += d;
    // Air in the Moon's shadow scatters no sunlight: the sky darkens in a solar eclipse.
    // (p is in the frame where z is scaled by uFlatten; the shadow needs true positions.)
    vec3 t = exp(-atmExtinction(depth + atmSunDepth(p, sunDir))) * eclipseVisibility(vec3(p.xy, p.z / uFlatten));
    sumR += t * d.x;
    sumM += t * d.y;
  }
  float mu = dot(rd, sunDir);
  inscatter = (sumR * RAYLEIGH * rayleighPhase(mu) + sumM * MIE_S * miePhase(mu)) * ATM_MULTIPLE;
  transmittance = exp(-atmExtinction(depth));
}

// Aerial perspective between the camera and a point, both in the scaled body frame.
void atmBetween(vec3 cam, vec3 p, vec3 sunDir, out vec3 inscatter, out vec3 transmittance) {
  vec3 rd = p - cam;
  float dist = length(rd);
  rd /= dist;
  vec2 top = atmSphere(cam, rd, ATM_TOP);
  float t0 = max(top.x, 0.0);
  float t1 = min(dist, top.y);
  if (top.y < 0.0 || t1 <= t0) {
    inscatter = vec3(0.0);
    transmittance = vec3(1.0);
    return;
  }
  atmScatter(cam, rd, t0, t1, sunDir, inscatter, transmittance);
}
`;
}

export const ATMOSPHERE_GLSL = atmosphereGlsl(ATMOSPHERE);
