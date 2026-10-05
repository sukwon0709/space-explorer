import type { Vec3 } from './ephemeris';
import { type BlackHole, gravRadius, skyBasis } from './blackholes';
import { criticalCurve, flowIntensity, photonFromCamera } from './kerr';

/**
 * The black hole's frame in ICRS: z along the spin, x in the plane of the spin and
 * our line of sight (pointing away from us), y = z cross x.
 */
export function holeBasis(bh: BlackHole): { x: Vec3; y: Vec3; z: Vec3 } {
  const z = bh.axis;
  const { n } = skyBasis(bh.ra, bh.dec);
  let x: Vec3 = [n[0] - z[0] * dot(n, z), n[1] - z[1] * dot(n, z), n[2] - z[2] * dot(n, z)];
  if (Math.hypot(...x) < 1e-6) x = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  x = normalise(x);
  return { x, y: cross(z, x), z };
}

/** ICRS vector into the hole's frame. */
export function toHole(b: { x: Vec3; y: Vec3; z: Vec3 }, v: Vec3): Vec3 {
  return [dot(b.x, v), dot(b.y, v), dot(b.z, v)];
}

/** Microarcseconds to radians. */
const UAS = Math.PI / 180 / 3600 / 1e6;

/**
 * The hot flow's 230 GHz image as seen from Earth, n x n pixels over `field`
 * microarcseconds, north up and east left. Rays start 1,000 M out (so angles are
 * those at infinity to 0.1%).
 */
export function modelImage(bh: BlackHole, n: number, field: number, eps = 0.03): Float64Array {
  const b = holeBasis(bh);
  const { n: los, north, east } = skyBasis(bh.ra, bh.dec);
  const R = 1000;
  // Camera on the Earth side of the hole, looking along the line of sight.
  const cam = toHole(b, [-los[0] * R, -los[1] * R, -los[2] * R]);
  const fwd = toHole(b, los), up = toHole(b, north), left = toHole(b, east);
  const mPerUas = (UAS * bh.dist * 3.0856775814913673e13) / gravRadius(bh); // M per microarcsecond at the hole
  const out = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // Pixel centres: x to the west (right), y to the north (up).
      const ux = ((i + 0.5) / n - 0.5) * field, uy = (0.5 - (j + 0.5) / n) * field;
      const ax = (-ux * mPerUas) / R, ay = (uy * mPerUas) / R;
      const d: Vec3 = normalise([fwd[0] + ax * left[0] + ay * up[0], fwd[1] + ax * left[1] + ay * up[1], fwd[2] + ax * left[2] + ay * up[2]]);
      out[j * n + i] = flowIntensity(photonFromCamera(bh.spin, cam, d), { eps }).intensity;
    }
  }
  return out;
}

/** Gaussian blur with the given full width at half maximum (pixels). */
export function blur(img: Float64Array, n: number, fwhm: number): Float64Array {
  const sigma = fwhm / 2.3548;
  const r = Math.ceil(3 * sigma);
  const k: number[] = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-0.5 * (i / sigma) ** 2));
  const sum = k.reduce((a, v) => a + v, 0);
  const pass = (src: Float64Array, horizontal: boolean) => {
    const dst = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let t = -r; t <= r; t++) {
          const x = horizontal ? i + t : i, y = horizontal ? j : j + t;
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          acc += src[y * n + x] * k[t + r];
        }
        dst[j * n + i] = acc / sum;
      }
    }
    return dst;
  };
  return pass(pass(img, true), false);
}

/**
 * Ring diameter as the EHT measures it on an image (like their REx method): the radius
 * of peak brightness along spokes from a centre, with the centre placed where those
 * radii vary least; twice their mean (in the units of `field`).
 */
export function ringDiameter(img: Float64Array, n: number, field: number, spokes = 72): number {
  const sample = (x: number, y: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const at = (i: number, j: number) => (i < 0 || j < 0 || i >= n || j >= n ? 0 : img[j * n + i]);
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  };
  const radii = (cx: number, cy: number) => {
    const out: number[] = [];
    for (let s = 0; s < spokes; s++) {
      const ang = (2 * Math.PI * s) / spokes;
      let best = -1, bestR = 0;
      for (let r = 0.5; r < n / 2; r += 0.1) {
        const v = sample(cx + r * Math.cos(ang), cy + r * Math.sin(ang));
        if (v > best) { best = v; bestR = r; }
      }
      out.push(bestR);
    }
    return out;
  };
  const spread = (rs: number[]) => {
    const m = rs.reduce((a, v) => a + v, 0) / rs.length;
    return Math.sqrt(rs.reduce((a, v) => a + (v - m) ** 2, 0) / rs.length);
  };
  // Coarse then fine search for the centre around the image's middle, among points in
  // the ring's dim interior (less than half its peak brightness).
  const max = img.reduce((m, v) => Math.max(m, v), 0);
  let cx = (n - 1) / 2, cy = (n - 1) / 2;
  for (const step of [n / 16, n / 64, n / 256]) {
    let best = Infinity, bx = cx, by = cy;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      if (sample(cx + dx * step, cy + dy * step) > 0.5 * max) continue;
      const sd = spread(radii(cx + dx * step, cy + dy * step));
      if (sd < best) { best = sd; bx = cx + dx * step; by = cy + dy * step; }
    }
    cx = bx; cy = by;
  }
  const rs = radii(cx, cy);
  return (2 * rs.reduce((a, v) => a + v, 0) / rs.length) * (field / n);
}

/** The shadow's edge (critical curve) seen from Earth: mean diameter in microarcseconds. */
export function shadowDiameter(bh: BlackHole, inclination: number): number {
  const pts = criticalCurve(bh.spin, Math.max(1e-3, Math.min(Math.PI - 1e-3, inclination)), 720);
  // Mean diameter as twice the mean distance from the curve's centroid.
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const mean = pts.reduce((a, p) => a + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length;
  const uasPerM = gravRadius(bh) / (bh.dist * 3.0856775814913673e13) / UAS;
  return 2 * mean * uasPerM;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalise = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
