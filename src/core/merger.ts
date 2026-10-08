/**
 * Two black holes spiralling together and merging: GW150914, the first gravitational
 * waves detected (LIGO, 14 Sep 2015).
 *
 * - Inspiral: the post-Newtonian equations for the orbit's frequency (TaylorT4 to 3.5PN,
 *   non-spinning; Boyle et al. 2007, Buonanno et al. 2009). x = (G M omega / c^3)^(2/3).
 * - Merger and ringdown: the frequency carries on smoothly (frequency and its rate) into
 *   the final black hole's ringing, its fundamental l = m = 2 quasi-normal mode (Berti,
 *   Cardoso and Will 2006 fits for its mass and spin). The amplitude peaks where numerical
 *   relativity puts the peak of equal-mass mergers (G M omega_22 / c^3 = 0.36) and then
 *   rings down at the mode's damping time.
 * - The final black hole: spin from Rezzolla et al. (2008), energy radiated from
 *   Barausse, Morozova and Rezzolla (2012), both fits to numerical relativity.
 *
 * Masses are LIGO's (GWTC-1) source-frame values; the signal LIGO saw is stretched by
 * 1 + z, so its time scales use the redshifted ("detector-frame") masses.
 */

export const G_SI = 6.6743e-11;
export const C_SI = 299792458;
export const MSUN_KG = 1.98847e30;
/** G Msun / c^3, seconds. */
export const T_SUN = (G_SI * MSUN_KG) / C_SI ** 3;
/** G Msun / c^2, km. */
export const R_SUN_KM = (G_SI * MSUN_KG) / C_SI ** 2 / 1000;
const EULER_GAMMA = 0.5772156649015329;

export interface BinarySpec {
  name: string;
  m1: number;
  m2: number;
  z: number;
  distanceMpc: number;
  /** When the peak passed Earth (UTC ms). */
  peakUtc: number;
}

export const GW150914: BinarySpec = {
  name: 'GW150914',
  m1: 35.6,
  m2: 30.6,
  z: 0.09,
  distanceMpc: 440,
  // GPS 1126259462.423 s (the peak in figure 2 at Hanford): 09:50:45.423 UTC.
  peakUtc: Date.UTC(2015, 8, 14, 9, 50, 45, 423),
};

export const symmetricMassRatio = (m1: number, m2: number) => (m1 * m2) / (m1 + m2) ** 2;
export const chirpMass = (m1: number, m2: number) => (m1 * m2) ** 0.6 / (m1 + m2) ** 0.2;

/** Final spin of a merger of non-spinning holes (Rezzolla et al. 2008). */
export function finalSpin(eta: number): number {
  return Math.sqrt(12) * eta - 3.871 * eta * eta + 4.028 * eta ** 3;
}

/** Binding energy per unit mass at the innermost stable circular orbit of a Kerr hole (prograde). */
export function iscoEnergy(a: number): number {
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  const r = 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
  return Math.sqrt(1 - 2 / (3 * r));
}

/**
 * Energy radiated, as a fraction of the total mass (Barausse, Morozova and Rezzolla 2012).
 * `aTilde` is the holes' own spin projected on the orbit (zero for GW150914).
 */
export function radiatedFraction(eta: number, aTilde = 0): number {
  const p0 = 0.04827, p1 = 0.01707;
  const e = iscoEnergy(aTilde);
  return (1 - e) * eta + 4 * eta * eta * (4 * p0 + 16 * p1 * aTilde * (aTilde + 1) + e - 1);
}

/** The l = m = 2, n = 0 quasi-normal mode of a Kerr hole: M omega (angular frequency x M) and quality factor (Berti et al. 2006). */
export function qnm22(a: number): { momega: number; q: number } {
  return { momega: 1.5251 - 1.1568 * (1 - a) ** 0.1292, q: 0.7 + 1.4187 * (1 - a) ** -0.499 };
}

/** TaylorT4 dx/dt (per unit M, i.e. with time in units of G M / c^3), non-spinning, 3.5PN. */
export function dxdt(x: number, eta: number): number {
  const pi = Math.PI;
  const e2 = eta * eta, e3 = e2 * eta;
  const c2 = -743 / 336 - (11 / 4) * eta;
  const c3 = 4 * pi;
  const c4 = 34103 / 18144 + (13661 / 2016) * eta + (59 / 18) * e2;
  const c5 = (-4159 / 672 - (189 / 8) * eta) * pi;
  const c6 = 16447322263 / 139708800 - (1712 / 105) * EULER_GAMMA + (16 / 3) * pi * pi - (856 / 105) * Math.log(16 * x)
    + (-56198689 / 217728 + (451 / 48) * pi * pi) * eta + (541 / 896) * e2 - (5605 / 2592) * e3;
  const c7 = (-4415 / 4032 + (358675 / 6048) * eta + (91495 / 1512) * e2) * pi;
  const s = 1 + c2 * x + c3 * x ** 1.5 + c4 * x * x + c5 * x ** 2.5 + c6 * x ** 3 + c7 * x ** 3.5;
  return (64 / 5) * eta * x ** 5 * s;
}

/**
 * A waveform: the dominant (2,2) mode's phase and amplitude, and the orbit, sampled
 * evenly in time. Time is in units of the total mass (G M / c^3), zero at the peak.
 */
export class Inspiral {
  readonly eta: number;
  readonly finalSpin: number;
  /** Final mass as a fraction of the total. */
  readonly finalMass: number;
  readonly qnm: { momega: number; q: number };
  /** Start time, step (units of M) and samples. */
  readonly t0: number;
  readonly dt: number;
  /** GW phase (radians), GW angular frequency (1/M), amplitude (x-like, h = 4 eta M/D A). */
  readonly phase: Float64Array;
  readonly omega: Float64Array;
  readonly amp: Float64Array;
  /** Index of the peak; separation of the holes (units of M) up to it. */
  readonly peak: number;

  constructor(m1: number, m2: number, fromX = 0.04, dt = 0.5) {
    const eta = symmetricMassRatio(m1, m2);
    this.eta = eta;
    this.finalSpin = finalSpin(eta);
    this.finalMass = 1 - radiatedFraction(eta);
    this.qnm = qnm22(this.finalSpin);
    const wQnm = this.qnm.momega / this.finalMass;
    const tauQnm = (2 * this.qnm.q) / wQnm;
    const wPeak = 0.36;
    this.dt = dt;
    const phase: number[] = [], omega: number[] = [], amp: number[] = [];
    // Inspiral: RK4 on x; the GW angular frequency is 2 x^(3/2).
    let x = fromX;
    let ph = 0;
    const xEnd = 0.2;
    const step = (xx: number) => dxdt(xx, eta);
    while (x < xEnd) {
      omega.push(2 * x ** 1.5);
      amp.push(x);
      phase.push(ph);
      const k1 = step(x), k2 = step(x + 0.5 * dt * k1), k3 = step(x + 0.5 * dt * k2), k4 = step(x + dt * k3);
      const nx = x + (dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
      ph += dt * (x ** 1.5 + nx ** 1.5); // trapezoid on 2 x^(3/2)
      x = nx;
    }
    // Merger: the frequency carries on (with its rate) toward the ringing's.
    const n0 = omega.length;
    const wM = omega[n0 - 1];
    const wDot = (omega[n0 - 1] - omega[n0 - 2]) / dt;
    const k = wDot / (wQnm - wM);
    const aM = amp[n0 - 1];
    let peak = -1;
    let aPeak = 0;
    let tPeak = 0;
    for (let i = 1; ; i++) {
      const t = i * dt;
      const w = wQnm - (wQnm - wM) * Math.exp(-k * t);
      let a: number;
      if (peak < 0) {
        // Until the peak, the amplitude keeps rising as the inspiral's, x = (omega/2)^(2/3).
        a = aM * ((w / wM) ** (2 / 3));
        if (w >= wPeak) {
          peak = n0 - 1 + i;
          aPeak = a;
          tPeak = t;
        }
      } else a = aPeak * Math.exp(-(t - tPeak) / tauQnm);
      ph += dt * w;
      omega.push(w);
      amp.push(a);
      phase.push(ph);
      if (peak >= 0 && t - tPeak > 12 * tauQnm) break;
      if (i > 1e6) throw new Error('merger never peaks');
    }
    this.peak = peak;
    this.t0 = -peak * dt;
    this.phase = Float64Array.from(phase);
    this.omega = Float64Array.from(omega);
    this.amp = Float64Array.from(amp);
  }

  get end(): number {
    return this.t0 + (this.phase.length - 1) * this.dt;
  }

  private at(arr: Float64Array, t: number): number {
    const x = (t - this.t0) / this.dt;
    if (x <= 0) return arr[0];
    const n = arr.length;
    if (x >= n - 1) return arr[n - 1];
    const i = Math.floor(x), f = x - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  }

  /** GW phase at t (units of M; before the start, extrapolated at leading order). */
  gwPhase(t: number): number {
    if (t < this.t0) {
      // Leading order backward from the start: phi(tau) ~ -2 (5 / eta)^(3/8) tau^(5/8) / ... (only for timing the far past).
      return this.phase[0] - this.omega[0] * (this.t0 - t);
    }
    if (t > this.end) return this.phase[this.phase.length - 1] + this.omega[this.omega.length - 1] * (t - this.end);
    return this.at(this.phase, t);
  }

  gwOmega(t: number): number {
    return this.at(this.omega, t);
  }

  amplitude(t: number): number {
    if (t > this.end) return 0;
    return this.at(this.amp, t);
  }

  /** Orbital separation (units of M) before the peak: Kepler's law from the orbital frequency. */
  separation(t: number): number {
    const w = this.gwOmega(t) / 2;
    return Math.cbrt(1 / (w * w));
  }

  /** Strain at unit "distance factor": h(t) = A(t) cos(phase + phi0). */
  strain(t: number, phi0 = 0): number {
    return this.amplitude(t) * Math.cos(this.gwPhase(t) + phi0);
  }
}

/**
 * The merger itself as numerical relativity solved it: the waveform LIGO compared with
 * its data (GWOSC, figure 2 of Abbott et al. 2016), as amplitude and phase. Times are
 * at Earth, seconds from the peak.
 */
export interface NrSegment {
  t0: number;
  dt: number;
  amp: Float64Array;
  phase: Float64Array;
}

/** Amplitude and phase of a real series (its analytic signal), after removing what is below `fLow` Hz. */
export function analytic(x: ArrayLike<number>, dt: number, fLow: number): { amp: Float64Array; phase: Float64Array } {
  let n = 1;
  while (n < x.length * 2) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < x.length; i++) re[i] = x[i];
  fft(re, im);
  for (let k = 0; k < n; k++) {
    const f = Math.min(k, n - k) / (n * dt);
    // Positive frequencies doubled, negative ones dropped; and a gentle high-pass.
    const hp = f < fLow ? 0 : f < 1.5 * fLow ? 0.5 - 0.5 * Math.cos((Math.PI * (f - fLow)) / (0.5 * fLow)) : 1;
    const g = k === 0 ? 0 : k < n / 2 ? 2 * hp : k === n / 2 ? hp : 0;
    re[k] *= g;
    im[k] *= g;
  }
  fft(re, im, true);
  const amp = new Float64Array(x.length), phase = new Float64Array(x.length);
  let prev = 0, turns = 0;
  for (let i = 0; i < x.length; i++) {
    amp[i] = Math.hypot(re[i], im[i]);
    const p = Math.atan2(im[i], re[i]);
    if (i > 0 && p - prev > Math.PI) turns--;
    else if (i > 0 && p - prev < -Math.PI) turns++;
    prev = p;
    phase[i] = p + 2 * Math.PI * turns;
  }
  return { amp, phase };
}

/** The binary's waveform with physical units: seconds in the source frame and at Earth. */
export class Binary {
  readonly spec: BinarySpec;
  readonly wave: Inspiral;
  /** Total mass, final mass (solar masses, source frame) and its spin. */
  readonly mass: number;
  readonly finalMass: number;
  readonly finalSpin: number;
  /** G M / c^3 in seconds, source frame. */
  readonly tM: number;
  /** The numerical-relativity merger, once attached, and where the inspiral hands over to it (detector s). */
  nr?: NrSegment;
  private stitch = 0;
  /** Inspiral time shift (detector s) and phase offset that make it meet the merger smoothly. */
  private shift = 0;
  private phaseOffset = 0;
  private nrSign = 1;
  private ampScale = 1;

  constructor(spec: BinarySpec) {
    this.spec = spec;
    this.mass = spec.m1 + spec.m2;
    this.wave = new Inspiral(spec.m1, spec.m2);
    this.finalMass = this.wave.finalMass * this.mass;
    this.finalSpin = this.wave.finalSpin;
    this.tM = this.mass * T_SUN;
  }

  private get z1(): number {
    return 1 + this.spec.z;
  }

  /**
   * Hand over from the post-Newtonian inspiral to numerical relativity's merger at
   * `stitch` (detector s from the peak): the inspiral is shifted in time so its frequency
   * matches there, and in phase so the two join.
   */
  useNumericalRelativity(h: ArrayLike<number>, t0: number, dt: number, stitch = -0.1): void {
    const { amp, phase } = analytic(h, dt, 22);
    // Phase increasing with time, like the model's.
    this.nrSign = phase[phase.length - 1] > phase[0] ? 1 : -1;
    for (let i = 0; i < phase.length; i++) phase[i] *= this.nrSign;
    this.nr = { t0, dt, amp, phase };
    this.stitch = stitch;
    const fNr = this.nrOmega(stitch) / (2 * Math.PI);
    // The model's frequency at detector time td is (gwOmega(td/z1/tM))/(2 pi tM z1).
    const tModel = this.pnTimeAtFrequency(fNr);
    this.shift = stitch - tModel;
    this.phaseOffset = this.nrPhase(stitch) - this.pnPhaseDetector(stitch);
    this.ampScale = this.nrAmp(stitch) / Math.max(this.pnAmpDetector(stitch), 1e-30);
  }

  private nrIndex(td: number): number {
    return (td - this.nr!.t0) / this.nr!.dt;
  }

  private nrSample(arr: Float64Array, td: number): number {
    const x = Math.min(Math.max(this.nrIndex(td), 0), arr.length - 1.0001);
    const i = Math.floor(x), f = x - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  }

  private nrPhase(td: number): number {
    return this.nrSample(this.nr!.phase, td);
  }

  private nrAmp(td: number): number {
    return this.nrSample(this.nr!.amp, td);
  }

  /** NR angular frequency (rad/s at Earth), from a smoothed phase difference. */
  private nrOmega(td: number): number {
    const h = 4 * this.nr!.dt;
    return (this.nrPhase(td + h) - this.nrPhase(td - h)) / (2 * h);
  }

  private pnPhaseDetector(td: number): number {
    return this.wave.gwPhase((td - this.shift) / this.z1 / this.tM);
  }

  private pnAmpDetector(td: number): number {
    return this.wave.amplitude((td - this.shift) / this.z1 / this.tM);
  }

  private pnTimeAtFrequency(fDetector: number): number {
    let lo = this.wave.t0 * this.tM * this.z1, hi = 0;
    for (let k = 0; k < 80; k++) {
      const mid = 0.5 * (lo + hi);
      const f = this.wave.gwOmega(mid / this.z1 / this.tM) / (2 * Math.PI * this.tM * this.z1);
      if (f < fDetector) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  /** Is the numerical-relativity merger in charge at detector time td? */
  private inNr(td: number): boolean {
    return !!this.nr && td >= this.stitch && this.nrIndex(td) < this.nr.amp.length - 1;
  }

  /** GW phase (radians) at detector time td (s from the peak). */
  phaseAt(td: number): number {
    if (!this.nr) return this.wave.gwPhase(td / this.z1 / this.tM);
    if (td < this.stitch) return this.pnPhaseDetector(td) + this.phaseOffset;
    if (this.inNr(td)) return this.nrPhase(td);
    // After the NR waveform ends: the ringing carries on at the mode's frequency.
    const end = this.nr.t0 + (this.nr.amp.length - 1) * this.nr.dt;
    return this.nrPhase(end) + 2 * Math.PI * this.ringdown().frequency * (td - end);
  }

  /** GW angular frequency at detector time td (rad/s). */
  omegaAt(td: number): number {
    if (this.inNr(td)) return this.nrOmega(td);
    if (this.nr && td > this.stitch) return 2 * Math.PI * this.ringdown().frequency;
    return this.wave.gwOmega((td - this.shift) / this.z1 / this.tM) / (this.tM * this.z1);
  }

  /** Amplitude (in the model's x units; h = 4 eta M_z / D_L times this) at detector time td. */
  amplitudeAt(td: number): number {
    if (!this.nr) return this.wave.amplitude(td / this.z1 / this.tM);
    if (td < this.stitch) return this.pnAmpDetector(td);
    if (this.inNr(td)) return this.nrAmp(td) / this.ampScale;
    const end = this.nr.t0 + (this.nr.amp.length - 1) * this.nr.dt;
    return (this.nrAmp(end) / this.ampScale) * Math.exp(-(td - end) / this.ringdown().tau);
  }

  /** GW frequency (Hz) at source time t (s from the peak), and as LIGO saw it. */
  frequency(t: number): { source: number; detector: number } {
    const fd = this.omegaAt(t * this.z1) / (2 * Math.PI);
    return { source: fd * this.z1, detector: fd };
  }

  /** Ring-down frequency (Hz) and damping time (s), as LIGO saw them. */
  ringdown(): { frequency: number; tau: number } {
    const w = this.wave.qnm.momega / (this.finalMass * T_SUN);
    return { frequency: w / (2 * Math.PI) / this.z1, tau: ((2 * this.wave.qnm.q) / w) * this.z1 };
  }

  /** The strain at Earth, face-on (h+), at detector time td (s from the peak). */
  strainAtEarth(td: number, phi0 = 0): number {
    const dKm = this.spec.distanceMpc * 3.0856775814913673e19;
    // h = 4 eta (G M_z / c^2) / D_L x for the (2,2) mode face-on.
    const mzKm = this.mass * this.z1 * R_SUN_KM;
    return ((4 * this.wave.eta * mzKm) / dKm) * this.amplitudeAt(td) * Math.cos(this.phaseAt(td) + phi0);
  }

  /** Holes' positions in the orbital plane (units of total M, centre of mass at 0) at source time t (s). */
  positions(t: number): { r1: [number, number]; r2: [number, number]; merged: boolean; separation: number; orbitPhase: number } {
    const td = t * this.z1;
    const phi = this.phaseAt(td) / 2;
    const merged = td >= 0;
    // Kepler's law from the orbital frequency (in units of M); the last few M before the
    // peak are where the horizons merge.
    const w = (this.omegaAt(td) / 2) * this.tM * this.z1;
    const sep = merged ? 0 : Math.max(1.8, Math.cbrt(1 / (w * w)));
    const f1 = this.spec.m2 / this.mass, f2 = this.spec.m1 / this.mass;
    const c = Math.cos(phi), s = Math.sin(phi);
    return { r1: [f1 * sep * c, f1 * sep * s], r2: [-f2 * sep * c, -f2 * sep * s], merged, separation: sep, orbitPhase: phi };
  }

  /** Time to the peak (s, source frame) from a GW frequency at Earth (Hz), by search over the inspiral. */
  timeAtFrequency(fDetector: number): number {
    let lo = -60, hi = 0;
    for (let k = 0; k < 80; k++) {
      const mid = 0.5 * (lo + hi);
      if (this.frequency(mid).detector < fDetector) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  /** Power radiated (erg/s) at source time t: the quadrupole formula's (32/5) eta^2 x^5 c^5/G, scaled by the amplitude's departure from the inspiral's. */
  luminosity(t: number): number {
    const td = t * this.z1;
    const x = ((this.omegaAt(td) / 2) * this.tM * this.z1) ** (2 / 3);
    const a = this.amplitudeAt(td) / Math.max(x, 1e-9);
    const c5g = (C_SI ** 5 / G_SI) * 1e7;
    return (32 / 5) * this.wave.eta ** 2 * x ** 5 * a * a * c5g;
  }
}

// ---- comparing with what LIGO recorded ---------------------------------------------------

/** In-place radix-2 FFT of (re, im); n a power of two. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j], ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi;
        re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** Band-pass a series (sample interval dt) between f1 and f2 Hz, with gentle (cosine) edges. */
export function bandpass(x: ArrayLike<number>, dt: number, f1: number, f2: number): Float64Array {
  let n = 1;
  while (n < x.length * 2) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  // A Tukey window keeps the ends from ringing.
  for (let i = 0; i < x.length; i++) {
    const e = Math.min(i, x.length - 1 - i) / (0.05 * x.length);
    re[i] = x[i] * (e >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * e));
  }
  fft(re, im);
  for (let k = 0; k < n; k++) {
    const f = Math.min(k, n - k) / (n * dt);
    const g = f < f1 * 0.8 || f > f2 * 1.2 ? 0 : f < f1 ? 0.5 - 0.5 * Math.cos((Math.PI * (f - 0.8 * f1)) / (0.2 * f1)) : f > f2 ? 0.5 + 0.5 * Math.cos((Math.PI * (f - f2)) / (0.2 * f2)) : 1;
    re[k] *= g;
    im[k] *= g;
  }
  fft(re, im, true);
  return re.slice(0, x.length);
}

/**
 * The best match of the model to a recorded series: over a time shift (s), an overall
 * amplitude and phase (the detector sees some mix of the two polarisations). Returns the
 * normalised overlap (1 = identical shape) and the fitted model series.
 */
export function matchModel(
  b: Binary, ref: ArrayLike<number>, t0: number, dt: number, filter?: [number, number], shifts: [number, number, number] = [-0.03, 0.03, 0.0002],
): { overlap: number; shift: number; amplitude: number; phase: number; series: Float64Array } {
  const n = ref.length;
  // Analytic in-phase and quadrature models (phase 0 and pi/2) at each shift.
  const series = (shift: number, phi0: number) => {
    const s = new Float64Array(n);
    for (let i = 0; i < n; i++) s[i] = b.strainAtEarth(t0 + i * dt - shift, phi0) * 1e21;
    return filter ? bandpass(s, dt, filter[0], filter[1]) : s;
  };
  const dot = (a: ArrayLike<number>, c: ArrayLike<number>) => { let s = 0; for (let i = 0; i < n; i++) s += a[i] * c[i]; return s; };
  const rr = dot(ref, ref);
  let best = { overlap: -1, shift: 0, amplitude: 0, phase: 0, series: new Float64Array(n) };
  for (let shift = shifts[0]; shift <= shifts[1] + 1e-12; shift += shifts[2]) {
    const c = series(shift, 0), q = series(shift, -Math.PI / 2);
    const cc = dot(c, c), qq = dot(q, q), cq = dot(c, q);
    const rc = dot(ref, c), rq = dot(ref, q);
    // Best combination alpha c + beta q (least squares).
    const det = cc * qq - cq * cq;
    const alpha = (rc * qq - rq * cq) / det, beta = (rq * cc - rc * cq) / det;
    const fit = alpha * rc + beta * rq; // = |projection|^2
    const overlap = fit / Math.sqrt(rr * fit) ;
    if (overlap > best.overlap) {
      const s = new Float64Array(n);
      for (let i = 0; i < n; i++) s[i] = alpha * c[i] + beta * q[i];
      best = { overlap, shift, amplitude: Math.hypot(alpha, beta), phase: Math.atan2(beta, alpha), series: s };
    }
  }
  return best;
}
