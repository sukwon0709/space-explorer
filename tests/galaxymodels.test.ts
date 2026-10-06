import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/ephemeris';
import { skyBasis } from '../src/core/galaxies';
import { integrateRay, modelAxes, type FaceMaps, type GalaxyModelSpec } from '../src/core/galaxymodel';

/**
 * The 3D galaxy gate: seen from Earth, each model looks like the survey image it was
 * built from.
 *
 * pipeline/build_galaxy_models.py splits a survey image into a bulge, a deprojected disc
 * and dust; tests/fixtures/galaxy-models-reference.json keeps the cleaned sky image and
 * the model's face-on maps at low resolution. Here the model is rebuilt in 3D in the
 * app's own frame (core/galaxymodel.ts, the same axes and densities the shader uses) and
 * ray-traced along Earth's line of sight. The picture must hold the image's total light
 * and match its structure: arms, dust lanes on the near side, bulge.
 */

interface Fixture {
  sky: number[][];
  face?: number[][];
  tau?: number[][];
  young?: number[][];
  kpcPerPx: number;
  centre: [number, number];
}
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const models: GalaxyModelSpec[] = JSON.parse(read('../public/data/galaxies/models.json')).models;
const fixtures: Record<string, Fixture> = JSON.parse(read('./fixtures/galaxy-models-reference.json'));

function flatten(rows: number[][]): Float32Array {
  return Float32Array.from(rows.flat());
}

/** The model seen from Earth on the fixture's pixel grid (light per kpc^2). */
function render(spec: GalaxyModelSpec, fx: Fixture): number[][] {
  const centre: Vec3 = [Math.cos((spec.dec * Math.PI) / 180) * Math.cos((spec.ra * Math.PI) / 180),
    Math.cos((spec.dec * Math.PI) / 180) * Math.sin((spec.ra * Math.PI) / 180), Math.sin((spec.dec * Math.PI) / 180)];
  const { s, east, north } = skyBasis(centre);
  const axes = modelAxes(spec, centre);
  const local = (v: Vec3): Vec3 => [0, 1, 2].map((k) => {
    const a = [axes.x, axes.y, axes.z][k];
    return v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
  }) as Vec3;
  const maps: FaceMaps | undefined = fx.face && fx.tau ? {
    width: fx.face[0].length, height: fx.face.length, light: flatten(fx.face), tau: flatten(fx.tau),
    young: fx.young ? flatten(fx.young) : undefined,
  } : undefined;
  const dir = local(s);
  const n = fx.sky.length;
  const c0 = n / 2 - 0.5;
  // Each pixel is the mean of 3 x 3 rays, as the image's pixels average the sky (a thin
  // dust lane seen edge-on covers only part of one).
  const sub = [-1 / 3, 0, 1 / 3];
  return fx.sky.map((row, r) => row.map((_, c) => {
    let sum = 0;
    for (const dr of sub) for (const dc of sub) {
      // East is left, north up; the grid's centre is the cutout's, the model's the nucleus.
      const e = -(c + dc - c0 - fx.centre[0]) * fx.kpcPerPx, nn = -(r + dr - c0 - fx.centre[1]) * fx.kpcPerPx;
      const p = local([0, 1, 2].map((k) => e * east[k] + nn * north[k] - 1e4 * s[k]) as Vec3);
      sum += integrateRay(spec, maps, p, dir, 600);
    }
    return sum / 9;
  }));
}

describe('3D galaxy models look like their survey images from Earth', () => {
  for (const [name, fx] of Object.entries(fixtures)) {
    const spec = models.find((m) => m.name === name);
    it(`${name} (${spec?.survey}, ${spec?.kind})`, () => {
      expect(spec).toBeDefined();
      const model = render(spec!, fx);
      const a = fx.sky.flat(), b = model.flat();
      const sum = (v: number[]) => v.reduce((x, y) => x + y, 0);
      // All of the light (as seen from Earth, after the galaxy's own dust).
      expect(sum(b) / sum(a)).toBeGreaterThan(0.85);
      expect(sum(b) / sum(a)).toBeLessThan(1.15);
      // The same picture: correlation of square-root brightness (faint arms count).
      const sa = a.map((v) => Math.sqrt(Math.max(v, 0))), sb = b.map((v) => Math.sqrt(Math.max(v, 0)));
      const ma = sum(sa) / sa.length, mb = sum(sb) / sb.length;
      let num = 0, da = 0, db = 0;
      for (let k = 0; k < sa.length; k++) {
        num += (sa[k] - ma) * (sb[k] - mb);
        da += (sa[k] - ma) ** 2;
        db += (sb[k] - mb) ** 2;
      }
      expect(num / Math.sqrt(da * db)).toBeGreaterThan(0.95);
    }, 120_000);
  }
});
