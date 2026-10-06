import type { Vec3 } from './ephemeris';
import { skyBasis } from './galaxies';

/**
 * 3D models of the nearest galaxies (pipeline/build_galaxy_models.py): a Sersic bulge
 * (an oblate spheroid), a disc of stars whose face-on light comes from a deprojected
 * survey image, and a thinner dust layer. Lengths in kpc, light in units of the galaxy's
 * total as seen from Earth. The renderer (render/galaxymodels.ts) evaluates the same
 * volume in GLSL; keep the two in sync.
 */
export interface GalaxyModelSpec {
  name: string;
  survey: string;
  kind: 'disc' | 'spheroid';
  /** The nucleus (J2000, degrees), where the model is centred. */
  ra: number;
  dec: number;
  /** Position angle of the major axis east of north (degrees) and the axis ratio. */
  pa: number;
  q: number;
  /** Half-size of the model's box in its plane, and half its thickness (kpc). */
  R: number;
  H: number;
  bulge: {
    /** Fraction of the total light. */
    L: number;
    /** Effective radius (kpc), Sersic index, intrinsic axis ratio. */
    re: number;
    n: number;
    q0: number;
    /** Linear RGB, unit luminance. */
    colour: [number, number, number];
    /** Prugniel-Simien deprojection: rho = rho0 s^-p exp(-b s^(1/n)), s = m / re. */
    p: number;
    b: number;
    rho0: number;
  };
  /** Disc: sech^2 scale heights of the stars, the dust and the thin layer (kpc; zy is zd if absent). */
  z0?: number;
  zd?: number;
  zy?: number;
  /** Smooth dust: face-on central optical depth (V) and scale length (kpc). */
  tau0?: number;
  hd?: number;
  /** Radius of the smooth dust's central hole (kpc), where a bulge has cleared it; 0 for none. */
  dh?: number;
  /** Stars' scale length (kpc). */
  h?: number;
  /** +1 when the side of the disc toward the sky's +minor axis (PA + 90) is the nearer one. */
  near?: number;
  edgeOn?: boolean;
  cosi?: number;
  /** Face-on light (square-root encoded), and its peak value (per kpc^2). */
  file?: string;
  light?: number;
  size?: [number, number];
  /** The disc's total light (dust removed). */
  discL?: number;
  /**
   * Face-on optical depth of the lanes (red, square-root encoded; tauMax its peak) and
   * the fraction of the light in the thin, dusty layer (green: knots and fine structure).
   */
  dust?: string;
  tauMax?: number;
  /** An interacting companion cut out of this galaxy's picture: it sits at its distance. */
  with?: string;
}

/** The model's axes in ICRS: x along the major axis, y in the plane, z its normal. */
export interface ModelAxes {
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export function modelAxes(spec: GalaxyModelSpec, centre: Vec3): ModelAxes {
  const { s, east, north } = skyBasis(centre);
  const pa = (spec.pa * Math.PI) / 180;
  const major: Vec3 = [0, 1, 2].map((k) => Math.cos(pa) * north[k] + Math.sin(pa) * east[k]) as Vec3;
  const minor: Vec3 = [0, 1, 2].map((k) => -Math.sin(pa) * north[k] + Math.cos(pa) * east[k]) as Vec3;
  const cosI = spec.kind === 'spheroid' ? 0 : spec.cosi ?? 1;
  const sinI = Math.sqrt(1 - cosI * cosI);
  // The +y half of the disc is seen toward +minor; it lies beyond the centre (along s,
  // away from Earth) unless it is the near side.
  const depth = spec.near === 1 ? -1 : 1;
  const y: Vec3 = [0, 1, 2].map((k) => cosI * minor[k] + depth * sinI * s[k]) as Vec3;
  return { x: major, y, z: cross(major, y) };
}

/**
 * Face-on maps for the CPU model: light (per kpc^2, luminance), the part of it in the
 * thin layer, and lane optical depth.
 */
export interface FaceMaps {
  width: number;
  height: number;
  light: Float32Array;
  young?: Float32Array;
  tau: Float32Array;
}

const sech2 = (x: number) => {
  const c = Math.cosh(Math.min(Math.abs(x), 40));
  return 1 / (c * c);
};

/** Bilinear sample of a map covering [-R, R]^2 (row 0 at +y). */
function sample(map: Float32Array, w: number, h: number, R: number, x: number, y: number): number {
  const u = ((x / R) * 0.5 + 0.5) * w - 0.5;
  const v = ((-y / R) * 0.5 + 0.5) * h - 0.5;
  if (u < -0.5 || v < -0.5 || u > w - 0.5 || v > h - 0.5) return 0;
  const i = Math.min(Math.max(Math.floor(u), 0), w - 2), j = Math.min(Math.max(Math.floor(v), 0), h - 2);
  const fu = Math.min(Math.max(u - i, 0), 1), fv = Math.min(Math.max(v - j, 0), 1);
  const a = map[j * w + i], b = map[j * w + i + 1], c = map[(j + 1) * w + i], d = map[(j + 1) * w + i + 1];
  return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
}

/**
 * The bulge fades out inside the model's box (an ellipsoid touching its faces), so a
 * Sersic profile's long wings don't end at the box's flat sides.
 */
export function bulgeTaper(spec: GalaxyModelSpec, p: Vec3): number {
  const e = Math.hypot(p[0] / spec.R, p[1] / spec.R, p[2] / spec.H);
  const t = Math.min(Math.max((e - 0.7) / 0.3, 0), 1);
  return 1 - t * t * (3 - 2 * t);
}

/** Light emitted per kpc^3 (luminance) and dust opacity per kpc at a point (model frame, kpc). */
export function modelDensity(spec: GalaxyModelSpec, maps: FaceMaps | undefined, p: Vec3): { j: number; kappa: number } {
  const b = spec.bulge;
  const m = Math.hypot(p[0], p[1], p[2] / b.q0) / b.re;
  const s = Math.max(m, 1e-3);
  let j = b.rho0 * s ** -b.p * Math.exp(-b.b * s ** (1 / b.n)) * bulgeTaper(spec, p);
  let kappa = 0;
  if (spec.kind === 'disc' && maps) {
    const z0 = spec.z0!, zd = spec.zd!;
    const all = sample(maps.light, maps.width, maps.height, spec.R, p[0], p[1]);
    const thin = maps.young ? sample(maps.young, maps.width, maps.height, spec.R, p[0], p[1]) : 0;
    const zy = spec.zy ?? zd;
    j += ((all - thin) * sech2(p[2] / z0)) / (2 * z0) + (thin * sech2(p[2] / zy)) / (2 * zy);
    const r = Math.hypot(p[0], p[1]);
    const hole = spec.dh ? 1 - Math.exp(-((r / spec.dh) ** 2)) : 1;
    const tau = sample(maps.tau, maps.width, maps.height, spec.R, p[0], p[1]) + spec.tau0! * Math.exp(-r / spec.hd!) * hole;
    kappa = (tau * sech2(p[2] / zd)) / (2 * zd);
  }
  return { j, kappa };
}

/**
 * Light along a ray through the model (per kpc^2 of the view plane, units of the total
 * light), from `origin` along unit `dir` (model frame), stepping as the shader does.
 */
export function integrateRay(spec: GalaxyModelSpec, maps: FaceMaps | undefined, origin: Vec3, dir: Vec3, steps = 400): number {
  const [t0, t1] = boxSpan(spec, origin, dir);
  if (t1 <= t0) return 0;
  let light = 0, trans = 1;
  const dt = (t1 - t0) / steps;
  for (let k = 0; k < steps; k++) {
    const t = t0 + (k + 0.5) * dt;
    const { j, kappa } = modelDensity(spec, maps, [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t]);
    const a = kappa * dt;
    light += trans * j * dt * (a > 1e-4 ? (1 - Math.exp(-a)) / a : 1);
    trans *= Math.exp(-a);
  }
  return light;
}

/** Where a ray is inside the model's box: [t0, t1]. */
export function boxSpan(spec: GalaxyModelSpec, o: Vec3, d: Vec3): [number, number] {
  const half = [spec.R, spec.R, spec.H];
  let t0 = 0, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (Math.abs(o[k]) > half[k]) return [1, 0];
      continue;
    }
    const a = (-half[k] - o[k]) / d[k], b = (half[k] - o[k]) / d[k];
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return [t0, t1];
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
