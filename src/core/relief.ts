/**
 * Relief finer than a world's elevation model, computed where the data runs out so the
 * ground stays rough and believable on foot. It is not a measurement: the shapes are
 * noise and dunes, but their sizes come from measurements where there are any.
 *
 * - Rock: self-affine noise (fractional Brownian motion), the statistics of lava plains
 *   and broken ground on every rocky world. Amplitude grows with wavelength as
 *   lambda^HURST and is set by the RMS slope at metre scales, which Magellan measured
 *   for all of Venus (red channel of the world's relief map, 0-1 = 1.5-11.5 degrees).
 * - Dunes (Titan): linear dunes like the Namib's, 3 km apart and about 100 m high,
 *   crests running east-west (Lorenz et al. 2006, Science; Neish et al. 2010), where the
 *   relief map's green channel says the dark dune seas are.
 *
 * Detail is band-limited to the mesh: only wavelengths of at least two vertex spacings
 * are added, so a coarse tile carries the long waves and a fine one adds the short.
 */

export interface ReliefMap {
  width: number;
  height: number;
  /** RGBA bytes, rows from 90 N, columns from 180 W. */
  data: Uint8Array | Uint8ClampedArray;
}

export interface ReliefParams {
  /** Radius of the world, km. */
  radius: number;
  /** Longest wavelength added, km: about twice the elevation model's cell. */
  maxWavelength: number;
  /** Dune spacing (km) and height (km), if the world has dune seas. */
  dunes?: { spacing: number; height: number };
}

const DEG = Math.PI / 180;
const HURST = 0.8;
const MIN_WAVELENGTH = 0.002; // 2 m: below this the shader's grain takes over

/** Bilinear sample of one channel (0-1) at lon/lat degrees. */
export function sampleRelief(map: ReliefMap, channel: number, lon: number, lat: number): number {
  const fx = ((lon + 180) / 360) * map.width - 0.5;
  const fy = ((90 - lat) / 180) * map.height - 0.5;
  const x0 = Math.floor(fx), y0 = Math.max(0, Math.min(map.height - 2, Math.floor(fy)));
  const tx = fx - x0, ty = Math.max(0, Math.min(1, fy - y0));
  const at = (x: number, y: number) => map.data[(y * map.width + (((x % map.width) + map.width) % map.width)) * 4 + channel] / 255;
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

// ---- 3D gradient noise (Perlin's improved noise), deterministic, range about -1..1.
const PERM = new Uint8Array(512);
{
  let seed = 2024;
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const j = seed % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
function grad(h: number, x: number, y: number, z: number): number {
  const u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}
export function noise3(x: number, y: number, z: number): number {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const X = fx & 255, Y = fy & 255, Z = fz & 255;
  x -= fx; y -= fy; z -= fz;
  const u = fade(x), v = fade(y), w = fade(z);
  const A = PERM[X] + Y, AA = PERM[A] + Z, AB = PERM[A + 1] + Z, B = PERM[X + 1] + Y, BA = PERM[B] + Z, BB = PERM[B + 1] + Z;
  const lerp = (t: number, a: number, b: number) => a + t * (b - a);
  return lerp(w,
    lerp(v, lerp(u, grad(PERM[AA] & 15, x, y, z), grad(PERM[BA] & 15, x - 1, y, z)), lerp(u, grad(PERM[AB] & 15, x, y - 1, z), grad(PERM[BB] & 15, x - 1, y - 1, z))),
    lerp(v, lerp(u, grad(PERM[AA + 1] & 15, x, y, z - 1), grad(PERM[BA + 1] & 15, x - 1, y, z - 1)), lerp(u, grad(PERM[AB + 1] & 15, x, y - 1, z - 1), grad(PERM[BB + 1] & 15, x - 1, y - 1, z - 1))));
}

/**
 * Height (km) to add at lon/lat (degrees) on a mesh whose vertices are `spacing` km
 * apart. Zero-mean, so the elevation model's heights stay the average.
 */
export function reliefHeight(map: ReliefMap, params: ReliefParams, lon: number, lat: number, spacing: number): number {
  const R = params.radius;
  const cl = Math.cos(lat * DEG);
  const ux = cl * Math.cos(lon * DEG), uy = cl * Math.sin(lon * DEG), uz = Math.sin(lat * DEG);
  const shortest = Math.max(MIN_WAVELENGTH, 2 * spacing);
  let h = 0;

  // Rock. RMS slope s at 1 m: the RMS height difference across L metres is s L^H.
  if (shortest < params.maxWavelength) {
    const rough = sampleRelief(map, 0, lon, lat);
    const slope = Math.tan((1.5 + 10 * rough) * DEG);
    let octave = 0;
    for (let L = params.maxWavelength; L >= shortest; L /= 2, octave++) {
      const k = R / L;
      // Each octave gets its own offset so the layers do not line up.
      const n = noise3(ux * k + octave * 17.3, uy * k - octave * 9.1, uz * k + octave * 5.7);
      const amp = (slope * (L * 1000) ** HURST) / 1000;
      // Fade the octave in over its first factor of two so refining a tile does not pop.
      const w = Math.min(1, Math.max(0, L / shortest - 1));
      h += amp * n * w;
    }
  }

  // Dunes, where they are and where the mesh can show them.
  const d = params.dunes;
  if (d && spacing < d.spacing / 2) {
    const cover = sampleRelief(map, 1, lon, lat);
    if (cover > 0.01) {
      // Crests along east-west with long sinuous wanders and occasional junctions.
      const k = R / 40;
      const wander = 2.2 * noise3(ux * k, uy * k, uz * k) + 0.6 * noise3(ux * k * 4 + 3, uy * k * 4, uz * k * 4);
      const phase = (R * lat * DEG) / d.spacing + wander;
      const f = phase - Math.floor(phase);
      // Asymmetric profile: a gentle stoss slope and a steeper lee, crest sharpened.
      const s = f < 0.6 ? f / 0.6 : (1 - f) / 0.4;
      const profile = s * s * (3 - 2 * s);
      const kk = R / 15;
      const size = 0.75 + 0.25 * noise3(ux * kk + 7, uy * kk, uz * kk);
      const fadeIn = Math.min(1, (d.spacing / 2 - spacing) / (d.spacing / 4));
      h += d.height * (profile - 0.5) * size * Math.min(1, cover * 1.5) * fadeIn;
    }
  }
  return h;
}
