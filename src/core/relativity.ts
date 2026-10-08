import type { Vec3 } from './ephemeris';
import { C_KMS } from './gravity';

/**
 * Special relativity for a ship moving fast through a sky at rest (the stars, galaxies
 * and the microwave background, all nearly at rest in the Sun's frame).
 *
 * What the pilot sees (Lorentz transformation of the light arriving at the ship):
 * - aberration: every source shifts toward the direction of travel;
 * - Doppler shift: light from a source in rest-frame direction n arrives with its
 *   frequencies multiplied by D = gamma (1 + beta . n), blue ahead and red behind;
 * - brightness: specific intensity goes as D^3 at the shifted frequency, so a surface
 *   glowing like a blackbody of temperature T looks like one of temperature D T; a star
 *   (a point) also shrinks in solid angle by D^2.
 *
 * And how the ship moves: under constant proper acceleration a (what the crew feels),
 * hyperbolic motion. Time on board (proper time tau) runs slow against the stars' time t.
 */

export const LIGHT_YEAR_KM = 9.4607304725808e12;
/** h c / (lambda k) for the V band's effective wavelength, 545 nm: kelvin. */
export const V_BAND_K = 1.438777e-2 / 545e-9;
/** The microwave background today (Fixsen 2009), K. */
export const T_CMB = 2.7255;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.sqrt(dot(a, a));

/** gamma for a speed as a fraction of light (beta < 1). */
export function gammaOf(beta: number): number {
  return 1 / Math.sqrt((1 - beta) * (1 + beta));
}

/**
 * Where a source seen in rest-frame direction `n` (unit, toward the source) appears to
 * an observer moving with velocity `beta` (fraction of c): toward the motion.
 *   n' = normalise(n + bhat ((gamma - 1)(n . bhat) + gamma beta))
 * With `beta` negated, the inverse: the rest-frame direction of an observed one.
 */
export function aberrate(n: Vec3, beta: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const b = len(beta);
  if (b === 0) {
    out[0] = n[0];
    out[1] = n[1];
    out[2] = n[2];
    return out;
  }
  const g = gammaOf(b);
  const nb = dot(n, beta) / b;
  const k = ((g - 1) * nb + g * b) / b;
  const x = n[0] + k * beta[0], y = n[1] + k * beta[1], z = n[2] + k * beta[2];
  const l = Math.hypot(x, y, z);
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
  return out;
}

/** Doppler factor (observed over emitted frequency) for a source in rest-frame direction n. */
export function doppler(n: Vec3, beta: Vec3): number {
  const b = len(beta);
  return gammaOf(b) * (1 + dot(n, beta));
}

/** Doppler factor for a source seen in direction n' (observer's frame): 1 / (gamma (1 - beta . n')). */
export function dopplerObserved(nObs: Vec3, beta: Vec3): number {
  return 1 / (gammaOf(len(beta)) * (1 - dot(nObs, beta)));
}

/** ln(e^x - 1), without overflow for large x or loss for small x. */
function logExpm1(x: number): number {
  return x > 30 ? x + Math.log1p(-Math.exp(-x)) : Math.log(Math.expm1(x));
}

/**
 * How much brighter in V a surface glowing like a blackbody of temperature T looks when
 * Doppler shifted by D: B_V(D T) / B_V(T).
 */
export function surfaceGain(D: number, kelvin: number): number {
  const x = V_BAND_K / kelvin;
  return Math.exp(logExpm1(x) - logExpm1(x / D));
}

/**
 * The same for a star (a point source): its disc also shrinks by D, so the flux is
 * D^-2 B_V(D T) / B_V(T). Far ahead, where D is large, a star's light moves into the
 * ultraviolet and it fades in visible light, and behind, into the infrared: the visible
 * stars gather in a ring ahead.
 */
export function pointGain(D: number, kelvin: number): number {
  return surfaceGain(D, kelvin) / (D * D);
}

/** Solid angle of the Sun from Earth (sr) and its V magnitude (Willmer 2018). */
const SUN_SOLID_ANGLE = Math.PI * (959.63 / 206264.806) ** 2;
export const SUN_V = -26.76;

/**
 * The microwave background ahead of a ship moving with gamma >> 1, as one point: its V-band
 * flux relative to the Sun's seen from Earth. Ahead, D = 2 gamma / (1 + u) with
 * u = (gamma theta)^2, so the background looks like a blackbody at D T over a patch only
 * about 1/gamma across; the flux is the integral of B_V(D T) over that patch.
 */
export function forwardBackgroundFlux(gamma: number, kelvin = T_CMB): number {
  const b = (t: number) => Math.exp(-logExpm1(V_BAND_K / t));
  // In w = ln(1 + u): dOmega = pi du / gamma^2 = pi (1 + u) dw / gamma^2.
  const wMax = Math.log(Math.max(1, (2 * gamma * kelvin) / 50));
  const n = 400;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const w = ((i + 0.5) / n) * wMax;
    const onePlusU = Math.exp(w);
    sum += b((2 * gamma * kelvin) / onePlusU) * onePlusU;
  }
  const flux = (sum * (wMax / n) * Math.PI) / (gamma * gamma);
  return flux / (b(5772) * SUN_SOLID_ANGLE);
}

/** cosh(x) - 1 without cancellation for small x. */
function coshm1(x: number): number {
  const s = Math.sinh(x / 2);
  return 2 * s * s;
}

/** acosh(1 + y) without cancellation for small y. */
function acosh1p(y: number): number {
  return Math.log1p(y + Math.sqrt(y * (y + 2)));
}

/** Hyperbolic motion from rest under proper acceleration `a` (km/s^2) for proper time tau (s). */
export function hyperbolic(a: number, tau: number): { x: number; t: number; beta: number; gamma: number } {
  const phi = (a * tau) / C_KMS;
  return { x: ((C_KMS * C_KMS) / a) * coshm1(phi), t: (C_KMS / a) * Math.sinh(phi), beta: Math.tanh(phi), gamma: Math.cosh(phi) };
}

/** Proper time (s) to cover `x` km from rest at proper acceleration `a`. */
export function properTimeFor(a: number, x: number): number {
  return (C_KMS / a) * acosh1p((a * x) / (C_KMS * C_KMS));
}

/**
 * A trip that accelerates at `a` (km/s^2, felt on board) for the first half and
 * decelerates for the second, arriving at rest `distance` km away. The fastest way to
 * get anywhere with a given engine and a crew that has to live through it.
 */
export class Trip {
  readonly distance: number;
  readonly a: number;
  /** Proper time on board, and the stars' time, for the whole trip (s). */
  readonly tau: number;
  readonly t: number;
  /** Top speed (fraction of c) and gamma, at the turnaround. */
  readonly peakBeta: number;
  readonly peakGamma: number;

  constructor(distance: number, a: number) {
    this.distance = distance;
    this.a = a;
    const half = properTimeFor(a, distance / 2);
    const mid = hyperbolic(a, half);
    this.tau = 2 * half;
    this.t = 2 * mid.t;
    this.peakBeta = mid.beta;
    this.peakGamma = mid.gamma;
  }

  /** State at proper time tau since departure: distance covered, stars' time, speed. */
  at(tau: number): { x: number; t: number; beta: number; gamma: number; accelerating: boolean } {
    const half = this.tau / 2;
    tau = Math.min(this.tau, Math.max(0, tau));
    if (tau <= half) return { ...hyperbolic(this.a, tau), accelerating: true };
    // The second half mirrors the first.
    const rest = hyperbolic(this.a, this.tau - tau);
    return { x: this.distance - rest.x, t: this.t - rest.t, beta: rest.beta, gamma: rest.gamma, accelerating: false };
  }
}

/**
 * Free flight under the ship's own engines at relativistic speed: the state is the
 * proper velocity u = gamma v (km/s), which a proper acceleration alpha (felt on board,
 * km/s^2, given in the stars' axes) changes as
 *   du/dtau = alpha + (gamma - 1)(alpha . vhat) vhat
 * (the 4-acceleration seen from the stars), and position as dx/dtau = u.
 * Steps proper time; returns the stars' time that passed.
 */
export function freeStep(x: Vec3, u: Vec3, alpha: Vec3, dtau: number): number {
  const n = Math.max(1, Math.ceil((len(alpha) * dtau) / (0.001 * C_KMS)));
  const h = dtau / n;
  let t = 0;
  for (let i = 0; i < n; i++) {
    const g0 = Math.sqrt(1 + dot(u, u) / (C_KMS * C_KMS));
    const s = len(u);
    const along = s > 0 ? ((g0 - 1) * dot(alpha, u)) / (s * s) : 0;
    const um: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) um[k] = u[k] + 0.5 * h * (alpha[k] + along * u[k]);
    const gm = Math.sqrt(1 + dot(um, um) / (C_KMS * C_KMS));
    const sm = len(um);
    const alongM = sm > 0 ? ((gm - 1) * dot(alpha, um)) / (sm * sm) : 0;
    for (let k = 0; k < 3; k++) {
      x[k] += um[k] * h;
      u[k] += h * (alpha[k] + alongM * um[k]);
    }
    t += gm * h;
  }
  return t;
}

/** Velocity as a fraction of c from a proper velocity (km/s). */
export function betaOf(u: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const g = Math.sqrt(1 + dot(u, u) / (C_KMS * C_KMS));
  for (let k = 0; k < 3; k++) out[k] = u[k] / (g * C_KMS);
  return out;
}

/**
 * GLSL for the shaders that draw the sky: aberration of a view-space position, the
 * Doppler factor, and the visible-light gain of a blackbody. uBetaView is the ship's
 * velocity (fraction of c) in view axes; uGamma its gamma (exact on the CPU, so the
 * shader never takes 1 - beta of a number near 1).
 */
export const RELATIVITY_GLSL = /* glsl */ `
uniform vec3 uBetaView;
uniform float uGamma;
// Observed direction of a source in rest-frame direction n (unit).
vec3 aberrateDir(vec3 n) {
  if (uGamma <= 1.0) return n;
  float b = length(uBetaView);
  vec3 bh = uBetaView / b;
  return normalize(n + bh * ((uGamma - 1.0) * dot(n, bh) + uGamma * b));
}
// Rest-frame direction of a source seen in direction n (unit): the inverse.
vec3 restDir(vec3 n) {
  if (uGamma <= 1.0) return n;
  float b = length(uBetaView);
  vec3 bh = uBetaView / b;
  return normalize(n + bh * ((uGamma - 1.0) * dot(n, bh) - uGamma * b));
}
float dopplerRest(vec3 n) { return uGamma * (1.0 + dot(uBetaView, n)); }
// A view-space position moved to where it appears, at the same distance.
vec4 relativistic(vec4 mv) {
  if (uGamma <= 1.0) return mv;
  float r = length(mv.xyz);
  return vec4(aberrateDir(mv.xyz / r) * r, mv.w);
}
float logExpm1(float x) { return x > 30.0 ? x : x < 1e-3 ? log(max(x * (1.0 + 0.5 * x), 1e-30)) : log(exp(x) - 1.0); }
// B_nu(D T) / B_nu(T) at h nu / k = x kelvin: a blackbody surface Doppler shifted by D.
float planckGain(float D, float kelvin, float x) {
  if (uGamma <= 1.0) return 1.0;
  float a = x / kelvin;
  return exp(logExpm1(a) - logExpm1(a / D));
}
float surfaceGainV(float D, float kelvin) { return planckGain(D, kelvin, ${V_BAND_K.toFixed(1)}); }
// The colour of a Doppler-shifted blackbody of temperature T, relative to unshifted, per
// channel (R 610 nm, G 550 nm, B 465 nm): multiplies a linear RGB colour.
vec3 dopplerTint(float D, float kelvin) {
  return vec3(planckGain(D, kelvin, 23587.0), planckGain(D, kelvin, 26159.0), planckGain(D, kelvin, 30941.0));
}
`;
