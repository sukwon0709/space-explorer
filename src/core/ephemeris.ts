/**
 * Planetary positions from JPL Chebyshev coefficients (SPK type 2), converted by
 * pipeline/build_ephemeris.py. All positions are km in the ICRF frame, relative to
 * the Solar System Barycenter (NAIF id 0), at a TDB epoch in seconds past J2000.
 */

export type Vec3 = [number, number, number];

interface Segment {
  center: number;
  target: number;
  init: number;
  intlen: number;
  ncoef: number;
  nrec: number;
  coef: Float64Array;
}

const MAGIC = 0x48504553; // "SEPH" little-endian
const HEADER_BYTES = 16;
const SEGMENT_BYTES = 40;

export class Ephemeris {
  private readonly byTarget = new Map<number, Segment>();
  readonly start: number;
  readonly end: number;

  constructor(buffer: ArrayBuffer) {
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== MAGIC) throw new Error('Not a SEPH ephemeris file');
    if (view.getUint32(4, true) !== 1) throw new Error('Unsupported SEPH version');
    const count = view.getUint32(8, true);

    let start = -Infinity;
    let end = Infinity;
    for (let i = 0; i < count; i++) {
      const at = HEADER_BYTES + i * SEGMENT_BYTES;
      const ncoef = view.getUint32(at + 24, true);
      const nrec = view.getUint32(at + 28, true);
      const offset = view.getUint32(at + 32, true);
      const seg: Segment = {
        center: view.getInt32(at, true),
        target: view.getInt32(at + 4, true),
        init: view.getFloat64(at + 8, true),
        intlen: view.getFloat64(at + 16, true),
        ncoef,
        nrec,
        coef: new Float64Array(buffer, offset, nrec * 3 * ncoef),
      };
      this.byTarget.set(seg.target, seg);
      start = Math.max(start, seg.init);
      end = Math.min(end, seg.init + nrec * seg.intlen);
    }
    this.start = start;
    this.end = end;
  }

  static async load(url: string): Promise<Ephemeris> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ephemeris ${url}: ${res.status}`);
    return new Ephemeris(await res.arrayBuffer());
  }

  has(target: number): boolean {
    return target === 0 || this.byTarget.has(target);
  }

  /** Position of `target` relative to its segment's center, as stored by JPL. */
  segmentPosition(target: number, tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const seg = this.byTarget.get(target);
    if (!seg) throw new Error(`No ephemeris for body ${target}`);
    const { init, intlen, ncoef, nrec, coef } = seg;

    let index = Math.floor((tdb - init) / intlen);
    if (index < 0 || index > nrec || (index === nrec && tdb > init + nrec * intlen)) {
      throw new RangeError(`Epoch ${tdb} outside ephemeris range for body ${target}`);
    }
    if (index === nrec) index -= 1; // exact end of the last record
    const s = (2 * (tdb - (init + index * intlen))) / intlen - 1;
    const base = index * 3 * ncoef;

    // Clenshaw recurrence, the same evaluation SPICE uses.
    for (let axis = 0; axis < 3; axis++) {
      const row = base + axis * ncoef;
      let b1 = 0;
      let b2 = 0;
      for (let k = ncoef - 1; k >= 1; k--) {
        const b0 = 2 * s * b1 - b2 + coef[row + k];
        b2 = b1;
        b1 = b0;
      }
      out[axis] = s * b1 - b2 + coef[row];
    }
    return out;
  }

  /** Position of `target` relative to the Solar System Barycenter, following the segment chain. */
  position(target: number, tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    out[0] = out[1] = out[2] = 0;
    const step: Vec3 = [0, 0, 0];
    let body = target;
    while (body !== 0) {
      const seg = this.byTarget.get(body);
      if (!seg) throw new Error(`No ephemeris chain from body ${target} to the barycenter`);
      this.segmentPosition(body, tdb, step);
      out[0] += step[0];
      out[1] += step[1];
      out[2] += step[2];
      body = seg.center;
    }
    return out;
  }
}
