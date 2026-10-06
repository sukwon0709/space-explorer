import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GalaxyModelSpec } from '../src/core/galaxymodel';
import { STAR_SHARE, sampleGalaxyStars, type DiscMaps } from '../src/core/galaxystars';

/**
 * Detail below the survey images' resolution must not change what they show: the resolved
 * stars are drawn from the model's own light, so they sit where its light is (same
 * half-light radius) and carry the share of it the renderer takes out of the volume.
 */

interface Fixture {
  face?: number[][];
  young?: number[][];
}
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const models: GalaxyModelSpec[] = JSON.parse(read('../public/data/galaxies/models.json')).models;
const fixtures: Record<string, Fixture> = JSON.parse(read('./fixtures/galaxy-models-reference.json'));

function maps(fx: Fixture): DiscMaps {
  const light = Float32Array.from(fx.face!.flat());
  const thin = fx.young!.flat();
  const young = Float32Array.from(thin.map((v, k) => (light[k] > 0 ? Math.min(v / light[k], 1) : 0)));
  return { width: fx.face![0].length, height: fx.face!.length, light, young, colour: new Float32Array(3 * light.length).fill(1) };
}

/** Radius holding half of the light of weighted points in the plane. */
function halfLight(points: { r: number; w: number }[]): number {
  points.sort((a, b) => a.r - b.r);
  const total = points.reduce((s, p) => s + p.w, 0);
  let s = 0;
  for (const p of points) if ((s += p.w) >= total / 2) return p.r;
  return Infinity;
}

describe('resolved stars follow the 3D models’ light', () => {
  for (const name of ['Whirlpool Galaxy', 'Triangulum Galaxy']) {
    it(name, () => {
      const spec = models.find((m) => m.name === name)!;
      const fx = maps(fixtures[name]);
      const stars = sampleGalaxyStars(spec, fx, 50_000);
      expect(stars.count).toBeGreaterThan(45_000);
      // The same stars every time.
      expect(sampleGalaxyStars(spec, fx, 50_000).position.slice(0, 30)).toEqual(stars.position.slice(0, 30));
      // About the share of the light in the brightest stars, and the HII regions' glow.
      expect(stars.share).toBeGreaterThan(STAR_SHARE);
      expect(stars.share).toBeLessThan(STAR_SHARE + 0.05);
      // Where the light is: the disc stars' half-light radius is the map's.
      const pts: { r: number; w: number }[] = [];
      const bulge = spec.bulge.L > 0 && spec.bulge.rho0 > 0;
      for (let k = 0; k < stars.count; k++) {
        const x = stars.position[3 * k], y = stars.position[3 * k + 1], z = stars.position[3 * k + 2];
        // Bulge stars (round, about the centre) are left out by their height for a fair comparison.
        if (bulge && Math.abs(z) > 3 * spec.z0!) continue;
        pts.push({ r: Math.hypot(x, y), w: stars.light[k] });
      }
      const mapPts: { r: number; w: number }[] = [];
      for (let j = 0; j < fx.height; j++) for (let i = 0; i < fx.width; i++) {
        const x = ((i + 0.5) / fx.width * 2 - 1) * spec.R, y = ((j + 0.5) / fx.height * 2 - 1) * spec.R;
        mapPts.push({ r: Math.hypot(x, y), w: fx.light[j * fx.width + i] });
      }
      const ratio = halfLight(pts) / halfLight(mapPts);
      expect(ratio).toBeGreaterThan(bulge ? 0.75 : 0.9);
      expect(ratio).toBeLessThan(1.1);
    });
  }
});
