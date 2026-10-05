import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/ephemeris';
import { Cosmology, decodeGalaxies, galaxyPosition, raDecDistance, type GalaxyIndex } from '../src/core/galaxies';
import { CLUSTER_ID, DeepSky, GALAXY_ID, LOCAL_GROUP_ID, MILKY_WAY_ID } from '../src/deepsky';
import { R0, galactocentricToIcrsPc, icrsPcToGalactocentric, totalLuminosity } from '../src/core/milkyway';

/**
 * The milestone 5 gate: Andromeda and the Virgo Cluster sit at their measured distances.
 *
 * The app's galaxy catalogue (pipeline/build_galaxies.py, from UNGC, Cosmicflows-4,
 * 2MRS, 6dFGS and SDSS) is loaded as the app loads it, and the positions the app draws
 * (DeepSky, the same code the renderer uses) are compared with independent published
 * distances (tests/fixtures/galaxy-reference.json) that the pipeline does not read: HST
 * Cepheids for M31, eclipsing binaries for the LMC, and the ACS surface brightness
 * fluctuation surveys of the Virgo and Fornax clusters. The comparison also replays the
 * galaxy shader's float32 arithmetic.
 */

const ARCSEC = Math.PI / 180 / 3600;
const read = (path: string) => readFileSync(new URL(`../public/data/${path}`, import.meta.url));
const asBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

interface Reference {
  galaxies: Array<{ name: string; ra: number; dec: number; distMpc: number; sigmaMpc: number; source: string; positionTolerance?: number }>;
  clusters: Array<{ name: string; distMpc: number; sigmaMpc: number; source: string }>;
}
const reference: Reference = JSON.parse(readFileSync(new URL('./fixtures/galaxy-reference.json', import.meta.url), 'utf8'));
const index: GalaxyIndex = JSON.parse(read('galaxies/index.json').toString('utf8'));
const localBuffer = asBuffer(read('galaxies/local.bin'));
const deep = new DeepSky(index, localBuffer, [], 1, 1, '', '');
const cosmology = new Cosmology(index.H0, index.omegaM);
const idOf = (name: string) => {
  const t = deep.targets.find((t) => t.name === name);
  if (!t) throw new Error(`${name} is not a target`);
  return t.id;
};
/** Luminosity distance of a drawn (comoving) position. */
const luminosityDistance = (p: Vec3) => {
  const dc = Math.hypot(p[0], p[1], p[2]);
  return dc * (1 + cosmology.redshift(dc));
};
const separation = (a: Vec3, b: Vec3) => {
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
  return Math.acos(Math.min(1, d));
};
const direction = (ra: number, dec: number): Vec3 => {
  const r = (ra * Math.PI) / 180, d = (dec * Math.PI) / 180;
  return [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)];
};

describe('galaxies sit at their measured distances', () => {
  for (const ref of reference.galaxies) {
    it(`${ref.name}: ${ref.distMpc} ± ${ref.sigmaMpc} Mpc (${ref.source})`, () => {
      const p = deep.positionMpc(idOf(ref.name));
      const d = luminosityDistance(p);
      expect(Math.abs(d - ref.distMpc) / ref.sigmaMpc).toBeLessThan(2);
      expect(separation(p, direction(ref.ra, ref.dec)) / ARCSEC).toBeLessThan(ref.positionTolerance ?? 60);
    });
  }
  for (const ref of reference.clusters) {
    it(`${ref.name}: ${ref.distMpc} ± ${ref.sigmaMpc} Mpc (${ref.source})`, () => {
      const id = idOf(ref.name);
      expect(id).toBeGreaterThanOrEqual(CLUSTER_ID);
      const d = luminosityDistance(deep.positionMpc(id));
      expect(Math.abs(d - ref.distMpc) / ref.sigmaMpc).toBeLessThan(2);
    });
  }

  it('Andromeda is about 2.5 million light years away, its light that old', () => {
    const p = deep.positionMpc(idOf('Andromeda Galaxy'));
    const ly = cosmology.lightTravelYears(Math.hypot(...p));
    expect(ly).toBeGreaterThan(2.4e6);
    expect(ly).toBeLessThan(2.6e6);
  });

  it('the Local Group centre lies between the Milky Way and Andromeda', () => {
    const lg = deep.positionMpc(LOCAL_GROUP_ID);
    const mw = deep.positionMpc(MILKY_WAY_ID);
    const m31 = deep.positionMpc(idOf('Andromeda Galaxy'));
    const a = Math.hypot(lg[0] - mw[0], lg[1] - mw[1], lg[2] - mw[2]);
    const b = Math.hypot(lg[0] - m31[0], lg[1] - m31[1], lg[2] - m31[2]);
    const ab = Math.hypot(m31[0] - mw[0], m31[1] - mw[1], m31[2] - mw[2]);
    expect(a + b).toBeCloseTo(ab, 9);
    expect(a / ab).toBeCloseTo(0.55, 9);
  });
});

describe('the drawn catalogue', () => {
  const block = decodeGalaxies(localBuffer, index.local);

  it('places every redshift-only galaxy in front of the microwave background', () => {
    const p: Vec3 = [0, 0, 0];
    let far = 0;
    for (let i = 0; i < block.count; i++) far = Math.max(far, Math.hypot(...galaxyPosition(block, i, p)));
    expect(far).toBeLessThan(cosmology.lastScattering);
    // Last scattering is about 3.2 Hubble distances away: 12,800 comoving Mpc with the
    // Cosmicflows-4 H0 of 74.6 (14,000 Mpc, 46 billion light years, with Planck's 67.4).
    expect(cosmology.lastScattering * index.H0 / 299792.458).toBeGreaterThan(3.1);
    expect(cosmology.lastScattering * index.H0 / 299792.458).toBeLessThan(3.3);
  });

  it('replays the shader in float32 to within a pixel', () => {
    // The point shader: rel = (position - camHigh) - camLow, all float32, then normalised.
    const f = Math.fround;
    const PIXELS_PER_RADIAN = 3840 / ((50 * Math.PI) / 180);
    const m31 = deep.positionMpc(idOf('Andromeda Galaxy'));
    const cameras: Vec3[] = [
      [1e-11, -2e-12, 4e-12], // near Earth
      [m31[0] + 0.004, m31[1] - 0.002, m31[2] + 0.001], // a few kpc from M31
      [12, 3, 8], // in the Virgo direction
    ];
    let worst = 0;
    for (const cam of cameras) {
      const high = cam.map(f) as Vec3;
      const low = cam.map((c, k) => f(c - high[k])) as Vec3;
      for (let i = 0; i < block.count; i += 7) {
        const px = block.position[i * 3], py = block.position[i * 3 + 1], pz = block.position[i * 3 + 2];
        const exact: Vec3 = [px - cam[0], py - cam[1], pz - cam[2]];
        const d = Math.hypot(...exact);
        if (d < 1e-3) continue;
        const gpu: Vec3 = [f(f(px - high[0]) - low[0]), f(f(py - high[1]) - low[1]), f(f(pz - high[2]) - low[2])];
        worst = Math.max(worst, separation(gpu, exact) * PIXELS_PER_RADIAN);
      }
    }
    expect(worst).toBeLessThan(1);
  });
});

describe('the Milky Way model', () => {
  it('puts the Sun 8.28 kpc from the centre, just above the plane', () => {
    const sun = icrsPcToGalactocentric([0, 0, 0]);
    expect(Math.hypot(sun[0], sun[1])).toBeCloseTo(R0, 6);
    expect(sun[2] * 1000).toBeCloseTo(20.8, 1);
    const back = galactocentricToIcrsPc(sun);
    expect(Math.hypot(...back)).toBeLessThan(1e-6);
  });

  it('has the luminosity of a large barred spiral', () => {
    // A total V-band absolute magnitude near -21, like other spirals of its mass.
    const { absMag } = totalLuminosity();
    expect(absMag).toBeGreaterThan(-22);
    expect(absMag).toBeLessThan(-20.5);
  });

  it('sees Sgr A* toward the Galactic Centre', () => {
    const sgr = deep.positionMpc(MILKY_WAY_ID + 1);
    const [ra, dec, d] = raDecDistance(sgr);
    expect(separation(direction(ra, dec), direction(266.41683708, -29.00781056)) / ARCSEC).toBeLessThan(1);
    expect(d * 1e3).toBeCloseTo(R0, 3);
    expect(GALAXY_ID).toBeLessThan(MILKY_WAY_ID);
  });
});
