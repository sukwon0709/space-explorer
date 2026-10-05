import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { iauIcrfToBody } from '../src/core/iau';

const reference: { cases: Array<{ body: number; tdb: number; matrix: number[] }> } = JSON.parse(
  readFileSync(new URL('./fixtures/rotation-reference.json', import.meta.url), 'utf8'),
);

describe('IAU rotation models', () => {
  it('match SPICE (pck00011) for every body to within 1e-9 rad', () => {
    let worst = 0;
    for (const c of reference.cases) {
      const m = iauIcrfToBody(c.body, c.tdb);
      for (let k = 0; k < 9; k++) worst = Math.max(worst, Math.abs(m[k] - c.matrix[k]));
    }
    expect(reference.cases.length).toBeGreaterThan(150);
    expect(worst).toBeLessThan(1e-9);
  });
});
