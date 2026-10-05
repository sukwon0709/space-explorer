import { Ephemeris } from './ephemeris';
import { OBLIQUITY_J2000 } from './frames';

/** 3x3 rotation, row-major. */
export type Mat3 = Float64Array;

/**
 * Body orientation from NAIF kernels, converted by pipeline/build_orientation.py:
 * Earth in ITRF93 (measured UT1, polar motion, precession and nutation) and the Moon in
 * MOON_ME, the frame LOLA and LROC maps are registered in. The file stores 3-1-3 Euler
 * angles as Chebyshev series in the ephemeris file layout, so the same evaluator reads it.
 */
export class Orientation {
  readonly start: number;
  readonly end: number;
  private readonly angles: [number, number, number] = [0, 0, 0];

  constructor(private readonly series: Ephemeris) {
    this.start = series.start;
    this.end = series.end;
  }

  static async load(url: string): Promise<Orientation> {
    return new Orientation(await Ephemeris.load(url));
  }

  has(body: number): boolean {
    return body !== 0 && this.series.has(body);
  }

  /** Rotation taking ICRF vectors into the body-fixed frame at a TDB epoch. */
  icrfToBody(body: number, tdb: number, out: Mat3 = new Float64Array(9)): Mat3 {
    const [phi, theta, psi] = this.series.segmentPosition(body, tdb, this.angles);
    // R3(psi) R1(theta) R3(phi), frame-rotation convention (as SPICE's eul2m).
    const cf = Math.cos(phi), sf = Math.sin(phi);
    const ct = Math.cos(theta), st = Math.sin(theta);
    const cp = Math.cos(psi), sp = Math.sin(psi);
    out[0] = cp * cf - sp * ct * sf;
    out[1] = cp * sf + sp * ct * cf;
    out[2] = sp * st;
    out[3] = -sp * cf - cp * ct * sf;
    out[4] = -sp * sf + cp * ct * cf;
    out[5] = cp * st;
    out[6] = st * sf;
    out[7] = -st * cf;
    out[8] = ct;
    return out;
  }

  /** Rotation taking body-fixed vectors into scene axes (ecliptic J2000, y up). */
  bodyToScene(body: number, tdb: number, out: Mat3 = new Float64Array(9)): Mat3 {
    const m = this.icrfToBody(body, tdb, scratch);
    // scene = S * m^T, with S the ICRF-to-scene rotation from frames.ts.
    for (let j = 0; j < 3; j++) {
      const x = m[j * 3], y = m[j * 3 + 1], z = m[j * 3 + 2]; // column j of m^T
      out[j] = x;
      out[3 + j] = -SIN_E * y + COS_E * z;
      out[6 + j] = -(COS_E * y + SIN_E * z);
    }
    return out;
  }
}

const COS_E = Math.cos(OBLIQUITY_J2000);
const SIN_E = Math.sin(OBLIQUITY_J2000);
const scratch = new Float64Array(9);
