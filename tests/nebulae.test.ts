import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DetailImage, SkyImage } from '../src/render/images';

/**
 * The nebula close-ups (pipeline/build_nebula_detail.py) stay tied to the observations.
 *
 * Each nebula's whole-field plate picture holds a real survey close-up, which holds an
 * AI-enhanced one. Every close-up must lie inside its parent, and, averaged down onto its
 * parent's pixels, reproduce the parent (back-projection): the AI adds detail only below
 * the resolution of the data it was given, and never changes what was observed. The AI
 * layer must be exactly 4 times finer than the survey layer, and labelled as AI.
 */

const read = (path: string) => readFileSync(new URL(`../public/data/${path}`, import.meta.url));
const index: { images: SkyImage[] } = JSON.parse(read('images/index.json').toString('utf8'));
const withDetail = index.images.filter((n) => n.detail?.length);

/** Pixel size of a baseline JPEG, from its SOF0 marker. */
function jpegSize(buf: Buffer): [number, number] {
  let i = 2;
  while (i < buf.length) {
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  throw new Error('no SOF marker');
}

/** Angular separation, degrees. */
function separation(ra0: number, dec0: number, ra: number, dec: number): number {
  const r = Math.PI / 180;
  const c = Math.sin(dec0 * r) * Math.sin(dec * r) + Math.cos(dec0 * r) * Math.cos(dec * r) * Math.cos((ra - ra0) * r);
  return Math.acos(Math.min(1, c)) / r;
}

describe('nebula close-ups', () => {
  it('covers the bright nebulae', () => {
    expect(withDetail.length).toBeGreaterThanOrEqual(20);
  });

  for (const n of withDetail) {
    describe(n.name, () => {
      const layers: Array<{ ra: number; dec: number; fov: number }> = [n, ...(n.detail as DetailImage[])];

      it('nests each close-up inside its parent', () => {
        for (let k = 1; k < layers.length; k++) {
          const p = layers[k - 1], c = layers[k];
          // The child's corner stays inside the parent's square.
          expect(separation(p.ra, p.dec, c.ra, c.dec) + (c.fov / 2) * Math.SQRT2).toBeLessThanOrEqual((p.fov / 2) * Math.SQRT2 + 1e-6);
          expect(c.fov).toBeLessThan(p.fov + 1e-9);
        }
      });

      it('reproduces its parent at the parent\'s resolution', () => {
        for (const d of n.detail!) expect(d.match).toBeLessThan(d.kind === 'ai' ? 0.01 : 0.04);
      });

      it('labels the AI layer and keeps it 4 times finer than the survey', () => {
        const [survey, ai] = n.detail!;
        expect(survey.kind).toBe('survey');
        expect(survey.arcsec).toBeLessThanOrEqual(1.0001);
        if (ai) {
          expect(ai.kind).toBe('ai');
          expect(ai.source).toMatch(/Real-ESRGAN/);
          expect(survey.arcsec / ai.arcsec).toBeCloseTo(4, 1); // both rounded to 0.001"
        }
      });

      it('ships pictures of the stated size', () => {
        for (const d of n.detail!) {
          expect(existsSync(new URL(`../public/data/images/${d.file}`, import.meta.url))).toBe(true);
          const [w, h] = jpegSize(read(`images/${d.file}`));
          expect([w, h]).toEqual([d.px, d.px]);
          expect((d.fov * 3600) / d.px).toBeCloseTo(d.arcsec, 2);
          expect(d.gain).toBeGreaterThan(0);
        }
      });
    });
  }
});
