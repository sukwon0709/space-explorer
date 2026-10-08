/**
 * A star being born: a dense core of gas and dust collapsing under its own gravity into
 * a protostar with a disc and jets, then a young star contracting onto the main sequence.
 *
 * The starting point is real: Barnard 68, a dark cloud 125 pc away whose density, mapped
 * from the dimming of 3,700 stars behind it, is a Bonnor-Ebert sphere (a self-gravitating
 * isothermal ball held in by outside pressure) just past the point where it must collapse:
 * xi_max = 6.9 at 16 K (Alves, Lada and Lada 2001). What follows is computed:
 * - the collapse, inside out (Shu 1977): a wave of infall spreads from the centre at the
 *   sound speed, and each shell it reaches falls in from rest in its own free-fall time;
 * - a third of the infalling gas ends up in the star, the rest is blown out by the
 *   outflow (Matzner and McKee 2000; Alves et al. 2007 find cores turn about a third of
 *   their mass into stars);
 * - the disc: each shell keeps its angular momentum, from a slow spin typical of dense
 *   cores (1 km/s/pc, Goodman et al. 1993), and settles at its centrifugal radius;
 * - the outflow cavity widens from 10 to 60 degrees as the envelope is cleared (Arce and
 *   Sargent 2006);
 * - the young star's temperature, luminosity and radius from the Baraffe et al. (2015)
 *   models; the disc fades with the e-folding of 2.5 million years seen in young
 *   clusters (Mamajek 2009).
 */

const G = 6.674e-8;
const K_B = 1.380649e-16;
const M_H = 1.6735575e-24;
export const MSUN = 1.98847e33;
const AU_CM = 1.495978707e13;
export const YEAR_S = 3.15576e7;
const PC_CM = 3.0856775814913673e18;
const RSUN_CM = 6.957e10;
const LSUN = 3.828e33;

/**
 * The isothermal Lane-Emden equation, psi'' + (2/xi) psi' = exp(-psi): density
 * rho = rho_c exp(-psi), mass m(xi) = xi^2 psi'. Tabulated to xi = 30.
 */
export class IsothermalSphere {
  readonly xi: Float64Array;
  readonly psi: Float64Array;
  readonly dpsi: Float64Array;

  constructor(maxXi = 30, step = 0.001) {
    const n = Math.ceil(maxXi / step) + 1;
    this.xi = new Float64Array(n);
    this.psi = new Float64Array(n);
    this.dpsi = new Float64Array(n);
    // Series start: psi = xi^2/6 - xi^4/120.
    let x = step, p = (x * x) / 6 - x ** 4 / 120, d = x / 3 - x ** 3 / 30;
    this.xi[0] = 0;
    const f = (xx: number, pp: number, dd: number): [number, number] => [dd, Math.exp(-pp) - (2 / xx) * dd];
    for (let i = 1; i < n; i++) {
      this.xi[i] = x;
      this.psi[i] = p;
      this.dpsi[i] = d;
      const [a1, b1] = f(x, p, d);
      const [a2, b2] = f(x + step / 2, p + (step / 2) * a1, d + (step / 2) * b1);
      const [a3, b3] = f(x + step / 2, p + (step / 2) * a2, d + (step / 2) * b2);
      const [a4, b4] = f(x + step, p + step * a3, d + step * b3);
      p += (step / 6) * (a1 + 2 * a2 + 2 * a3 + a4);
      d += (step / 6) * (b1 + 2 * b2 + 2 * b3 + b4);
      x += step;
    }
  }

  private index(xi: number): [number, number] {
    const x = Math.min(Math.max(xi / this.xi[1], 0), this.xi.length - 1.0001);
    const i = Math.floor(x);
    return [i, x - i];
  }

  psiAt(xi: number): number {
    const [i, f] = this.index(xi);
    return this.psi[i] * (1 - f) + this.psi[i + 1] * f;
  }

  /** Dimensionless mass xi^2 psi'. */
  massAt(xi: number): number {
    const [i, f] = this.index(xi);
    const x = this.xi[i] * (1 - f) + this.xi[i + 1] * f;
    return x * x * (this.dpsi[i] * (1 - f) + this.dpsi[i + 1] * f);
  }

  /**
   * The dimensionless mass at fixed outside pressure, m(xi) e^(-psi/2), peaks at the
   * critical radius: beyond it no equilibrium holds and the sphere must collapse.
   */
  critical(): { xi: number; mass: number; contrast: number } {
    let best = 0, bx = 0;
    for (let i = 1; i < this.xi.length; i++) {
      const m = this.xi[i] ** 2 * this.dpsi[i] * Math.exp(-this.psi[i] / 2);
      if (m > best) { best = m; bx = this.xi[i]; }
    }
    return { xi: bx, mass: best, contrast: Math.exp(this.psiAt(bx)) };
  }
}

export interface CoreSpec {
  name: string;
  aliases: string[];
  ra: number;
  dec: number;
  distancePc: number;
  /** Gas temperature (K), mean molecular mass, outside pressure (dyn/cm^2), xi_max. */
  temperature: number;
  mu: number;
  pressure: number;
  xiMax: number;
  /** Solid-body spin (rad/s) and the share of infalling mass that ends in the star. */
  omega: number;
  efficiency: number;
}

/** Barnard 68 (Alves, Lada and Lada 2001): 16 K, P = 2.5e-12 Pa, xi_max = 6.9 at 125 pc. */
export const BARNARD_68: CoreSpec = {
  name: 'Barnard 68',
  aliases: ['barnard 68', 'b68', 'b 68', 'star birth', 'star being born'],
  ra: 255.6592, dec: -23.8261,
  distancePc: 125,
  temperature: 16,
  mu: 2.33,
  pressure: 2.5e-11,
  xiMax: 6.9,
  omega: 1e5 / PC_CM,
  efficiency: 1 / 3,
};

/** A track of the young star: log10 age (yr), Teff (K), log10 L/Lsun, R/Rsun. */
export type PmsTrack = Array<[number, number, number, number]>;

export interface Protostar {
  /** Years since the collapse began. */
  age: number;
  /** Mass in the star, the disc and the envelope still around them (solar masses). */
  star: number;
  disc: number;
  envelope: number;
  /** Accretion rate (solar masses per year). */
  accretion: number;
  /** Radius of the region falling in (cm); of the disc (cm); the outflow cavity's half-angle (radians). */
  infall: number;
  discRadius: number;
  cavity: number;
  /** The star: radius (cm), temperature (K), luminosity (Lsun, including accretion). */
  radius: number;
  teff: number;
  luminosity: number;
  /** The evolutionary class (0, I, II, III; 'core' before the star forms; 'MS' on the main sequence). */
  stage: string;
}

export class StarBirth {
  readonly spec: CoreSpec;
  readonly sphere = new IsothermalSphere();
  /** Sound speed (cm/s), central density (g/cm^3), radius (cm), mass (g). */
  readonly cs: number;
  readonly rhoC: number;
  readonly radius: number;
  readonly mass: number;
  /** Shells: initial radius (cm), enclosed mass (g), and when each reaches the centre (s). */
  private readonly r0: Float64Array;
  private readonly m0: Float64Array;
  private readonly tff: Float64Array;
  private readonly track: PmsTrack;
  /** When the first gas reaches the centre (s). */
  readonly firstCore: number;

  constructor(spec: CoreSpec, track: PmsTrack) {
    this.spec = spec;
    this.track = track;
    this.cs = Math.sqrt((K_B * spec.temperature) / (spec.mu * M_H));
    const rhoEdge = spec.pressure / (this.cs * this.cs);
    this.rhoC = rhoEdge * Math.exp(this.sphere.psiAt(spec.xiMax));
    const scale = this.cs / Math.sqrt(4 * Math.PI * G * this.rhoC);
    this.radius = spec.xiMax * scale;
    this.mass = this.sphere.massAt(spec.xiMax) * this.cs ** 3 / Math.sqrt(4 * Math.PI * G ** 3 * this.rhoC);
    const n = 400;
    this.r0 = new Float64Array(n);
    this.m0 = new Float64Array(n);
    this.tff = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const xi = spec.xiMax * ((i + 1) / n) ** 1.5;
      const r = xi * scale;
      const m = this.sphere.massAt(xi) * this.cs ** 3 / Math.sqrt(4 * Math.PI * G ** 3 * this.rhoC);
      this.r0[i] = r;
      this.m0[i] = m;
      this.tff[i] = r / this.cs + (Math.PI / 2) * Math.sqrt((r * r * r) / (2 * G * m));
    }
    this.firstCore = this.tff[0];
  }

  /** Free-fall time of the central density, s. */
  centralFreeFall(): number {
    return Math.sqrt((3 * Math.PI) / (32 * G * this.rhoC));
  }

  /** Initial density at radius r (cm). */
  density0(r: number): number {
    const xi = r / (this.cs / Math.sqrt(4 * Math.PI * G * this.rhoC));
    return xi > this.spec.xiMax ? 0 : this.rhoC * Math.exp(-this.sphere.psiAt(xi));
  }

  /** Mass that has reached the centre by time t (s). */
  private arrived(t: number): number {
    // tff increases outward; interpolate.
    if (t <= this.tff[0]) return 0;
    const n = this.tff.length;
    if (t >= this.tff[n - 1]) return this.m0[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.tff[mid] < t) lo = mid;
      else hi = mid;
    }
    const f = (t - this.tff[lo]) / (this.tff[hi] - this.tff[lo]);
    return this.m0[lo] * (1 - f) + this.m0[hi] * f;
  }

  /**
   * Radius (cm) at time t of the shell that started at r0, falling from rest once the
   * infall wave has reached it (the cycloid
   * r = r0 cos^2 b, b + sin b cos b = t sqrt(2 G M / r0^3)); 0 once it has arrived.
   */
  shellRadius(r0: number, m: number, t: number): number {
    // It starts falling when the infall wave reaches it.
    t -= r0 / this.cs;
    if (t <= 0) return r0;
    const k = t * Math.sqrt((2 * G * m) / (r0 * r0 * r0));
    if (k >= Math.PI / 2) return 0;
    let b = Math.min(k, 1.5);
    for (let i = 0; i < 40; i++) {
      const f = b + Math.sin(b) * Math.cos(b) - k;
      const d = 2 * Math.cos(b) ** 2;
      b -= f / Math.max(d, 1e-6);
      b = Math.min(Math.max(b, 0), Math.PI / 2);
    }
    return r0 * Math.cos(b) ** 2;
  }

  /**
   * The envelope's density profile at time t (s): pairs of [radius cm, density g/cm^3]
   * from the inside out, mass conserved shell by shell.
   */
  profile(t: number, samples = 64): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    const n = this.r0.length;
    let prevR = 0, prevM = 0;
    const step = Math.max(1, Math.floor(n / samples));
    for (let i = 0; i < n; i += step) {
      const r = this.shellRadius(this.r0[i], this.m0[i], t);
      if (r <= 0) { prevM = this.m0[i]; continue; }
      const dm = this.m0[i] - prevM;
      const vol = (4 / 3) * Math.PI * (r ** 3 - prevR ** 3);
      if (vol > 0) out.push([r, dm / vol]);
      prevR = r;
      prevM = this.m0[i];
    }
    return out;
  }

  /** Disc radius (cm): the largest centrifugal radius of the gas arrived so far. */
  private discRadius(arrivedMass: number): number {
    if (arrivedMass <= 0) return 0;
    // The shell that just arrived: its mean specific angular momentum (2/3) Omega r0^2.
    let i = 0;
    while (i < this.m0.length - 1 && this.m0[i] < arrivedMass) i++;
    const j = (2 / 3) * this.spec.omega * this.r0[i] ** 2;
    return (j * j) / (G * arrivedMass);
  }

  /** The young star's track at an age (years since the collapse). */
  private onTrack(age: number): [number, number, number] {
    const lt = Math.log10(Math.max(age, 1));
    const tr = this.track;
    if (lt <= tr[0][0]) return [tr[0][1], tr[0][2], tr[0][3]];
    for (let k = 1; k < tr.length; k++) {
      if (tr[k][0] >= lt) {
        const f = (lt - tr[k - 1][0]) / (tr[k][0] - tr[k - 1][0]);
        return [tr[k - 1][1] * (1 - f) + tr[k][1] * f, tr[k - 1][2] * (1 - f) + tr[k][2] * f, tr[k - 1][3] * (1 - f) + tr[k][3] * f];
      }
    }
    const last = tr[tr.length - 1];
    return [last[1], last[2], last[3]];
  }

  /** Everything at `years` after the collapse began (negative: the cloud as it is now). */
  state(years: number): Protostar {
    const t = Math.max(0, years) * YEAR_S;
    const arrived = this.arrived(t);
    const dt = Math.max(t * 0.01, 1e9);
    const rate = (this.arrived(t + dt) - this.arrived(Math.max(0, t - dt))) / (t + dt - Math.max(0, t - dt));
    const eff = this.spec.efficiency;
    const discShare = 0.1;
    // Gas that has arrived goes to the star (and briefly the disc); the rest is blown out.
    const discLife = 2.5e6;
    const accEnd = this.tff[this.tff.length - 1] / YEAR_S;
    const fade = years > accEnd ? Math.exp(-(years - accEnd) / discLife) : 1;
    const inStar = arrived * eff;
    const disc = inStar * discShare * fade;
    const star = inStar - inStar * discShare + inStar * discShare * (1 - fade);
    const envelope = Math.max(0, this.mass - arrived);
    // The infall region: as far as the infall wave has spread.
    const infall = Math.min(this.radius, this.cs * t);
    const [teffTrack, logL, rTrack] = this.onTrack(years);
    const radius = (arrived > 0 ? rTrack : 0) * RSUN_CM;
    const lAcc = arrived > 0 && radius > 0 ? (G * star * rate * eff) / radius / LSUN : 0;
    const lPhot = arrived > 0 ? 10 ** logL * Math.min(1, (star / MSUN / 0.7) ** 2) : 0;
    const luminosity = lAcc + lPhot;
    const teff = radius > 0 ? Math.max(teffTrack, (luminosity * LSUN / (4 * Math.PI * 5.670374e-5 * radius * radius)) ** 0.25) : 0;
    const cleared = smoothLog(1e4, 3e5, years);
    const cavity = ((10 + 50 * cleared) * Math.PI) / 180;
    let stage = 'core';
    if (arrived > 0) {
      if (envelope / this.mass > 0.5 && star < envelope) stage = '0';
      else if (envelope > 0.02 * this.mass) stage = 'I';
      else if (disc / MSUN > 1e-4) stage = 'II';
      else stage = 'III';
      if (years > 5e7 && Math.abs(teffTrack - this.track[this.track.length - 1][1]) < 300) stage = 'MS';
    }
    return {
      age: years, star: star / MSUN, disc: disc / MSUN, envelope: envelope / MSUN, accretion: (rate * eff * YEAR_S) / MSUN,
      infall, discRadius: Math.min(this.discRadius(arrived), 300 * AU_CM) * (arrived > 0 ? 1 : 0), cavity, radius, teff, luminosity, stage,
    };
  }

  /** Visual extinction through the cloud's centre now (magnitudes), N_H / A_V = 1.87e21 cm^-2 (Bohlin et al. 1978). */
  peakExtinction(offsetCm = 0): number {
    const steps = 2000;
    const R = this.radius;
    if (offsetCm >= R) return 0;
    const half = Math.sqrt(R * R - offsetCm * offsetCm);
    let column = 0;
    for (let i = 0; i < steps; i++) {
      const z = -half + ((i + 0.5) / steps) * 2 * half;
      column += this.density0(Math.hypot(z, offsetCm)) * ((2 * half) / steps);
    }
    // Hydrogen nuclei per gram for mu = 2.33 per particle (H2 + He): 1 / (1.4 m_H).
    const nH = column / (1.4 * M_H);
    return nH / 1.87e21;
  }
}

function smoothLog(a: number, b: number, x: number): number {
  if (x <= a) return 0;
  if (x >= b) return 1;
  const t = Math.log(x / a) / Math.log(b / a);
  return t * t * (3 - 2 * t);
}

export const AU = AU_CM;
export const PARSEC_CM = PC_CM;
