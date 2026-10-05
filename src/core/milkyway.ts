import type { Vec3 } from './ephemeris';
import milkyWay from '../generated/milkyway.json';

/**
 * A model of the Milky Way's light and dust, for the diffuse glow seen from inside and
 * the whole galaxy seen from outside. Everything here is a fitted model, not an image:
 *
 * - Frame: galactocentric, kpc, with the Galactic Centre (Sgr A*) at the origin, x from
 *   the Sun toward the centre, y toward Galactic longitude 90 degrees (the direction of
 *   rotation at the Sun) and z toward the north Galactic pole. The Sun is at
 *   (-R0, 0, Z_SUN): R0 = 8.277 kpc (GRAVITY Collaboration 2022), Z_SUN = 20.8 pc
 *   (Bennett and Bovy 2019).
 * - Stars: exponential thin and thick discs (scale lengths 2.6 and 2.0 kpc, heights 300
 *   and 900 pc, Bland-Hawthorn and Gerhard 2016) with the inner disc emptied by the bar,
 *   the boxy bulge (Dwek et al. 1995's G2 model) and the long bar at 28 degrees to the
 *   Sun-centre line, and young stars along the spiral arms of Reid et al. (2019).
 *   The disc is normalised to the V-band luminosity density of the app's own Gaia and
 *   Hipparcos stars within 100 pc (pipeline/build_milkyway.py).
 * - Dust: an exponential dust disc (scale length 3.2 kpc, height 120 pc, A_V = 1 mag/kpc
 *   in the plane at the Sun) concentrated along the arms; within 1.25 kpc of the Sun the
 *   Edenhofer et al. (2024) 3D dust map replaces it (render/milkyway.ts).
 *
 * The arms are traced by masers out to where Reid et al. measured them; the far side of
 * the Galaxy is the same spirals carried on, fading out, and is modelled.
 */

export const R0 = 8.277;
export const Z_SUN = 0.0208;
export const BAR_ANGLE = (28 * Math.PI) / 180;

/** ICRS to Galactic (Hipparcos definition, as in astropy), rows. */
export const ICRS_TO_GAL = [
  -0.0548755604162154, -0.8734370902348850, -0.4838350155487132,
  0.4941094278755837, -0.4448296299600112, 0.7469822444972189,
  -0.8676661490190047, -0.1980763734312015, 0.4559837761750669,
];

/** Barycentric ICRS position in parsecs to galactocentric model coordinates in kpc. */
export function icrsPcToGalactocentric(p: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const m = ICRS_TO_GAL;
  const x = m[0] * p[0] + m[1] * p[1] + m[2] * p[2];
  const y = m[3] * p[0] + m[4] * p[1] + m[5] * p[2];
  const z = m[6] * p[0] + m[7] * p[1] + m[8] * p[2];
  out[0] = x / 1000 - R0;
  out[1] = y / 1000;
  out[2] = z / 1000 + Z_SUN;
  return out;
}

/** The inverse: galactocentric kpc to barycentric ICRS parsecs. */
export function galactocentricToIcrsPc(g: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const m = ICRS_TO_GAL;
  const x = (g[0] + R0) * 1000, y = g[1] * 1000, z = (g[2] - Z_SUN) * 1000;
  out[0] = m[0] * x + m[3] * y + m[6] * z;
  out[1] = m[1] * x + m[4] * y + m[7] * z;
  out[2] = m[2] * x + m[5] * y + m[8] * z;
  return out;
}

/**
 * Spiral arms from Reid et al. (2019, ApJ 885, 131, table 2): log spirals with a kink,
 * ln(R / Rkink) = -(beta - betaKink) tan(psi), beta the galactocentric azimuth (degrees,
 * 0 toward the Sun, increasing with Galactic rotation). psi is the pitch angle below
 * and above the kink; width is the arm's Gaussian width at the kink (kpc).
 */
export interface Arm {
  name: string;
  betaMin: number;
  betaMax: number;
  betaKink: number;
  rKink: number;
  psiBelow: number;
  psiAbove: number;
  width: number;
  /** Relative strength of the arm's young stars and dust. */
  strength: number;
}

export const ARMS: Arm[] = [
  { name: '3-kpc', betaMin: 15, betaMax: 18, betaKink: 15, rKink: 3.52, psiBelow: -4.2, psiAbove: -4.2, width: 0.18, strength: 0.5 },
  { name: 'Norma-Outer', betaMin: -6, betaMax: 54, betaKink: 18, rKink: 4.46, psiBelow: -1.0, psiAbove: 19.5, width: 0.14, strength: 0.8 },
  { name: 'Scutum-Centaurus', betaMin: 0, betaMax: 104, betaKink: 23, rKink: 4.91, psiBelow: 14.1, psiAbove: 12.1, width: 0.23, strength: 1 },
  { name: 'Sagittarius-Carina', betaMin: 2, betaMax: 97, betaKink: 24, rKink: 6.04, psiBelow: 17.1, psiAbove: 1.0, width: 0.27, strength: 1 },
  { name: 'Local', betaMin: -8, betaMax: 34, betaKink: 9, rKink: 8.26, psiBelow: 11.4, psiAbove: 11.4, width: 0.31, strength: 0.6 },
  { name: 'Perseus', betaMin: -23, betaMax: 115, betaKink: 40, rKink: 8.87, psiBelow: 10.3, psiAbove: 8.7, width: 0.35, strength: 1 },
  { name: 'Outer', betaMin: -16, betaMax: 71, betaKink: 18, rKink: 12.24, psiBelow: 3.0, psiAbove: 9.4, width: 0.65, strength: 0.6 },
];

/** How far (degrees of azimuth) the modelled arms carry on beyond the measured stretch. */
const ARM_EXTENSION = 110;

/**
 * Strength of the spiral arms at a point in the plane (0 between arms, up to 1 on an
 * arm's crest), and how much of that is measured rather than extrapolated.
 */
export function armField(x: number, y: number): { arm: number; measured: number } {
  const r = Math.hypot(x, y);
  if (r < 1e-3) return { arm: 0, measured: 0 };
  const beta = (Math.atan2(y, -x) * 180) / Math.PI;
  let arm = 0;
  let measured = 0;
  for (const a of ARMS) {
    for (let k = -1; k <= 1; k++) {
      const b = beta + 360 * k;
      const lo = a.betaMin - ARM_EXTENSION, hi = a.betaMax + ARM_EXTENSION;
      if (a.name === '3-kpc' ? b < a.betaMin - 40 || b > a.betaMax + 40 : b < lo || b > hi) continue;
      const psi = ((b < a.betaKink ? a.psiBelow : a.psiAbove) * Math.PI) / 180;
      const rArm = a.rKink * Math.exp((-(b - a.betaKink) * Math.PI * Math.tan(psi)) / 180);
      const w = a.width * Math.max(0.6, rArm / a.rKink);
      const d = (r - rArm) * Math.cos(psi);
      const over = Math.max(a.betaMin - b, b - a.betaMax, 0);
      const fade = Math.exp(-((over / (a.name === '3-kpc' ? 20 : 60)) ** 2));
      const v = a.strength * fade * Math.exp((-0.5 * d * d) / (w * w));
      arm = Math.max(arm, v);
      if (over === 0) measured = Math.max(measured, v);
    }
  }
  return { arm, measured };
}

/** Disc density is suppressed inside the bar's radius (a Freeman type II disc). */
export const discHole = (r: number) => 1 - Math.exp(-((r / 3.2) ** 3));

/** Shape parameters shared with the shader (render/milkyway.ts). */
export const MODEL = {
  thin: { hR: 2.6, hz: 0.3 },
  thick: { hR: 2.0, hz: 0.9, ratio: 0.07 },
  arms: { hR: 3.5, hz: 0.09, amplitude: 0.9, old: 0.3 },
  bulge: { x0: 1.46, y0: 0.49, z0: 0.39, luminosity: 6e9 },
  bar: { x0: 4.5, y0: 0.55, z0: 0.16, luminosity: 1.5e9 },
  dust: { hR: 3.2, hz: 0.12, local: 1.0, arms: 1.5 },
};

/** Unnormalised disc (thin + thick + arm stars) density, and the separate parts. */
function discParts(x: number, y: number, z: number, armValue?: number) {
  const r = Math.hypot(x, y);
  const hole = discHole(r);
  const arm = armValue ?? armField(x, y).arm;
  // The old disc is bunched up in the arms too, though far less than the young stars.
  const thin = Math.exp(-(r - R0) / MODEL.thin.hR - Math.abs(z) / MODEL.thin.hz) * hole * (1 - MODEL.arms.old / 2 + MODEL.arms.old * arm);
  const thick = MODEL.thick.ratio * Math.exp(-(r - R0) / MODEL.thick.hR - Math.abs(z) / MODEL.thick.hz) * hole;
  const young = MODEL.arms.amplitude * arm * Math.exp(-(r - R0) / MODEL.arms.hR - Math.abs(z) / MODEL.arms.hz) * hole;
  return { thin, thick, young };
}

function barFrame(x: number, y: number): [number, number] {
  // Bar major axis: from the centre toward the near end, at positive longitudes.
  const c = Math.cos(BAR_ANGLE), s = Math.sin(BAR_ANGLE);
  const ax = -c, ay = s; // unit vector along the bar
  return [x * ax + y * ay, -x * ay + y * ax];
}

function bulgeShape(x: number, y: number, z: number): number {
  const [u, v] = barFrame(x, y);
  const b = MODEL.bulge;
  const rs = Math.pow((u / b.x0) ** 2 + (v / b.y0) ** 2, 2) + (z / b.z0) ** 4;
  return Math.exp(-0.5 * Math.sqrt(rs));
}

function barShape(x: number, y: number, z: number): number {
  const [u, v] = barFrame(x, y);
  const b = MODEL.bar;
  return Math.exp(-((u / b.x0) ** 4) - 0.5 * (v / b.y0) ** 2 - Math.abs(z) / b.z0);
}

/** Integral of f over a box (kpc^3), midpoint rule, result in pc^3 units. */
function integrate(f: (x: number, y: number, z: number) => number, hx: number, hy: number, hz: number, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    sum += f(-hx + ((i + 0.5) * 2 * hx) / n, -hy + ((j + 0.5) * 2 * hy) / n, -hz + ((k + 0.5) * 2 * hz) / n);
  }
  return (sum * (8 * hx * hy * hz) / n ** 3) * 1e9;
}

/** Normalisations (solar V luminosities per pc^3 for a shape value of 1). */
export const NORM = (() => {
  // The disc: its mean over the 100 pc around the Sun equals the catalogue's density.
  let sum = 0;
  let count = 0;
  const arm = armField(-R0, 0).arm;
  for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) for (let k = 0; k < 9; k++) {
    const dx = (i - 4) * 0.025, dy = (j - 4) * 0.025, dz = (k - 4) * 0.025;
    if (dx * dx + dy * dy + dz * dz > 0.01) continue;
    const p = discParts(-R0 + dx, dy, Z_SUN + dz, arm);
    sum += p.thin + p.thick + p.young;
    count++;
  }
  const disc = milkyWay.rhoLocal / (sum / count);
  const bulge = MODEL.bulge.luminosity / integrate(bulgeShape, 4, 4, 2.5, 40);
  const bar = MODEL.bar.luminosity / integrate(barShape, 7, 7, 1.2, 40);
  return { disc, bulge, bar };
})();

/** V-band luminosity density (solar luminosities per pc^3) at a galactocentric point (kpc). */
export function luminosityDensity(x: number, y: number, z: number): { disc: number; young: number; bulge: number; bar: number } {
  const p = discParts(x, y, z);
  return {
    disc: NORM.disc * (p.thin + p.thick),
    young: NORM.disc * p.young,
    bulge: NORM.bulge * bulgeShape(x, y, z),
    bar: NORM.bar * barShape(x, y, z),
  };
}

/** Total V luminosity (solar) of each component, and the Galaxy's absolute V magnitude. */
export function totalLuminosity(): { disc: number; bulge: number; bar: number; total: number; absMag: number } {
  // The disc in cylindrical shells (arms averaged out around each ring).
  let disc = 0;
  for (let r = 0.05; r < 30; r += 0.1) {
    let ring = 0;
    for (let a = 0; a < 72; a++) {
      const phi = (a / 72) * 2 * Math.PI;
      const x = r * Math.cos(phi), y = r * Math.sin(phi);
      const arm = armField(x, y).arm;
      // Vertical integral of exp(-|z|/h) is 2h.
      const p0 = discParts(x, y, 0, arm);
      ring += p0.thin * 2 * MODEL.thin.hz + p0.thick * 2 * MODEL.thick.hz + p0.young * 2 * MODEL.arms.hz;
    }
    disc += (ring / 72) * 2 * Math.PI * r * 0.1;
  }
  disc *= NORM.disc * 1e9;
  const bulge = MODEL.bulge.luminosity, bar = MODEL.bar.luminosity;
  const total = disc + bulge + bar;
  return { disc, bulge, bar, total, absMag: 4.83 - 2.5 * Math.log10(total) };
}

/** Fraction of the local stars' V light coming from stars brighter than absolute V `m`. */
export function lightBrighterThan(m: number): number {
  const { m0, step, cum } = milkyWay.lf;
  const f = (m - m0) / step;
  if (f <= 0) return 0;
  if (f >= cum.length - 1) return 1;
  const i = Math.floor(f);
  return cum[i] + (cum[i + 1] - cum[i]) * (f - i);
}

/** Surface brightness (V mag per square arcsecond) of a line-of-sight luminosity integral (Lsun/pc^2). */
export const surfaceBrightness = (integral: number) => 4.83 + 21.572 - 2.5 * Math.log10(integral);

export const LIGHT_FUNCTION = milkyWay.lf;
