/**
 * Planetary positions from JPL Chebyshev coefficients (SPK type 2), converted by
 * pipeline/build_ephemeris.py. All positions are km in the ICRF frame, relative to
 * the Solar System Barycenter (NAIF id 0), at a TDB epoch in seconds past J2000.
 *
 * Moons and asteroids come in extra files (pipeline/build_moons.py, format version 2,
 * float32 coefficients) that are added once loaded; until then a planet's centre falls
 * back to its system barycentre.
 */

export type Vec3 = [number, number, number];

interface Segment {
  center: number;
  target: number;
  init: number;
  intlen: number;
  ncoef: number;
  nrec: number;
  coef: Float64Array | Float32Array;
}

const MAGIC = 0x48504553; // "SEPH" little-endian
const HEADER_BYTES = 16;
const SEGMENT_BYTES = 40;

export class Ephemeris {
  private readonly byTarget = new Map<number, Segment>();
  /** Bodies stored at their system's barycentre, moved off it by a satellite's pull. */
  private readonly barycentres = new Map<number, { satellite: number; ratio: number }>();
  readonly start: number;
  readonly end: number;

  constructor(buffer: ArrayBuffer) {
    let start = -Infinity;
    let end = Infinity;
    for (const seg of parse(buffer)) {
      this.byTarget.set(seg.target, seg);
      start = Math.max(start, seg.init);
      end = Math.min(end, seg.init + seg.nrec * seg.intlen);
    }
    this.start = start;
    this.end = end;
  }

  /** Add the segments of another file (moons, asteroids). Returns the bodies added. */
  add(buffer: ArrayBuffer): number[] {
    const added: number[] = [];
    for (const seg of parse(buffer)) {
      this.byTarget.set(seg.target, seg);
      added.push(seg.target);
    }
    return added;
  }

  /**
   * `primary`'s segment holds its system's barycentre; `satellite`'s is relative to the
   * primary. The primary then sits at barycentre - ratio * satellite (ratio = the
   * satellite's share of the mass), where the satellite's segment covers the epoch.
   */
  setBarycentre(primary: number, satellite: number, ratio: number): void {
    this.barycentres.set(primary, { satellite, ratio });
  }

  static async fetch(url: string): Promise<ArrayBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ephemeris ${url}: ${res.status}`);
    return res.arrayBuffer();
  }

  static async load(url: string): Promise<Ephemeris> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ephemeris ${url}: ${res.status}`);
    return new Ephemeris(await res.arrayBuffer());
  }

  has(target: number): boolean {
    return target === 0 || this.byTarget.has(target);
  }

  /**
   * True if `position(target)` can be computed: the whole chain to the barycentre is
   * loaded and, if `tdb` is given, covers that epoch.
   */
  available(target: number, tdb?: number): boolean {
    const [start, end] = this.coverage(target);
    return tdb === undefined ? start <= end : tdb >= start && tdb <= end;
  }

  /** TDB range over which `position(target)` works; empty (start > end) if not loaded. */
  coverage(target: number): [number, number] {
    let start = -Infinity, end = Infinity;
    let body = target;
    for (let guard = 0; guard < 10 && body !== 0; guard++) {
      const seg = this.byTarget.get(body);
      if (!seg && body > 100 && body < 1000 && body % 100 === 99) {
        body = (body - 99) / 100;
        continue;
      }
      if (!seg) return [1, 0];
      start = Math.max(start, seg.init);
      end = Math.min(end, seg.init + seg.nrec * seg.intlen);
      body = seg.center;
    }
    return body === 0 ? [start, end] : [1, 0];
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
      // DE440 has no Mars-centre segment; Mars sits about 20 cm from its system
      // barycentre (Phobos and Deimos are tiny), so the barycentre stands in for it.
      if (!seg && body > 100 && body < 1000 && body % 100 === 99) {
        body = (body - 99) / 100;
        continue;
      }
      if (!seg) throw new Error(`No ephemeris chain from body ${target} to the barycenter`);
      this.segmentPosition(body, tdb, step);
      out[0] += step[0];
      out[1] += step[1];
      out[2] += step[2];
      const bary = this.barycentres.get(body);
      const sat = bary && this.byTarget.get(bary.satellite);
      if (bary && sat && tdb >= sat.init && tdb <= sat.init + sat.nrec * sat.intlen) {
        this.segmentPosition(bary.satellite, tdb, step);
        for (let k = 0; k < 3; k++) out[k] -= bary.ratio * step[k];
      }
      body = seg.center;
    }
    return out;
  }
}

function parse(buffer: ArrayBuffer): Segment[] {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('Not a SEPH ephemeris file');
  const version = view.getUint32(4, true);
  if (version !== 1 && version !== 2) throw new Error('Unsupported SEPH version');
  const count = view.getUint32(8, true);
  const segments: Segment[] = [];
  for (let i = 0; i < count; i++) {
    const at = HEADER_BYTES + i * SEGMENT_BYTES;
    const ncoef = view.getUint32(at + 24, true);
    const nrec = view.getUint32(at + 28, true);
    const offset = view.getUint32(at + 32, true);
    const n = nrec * 3 * ncoef;
    segments.push({
      center: view.getInt32(at, true),
      target: view.getInt32(at + 4, true),
      init: view.getFloat64(at + 8, true),
      intlen: view.getFloat64(at + 16, true),
      ncoef,
      nrec,
      // Version 2 stores float32 coefficients (moons: about 7 significant digits).
      coef: version === 1 ? new Float64Array(buffer, offset, n) : new Float32Array(buffer, offset, n),
    });
  }
  return segments;
}
