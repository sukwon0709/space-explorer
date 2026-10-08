import { BODIES, findBody } from './bodies';
import type { Ephemeris, Vec3 } from './ephemeris';
import { icrfToScene } from './frames';
import shapes from '../generated/shapes.json';

/**
 * Gravitational parameters GM (km^3/s^2), keyed by NAIF id. The Sun, planets and Moon
 * are the DE440 values (Park et al. 2021); the moons are from the satellite ephemerides
 * the moon files were built from (JPL SSD planetary satellite physical parameters:
 * jup365, sat441, ura111, nep097, plu060, mar097); Ceres, Vesta, Pallas and Hygiea from
 * the DE440 asteroid set. Planets are the planet alone, not the system: their moons
 * pull for themselves once loaded.
 */
export const GM: Record<number, number> = {
  10: 132712440041.279419,
  199: 22031.868551,
  299: 324858.592,
  399: 398600.435507,
  301: 4902.800118,
  499: 42828.37362,
  401: 7.087546e-4,
  402: 9.615569e-5,
  599: 126686531.9,
  501: 5959.9155,
  502: 3202.7121,
  503: 9887.8328,
  504: 7179.2834,
  699: 37931206.234,
  601: 2.503617,
  602: 7.210497,
  603: 41.21,
  604: 73.116,
  605: 153.94,
  606: 8978.14,
  607: 0.3704,
  608: 120.52,
  609: 0.5532,
  799: 5793950.61,
  701: 83.46,
  702: 85.09,
  703: 226.94,
  704: 205.32,
  705: 4.32,
  899: 6835099.97,
  801: 1428.495,
  999: 869.6138,
  901: 105.8799,
  2000001: 62.6284,
  2000002: 13.665878,
  2000004: 17.288245,
  2000010: 5.78,
};

// The small bodies spacecraft visited: GM from their missions' radio tracking where
// measured, else the shape model's volume at an assumed density (pipeline/build_shapes.py).
for (const e of Object.values(shapes.bodies as Record<string, { id: number; gm: number }>)) GM[e.id] = e.gm;

export const SUN_GM = GM[10];
/** Standard gravity, km/s^2. */
export const G0 = 9.80665e-3;
/** Speed of light, km/s. */
export const C_KMS = 299792.458;

/** The object each body orbits (for spheres of influence): its planet, or the Sun. */
export function parentOf(id: number): number {
  return findBody(id)?.orbit?.around ?? 10;
}

/**
 * Positions, velocities and accelerations of Solar System bodies from the ephemeris, in
 * scene axes (km, s). Velocities and accelerations are central differences of the
 * positions, so they include everything the ephemeris integration included (the Moon's
 * pull on Earth, asteroids, relativity), not only the masses listed above.
 */
export class SolarGravity {
  private readonly scratch: Vec3 = [0, 0, 0];
  private readonly a: Vec3 = [0, 0, 0];
  private readonly b: Vec3 = [0, 0, 0];

  constructor(readonly ephemeris: Ephemeris) {}

  has(id: number, tdb: number): boolean {
    return GM[id] !== undefined && this.ephemeris.available(id, tdb);
  }

  position(id: number, tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    return icrfToScene(this.ephemeris.position(id, tdb, this.scratch), out);
  }

  velocity(id: number, tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const h = 10;
    this.position(id, tdb + h, this.a);
    this.position(id, tdb - h, this.b);
    for (let k = 0; k < 3; k++) out[k] = (this.a[k] - this.b[k]) / (2 * h);
    return out;
  }

  acceleration(id: number, tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    // 60 s steps: rounding in positions ~1e8 km away stays below 1e-11 km/s^2.
    const h = 60;
    this.position(id, tdb + h, this.a);
    this.position(id, tdb - h, this.b);
    const p = this.position(id, tdb, this.scratch);
    for (let k = 0; k < 3; k++) out[k] = (this.a[k] - 2 * p[k] + this.b[k]) / (h * h);
    return out;
  }

  /**
   * Bodies that pull noticeably on something at scene position `near`: the Sun and
   * planets always, the Moon, and a planet's moons (or an asteroid) within 0.3 AU.
   */
  sources(near: Vec3, tdb: number, exclude?: number): number[] {
    const ids: number[] = [];
    for (const body of BODIES) {
      const id = body.id;
      if (id === exclude || !this.has(id, tdb)) continue;
      const major = body.kind === 'star' || body.kind === 'planet' || id === 301 || id === 999;
      if (!major) {
        const p = this.position(id, tdb, this.a);
        if (Math.hypot(p[0] - near[0], p[1] - near[1], p[2] - near[2]) > 4.5e7) continue;
      }
      ids.push(id);
    }
    return ids;
  }

  /**
   * Sphere of influence radius (km), Laplace's a (m/M)^0.4, but never less than four
   * body radii (so even Phobos can be flown around).
   */
  influence(id: number, tdb: number): number {
    if (id === 10) return 2e5 * 149597870.7;
    const parent = parentOf(id);
    const p = this.position(id, tdb, this.a);
    const q = this.position(parent, tdb, this.b);
    const a = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    const r = findBody(id)?.radius[0] ?? 0;
    return Math.max(a * Math.pow(GM[id] / GM[parent], 0.4), 4 * r);
  }
}
