import type { Vec3 } from './ephemeris';

/**
 * Light paths around a spinning (Kerr) black hole, in Boyer-Lindquist coordinates and
 * geometric units (G = c = M = 1, so lengths are in gravitational radii GM/c^2).
 *
 * A photon's path is integrated backward from the camera with fourth-order Runge-Kutta
 * on the Hamiltonian equations of motion (as in Pu et al. 2016, "Odyssey"), with its
 * energy normalised to 1. Its angular momentum L and Carter's kappa = Q + L^2 + a^2 are
 * constants of the motion. The same scheme runs in the black hole shader
 * (render/blackhole.ts); this float64 version is what the tests check.
 */

export const enum Fate {
  Horizon = 0,
  Escaped = 1,
  Disc = 2,
  Body = 3,
  Lost = 4,
}

/** Outer event horizon radius. */
export const horizon = (a: number) => 1 + Math.sqrt(Math.max(0, 1 - a * a));

/** Innermost stable circular orbit, prograde (Bardeen, Press and Teukolsky 1972). */
export function isco(a: number): number {
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  return 3 + z2 - Math.sign(a || 1) * Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

/** Prograde and retrograde circular photon orbits in the equatorial plane. */
export function photonOrbits(a: number): [number, number] {
  return [2 * (1 + Math.cos((2 / 3) * Math.acos(-a))), 2 * (1 + Math.cos((2 / 3) * Math.acos(a)))];
}

/**
 * The shadow's edge seen by a distant observer at inclination `incl` (radians from the
 * spin axis), from the spherical photon orbits (Bardeen 1973). Returns image-plane
 * points (alpha, beta) in units of M; alpha is positive toward the side where the
 * hole's rotation carries matter away from the observer... i.e. along e_phi.
 */
export function criticalCurve(a: number, incl: number, n = 720): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const [r1, r2] = photonOrbits(a);
  const s = Math.sin(incl), c = Math.cos(incl);
  const upper: Array<[number, number]> = [];
  for (let k = 0; k <= n; k++) {
    const r = r1 + ((r2 - r1) * k) / n;
    let xi: number, eta: number;
    if (Math.abs(a) < 1e-9) {
      // Schwarzschild: every photon orbit is at r = 3 with b^2 = 27.
      const ang = (2 * Math.PI * k) / n;
      out.push([Math.sqrt(27) * Math.cos(ang), Math.sqrt(27) * Math.sin(ang)]);
      continue;
    }
    xi = (r * r * (3 - r) - a * a * (r + 1)) / (a * (r - 1));
    eta = (r ** 3 * (4 * a * a - r * (r - 3) ** 2)) / (a * a * (r - 1) ** 2);
    const b2 = eta + a * a * c * c - (xi * xi * c * c) / (s * s);
    if (b2 < 0) continue;
    upper.push([-xi / s, Math.sqrt(b2)]);
  }
  if (Math.abs(a) < 1e-9) return out;
  return [...upper, ...upper.slice().reverse().map(([x, y]) => [x, -y] as [number, number])];
}

/** Metric pieces at (r, theta). */
function metric(a: number, r: number, th: number) {
  const s = Math.sin(th), c = Math.cos(th);
  const s2 = s * s;
  const sigma = r * r + a * a * c * c;
  const delta = r * r - 2 * r + a * a;
  const A = (r * r + a * a) ** 2 - a * a * delta * s2;
  return { s, c, s2, sigma, delta, A };
}

/** BL azimuth minus Kerr-Schild azimuth, which vanishes at infinity: -int_r^inf a/Delta dr. */
export function phiShift(a: number, r: number): number {
  if (Math.abs(a) < 1e-12) return 0;
  const rp = 1 + Math.sqrt(Math.max(0, 1 - a * a)), rm = 1 - Math.sqrt(Math.max(0, 1 - a * a));
  if (rp - rm < 1e-6) return -a / (r - 1);
  return (a / (rp - rm)) * Math.log((r - rp) / (r - rm));
}

/** Kerr-Schild Cartesian position (units of M) to Boyer-Lindquist r, theta, phi. */
export function cartesianToBL(a: number, p: Vec3): [number, number, number] {
  const R2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
  const w = R2 - a * a;
  const r = Math.sqrt(0.5 * (w + Math.sqrt(w * w + 4 * a * a * p[2] * p[2])));
  const th = Math.acos(Math.max(-1, Math.min(1, p[2] / r)));
  // Kerr-Schild x + iy = (r + ia) sin(theta) e^{i phi_KS}.
  const phiKS = Math.atan2(p[1], p[0]) - Math.atan2(a, r);
  return [r, th, phiKS + phiShift(a, r)];
}

/** Boyer-Lindquist r, theta, phi to Kerr-Schild Cartesian (units of M). */
export function blToCartesian(a: number, r: number, th: number, ph: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const phiKS = ph - phiShift(a, r);
  const s = Math.sin(th);
  out[0] = s * (r * Math.cos(phiKS) - a * Math.sin(phiKS));
  out[1] = s * (r * Math.sin(phiKS) + a * Math.cos(phiKS));
  out[2] = r * Math.cos(th);
  return out;
}

/** State of a photon: r, theta, phi, p_r, p_theta (energy 1; L and kappa fixed). */
export type PhotonState = [number, number, number, number, number];

export interface Photon {
  a: number;
  L: number;
  kappa: number;
  /** Photon energy measured by the camera (a ZAMO), with E at infinity = 1. */
  eCamera: number;
  state: PhotonState;
}

/**
 * The photon that reaches a camera (a zero-angular-momentum observer) at Cartesian
 * position `p` from direction `dir` (unit, Cartesian: where the camera looks).
 */
export function photonFromCamera(a: number, p: Vec3, dir: Vec3): Photon {
  const [r, th] = cartesianToBL(a, p);
  const { s, c, sigma, delta, A } = metric(a, r, th);
  // Local orthonormal triad: spherical about the camera's position, which the oblate
  // coordinates approach for r >> a (so a photon heading straight out has L = 0).
  const az = Math.atan2(p[1], p[0]);
  const cp = Math.cos(az), sp = Math.sin(az);
  const er: Vec3 = [s * cp, s * sp, c];
  const et: Vec3 = [c * cp, c * sp, -s];
  const ef: Vec3 = [-sp, cp, 0];
  // The photon travels toward the camera: opposite to where it looks.
  const nr = -dot(dir, er), nt = -dot(dir, et), nf = -dot(dir, ef);
  const alpha = Math.sqrt((sigma * delta) / A);
  const omega = (2 * a * r) / A;
  const varpi = Math.sqrt(A / sigma) * s;
  const E = alpha + omega * varpi * nf;
  const pr = (Math.sqrt(sigma / delta) * nr) / E;
  const pt = (Math.sqrt(sigma) * nt) / E;
  const L = (varpi * nf) / E;
  const kappa = pt * pt + (L * L) / Math.max(s * s, 1e-12) + a * a * s * s;
  return { a, L, kappa, eCamera: 1 / E, state: [r, th, cartesianToBL(a, p)[2], pr, pt] };
}

/**
 * Right-hand side of Hamilton's equations (forward in affine parameter) for
 * H = F / (2 Sigma) with F = Delta p_r^2 + p_theta^2 + L^2/sin^2 + a^2 sin^2 - 2aL - P^2/Delta
 * and P = r^2 + a^2 - aL. The exact gradient (not one simplified with H = 0) keeps
 * H conserved by the flow, so integration errors do not feed on themselves.
 */
export function derivatives(a: number, L: number, y: PhotonState, out: PhotonState): PhotonState {
  const [r, th, , pr, pt] = y;
  const s = Math.sin(th), c = Math.cos(th);
  const s2 = Math.max(s * s, 1e-12);
  const sigma = r * r + a * a * c * c;
  const delta = r * r - 2 * r + a * a;
  const P = r * r + a * a - a * L;
  const F = delta * pr * pr + pt * pt + (L * L) / s2 + a * a * s2 - 2 * a * L - (P * P) / delta;
  const Fr = 2 * (r - 1) * pr * pr - (4 * r * P) / delta + (2 * (r - 1) * P * P) / (delta * delta);
  const Ft = 2 * s * c * (a * a - (L * L) / (s2 * s2));
  const is = 1 / sigma;
  out[0] = delta * pr * is;
  out[1] = pt * is;
  out[2] = (L / s2 - a + (a * P) / delta) * is;
  out[3] = -0.5 * Fr * is + F * r * is * is;
  out[4] = -0.5 * Ft * is - F * a * a * s * c * is * is;
  return out;
}

/** The constraint H = 0 (times 2 Sigma), a check on the integration. */
export function hamiltonian(a: number, L: number, y: PhotonState): number {
  const [r, th, , pr, pt] = y;
  const s2 = Math.max(Math.sin(th) ** 2, 1e-12);
  const delta = r * r - 2 * r + a * a;
  const P = r * r + a * a - a * L;
  return delta * pr * pr + pt * pt + (L * L) / s2 + a * a * s2 - 2 * a * L - (P * P) / delta;
}

export interface TraceOptions {
  /** Largest change in r (as a fraction of r, or of the distance to the horizon), theta or phi per step. */
  eps?: number;
  maxSteps?: number;
  /** Stop once outbound beyond this radius. */
  rEscape?: number;
  /** A thin disc in the equatorial plane, opaque between these radii. */
  disc?: { rIn: number; rOut: number };
  /** Called for every step: the chord from `from` to `to` (states), step length |dlambda|. */
  onStep?: (from: PhotonState, to: PhotonState, dl: number) => boolean | void;
}

export interface TraceResult {
  fate: Fate;
  state: PhotonState;
  steps: number;
  /** Escaped: the direction the photon came from at infinity (Cartesian, unit). */
  direction?: Vec3;
  /** Disc: the crossing radius. */
  r?: number;
}

/**
 * Near the poles (|sin theta| below this) a photon is moved as if L were 0. Boyer-Lindquist
 * coordinates are singular on the axis: a photon with small L whirls round it through
 * nearly 180 degrees of phi in a tiny region, and no step size resolves that for every L.
 * With L = 0 it passes straight over the pole instead (theta changing sign, which is the
 * same path, as it is close to straight there). The position is off by at most
 * POLE_CAP r sideways; the direction is unchanged.
 */
export const POLE_CAP = 0.01;

/**
 * A photon is taken over the pole when it is inside the cap and passes the axis at
 * under a third of the cap's radius (one turning farther out is integrated as it is).
 */
export function entersPoleCap(L: number, y: PhotonState): boolean {
  const s = Math.abs(Math.sin(y[1]));
  return s < POLE_CAP && Math.abs(L) < 0.3 * Math.sqrt(s * s * y[4] * y[4] + L * L);
}

/**
 * Entering the polar cap, p_theta takes up the L^2/sin^2 (and related) terms of the
 * constraint so H stays 0 with L = 0; leaving it, it gives them back.
 */
export function poleCapMomentum(a: number, L: number, y: PhotonState, entering: boolean): void {
  const r = y[0];
  const s2 = Math.max(Math.sin(y[1]) ** 2, 1e-12);
  const delta = r * r - 2 * r + a * a;
  const P0 = r * r + a * a;
  const extra = (L * L) / s2 - 2 * a * L + (2 * a * L * P0 - a * a * L * L) / delta;
  // Of the half turn in phi that a nearly straight path makes about the axis, the part
  // inside the cap is pi - asin(d / rho_in) - asin(d / rho_out) (d its distance from
  // the axis, rho the cap's radius where it enters and leaves); theta changing sign
  // accounts for pi of it, and these for the rest.
  const swing = () => Math.sign(L) * Math.asin(Math.min(1, Math.abs(L) / Math.sqrt(s2 * y[4] * y[4] + L * L)));
  if (entering) y[2] += swing();
  const p2 = y[4] * y[4] + (entering ? extra : -extra);
  y[4] = (y[4] < 0 ? -1 : 1) * Math.sqrt(Math.max(p2, 0));
  if (!entering) y[2] += swing();
}

/** Integrate a photon backward from the camera until it is captured, hits the disc or escapes. */
export function trace(ph: Photon, opts: TraceOptions = {}): TraceResult {
  const { a, L } = ph;
  const eps = opts.eps ?? 0.03;
  const maxSteps = opts.maxSteps ?? 20000;
  const rh = horizon(a);
  const rEscape = opts.rEscape ?? Math.max(1000, ph.state[0] * 1.01);
  let y = ph.state.slice() as PhotonState;
  const k1 = [0, 0, 0, 0, 0] as PhotonState, k2 = k1.slice() as PhotonState, k3 = k1.slice() as PhotonState, k4 = k1.slice() as PhotonState;
  const tmp = k1.slice() as PhotonState;
  const prevPos: Vec3 = [0, 0, 0], pos: Vec3 = [0, 0, 0];
  let inCap = false;
  for (let step = 0; step < maxSteps; step++) {
    const r = y[0];
    if (r < rh * 1.01 + 0.02) return { fate: Fate.Horizon, state: y, steps: step };
    if (L !== 0 && (inCap ? Math.abs(Math.sin(y[1])) >= POLE_CAP : entersPoleCap(L, y))) {
      inCap = !inCap;
      poleCapMomentum(a, L, y, inCap);
    }
    const Le = inCap ? 0 : L;
    derivatives(a, Le, y, k1);
    const h = stepSize(eps, r, rh, y[1], k1);
    // Backward in affine parameter: the photon's path traced from the camera.
    for (let k = 0; k < 5; k++) tmp[k] = y[k] - 0.5 * h * k1[k];
    derivatives(a, Le, tmp, k2);
    for (let k = 0; k < 5; k++) tmp[k] = y[k] - 0.5 * h * k2[k];
    derivatives(a, Le, tmp, k3);
    for (let k = 0; k < 5; k++) tmp[k] = y[k] - h * k3[k];
    derivatives(a, Le, tmp, k4);
    const next = [0, 0, 0, 0, 0] as PhotonState;
    for (let k = 0; k < 5; k++) next[k] = y[k] - (h / 6) * (k1[k] + 2 * k2[k] + 2 * k3[k] + k4[k]);
    if (opts.disc) {
      const c0 = Math.cos(y[1]), c1 = Math.cos(next[1]);
      if (c0 * c1 <= 0 && c0 !== c1) {
        const f = c0 / (c0 - c1);
        const rc = y[0] + (next[0] - y[0]) * f;
        if (rc >= opts.disc.rIn && rc <= opts.disc.rOut) return { fate: Fate.Disc, state: next, steps: step + 1, r: rc };
      }
    }
    if (opts.onStep && opts.onStep(y, next, h)) return { fate: Fate.Body, state: next, steps: step + 1 };
    // Outbound (r growing along the traced path) and far away: escaped.
    if (next[0] > rEscape && next[0] > y[0]) {
      blToCartesian(a, y[0], y[1], y[2], prevPos);
      blToCartesian(a, next[0], next[1], next[2], pos);
      const d: Vec3 = [pos[0] - prevPos[0], pos[1] - prevPos[1], pos[2] - prevPos[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      return { fate: Fate.Escaped, state: next, steps: step + 1, direction: [d[0] / len, d[1] / len, d[2] / len] };
    }
    y = next;
  }
  return { fate: Fate.Lost, state: y, steps: maxSteps };
}

/**
 * Step length (affine parameter): r changes by at most eps of the distance to the
 * horizon (or of r), and the direction by at most eps radians; theta in finer steps
 * near the poles, where a photon may turn round within a small angle.
 */
export function stepSize(eps: number, r: number, rh: number, th: number, d: PhotonState): number {
  const rScale = Math.min(r, Math.max(r - rh, 0.05) * 2);
  const s = Math.abs(Math.sin(th));
  const thetaRate = Math.abs(d[1]) * Math.max(1, 0.25 / Math.max(s, 0.2 * POLE_CAP));
  const rate = Math.max(Math.abs(d[0]) / rScale, thetaRate, Math.abs(d[2]) * Math.max(s, 0.25), 1e-9);
  return eps / rate;
}

// ---- matter: discs and flows ------------------------------------------------------

/** Angular velocity of a prograde circular equatorial orbit. */
export const keplerOmega = (a: number, r: number) => 1 / (r ** 1.5 + a);

/**
 * Redshift factor g = nu_observed / nu_emitted for matter on a circular orbit at
 * (r, theta) with angular velocity omega, seen by the camera that traced photon `ph`.
 * Falls back to the frame-dragging (ZAMO) rate where that orbit would be faster than light.
 */
export function redshift(a: number, r: number, th: number, omega: number, L: number, eCamera: number): number {
  const { s2, sigma, A } = metric(a, r, th);
  const gtt = -(1 - (2 * r) / sigma);
  const gtp = (-2 * a * r * s2) / sigma;
  const gpp = (A * s2) / sigma;
  let norm = -(gtt + 2 * omega * gtp + omega * omega * gpp);
  if (norm <= 1e-9) {
    omega = (2 * a * r) / A;
    norm = -(gtt + 2 * omega * gtp + omega * omega * gpp);
  }
  const ut = 1 / Math.sqrt(Math.max(norm, 1e-12));
  return eCamera / (ut * (1 - omega * L));
}

/**
 * Novikov-Thorne thin disc: the emitted flux at radius r as a fraction of the
 * Newtonian 3 Mdot / (8 pi r^3) scale with Mdot = 1 (Page and Thorne 1974).
 */
export function discFlux(a: number, r: number): number {
  const r0 = isco(a);
  if (r <= r0) return 0;
  const x = Math.sqrt(r), x0 = Math.sqrt(r0);
  const t = Math.acos(a);
  const x1 = 2 * Math.cos((t - Math.PI) / 3), x2 = 2 * Math.cos((t + Math.PI) / 3), x3 = -2 * Math.cos(t / 3);
  const term = (xi: number, xj: number, xk: number) => (3 * (xi - a) ** 2) / (xi * (xi - xj) * (xi - xk)) * Math.log((x - xi) / (x0 - xi));
  const bracket = x - x0 - 1.5 * a * Math.log(x / x0) - term(x1, x2, x3) - term(x2, x1, x3) - term(x3, x1, x2);
  return ((3 / (8 * Math.PI)) * bracket) / (x ** 4 * (x ** 3 - 3 * x + 2 * a));
}

/** Radiative efficiency of a thin disc: 1 - E_isco. */
export function efficiency(a: number): number {
  const r = isco(a);
  return 1 - (1 - 2 / r + a / r ** 1.5) / Math.sqrt(1 - 3 / r + (2 * a) / r ** 1.5);
}

/**
 * Emissivity of the hot, thick accretion flow at 230 GHz (the radiatively inefficient
 * flows of Sgr A* and M87*). The radial profile is the Johnson SU fit to time-averaged
 * GRMHD images (Gralla, Lupsasca and Marrone 2020: mu = horizon, gamma = -1.5,
 * width 0.5 M), spread over a thick layer of half-height 0.35 r.
 */
export function flowEmissivity(a: number, r: number, th: number): number {
  const rh = horizon(a);
  if (r < rh) return 0;
  const c = Math.cos(th);
  const x = (r - rh) / FLOW_WIDTH;
  const radial = Math.exp(-0.5 * (FLOW_GAMMA + Math.asinh(x)) ** 2) / Math.sqrt(x * x + 1);
  return radial * Math.exp(-(c * c) / (2 * FLOW_HEIGHT * FLOW_HEIGHT));
}
export const FLOW_HEIGHT = 0.35;
const FLOW_GAMMA = -1.5;
const FLOW_WIDTH = 0.5;

/** Angular velocity of the hot flow: Keplerian outside the ISCO, the ISCO's rate inside. */
export function flowOmega(a: number, r: number, th: number): number {
  const rc = Math.max(r * Math.abs(Math.sin(th)), isco(a));
  return keplerOmega(a, rc);
}

/** Integrated intensity of the hot flow along a traced photon path (arbitrary units). */
export function flowIntensity(ph: Photon, opts: { eps?: number; maxSteps?: number } = {}): { intensity: number; fate: Fate } {
  let intensity = 0;
  const { a, L, eCamera } = ph;
  const res = trace(ph, {
    ...opts,
    rEscape: Math.max(60, Math.min(1000, ph.state[0] * 1.01)),
    onStep: (from, to, dl) => {
      const r = 0.5 * (from[0] + to[0]);
      if (r > 50) return;
      const th = 0.5 * (from[1] + to[1]);
      const j = flowEmissivity(a, r, th);
      if (j <= 0) return;
      const g = redshift(a, r, th, flowOmega(a, r, th), L, eCamera);
      intensity += g ** FLOW_G_POWER * j * Math.abs(dl);
    },
  });
  return { intensity, fate: res.fate };
}
/** Observed intensity scales as g^3 times the emissivity (Gralla, Lupsasca and Marrone 2020). */
export const FLOW_G_POWER = 3;

const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
