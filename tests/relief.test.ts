import { describe, expect, it } from 'vitest';
import { reliefHeight, type ReliefMap } from '../src/core/relief';

/** Computed relief (relief.ts): sized as measured, zero-mean, and band-limited to the mesh. */
const uniform = (rough: number, dunes: number): ReliefMap => ({ width: 4, height: 2, data: new Uint8Array(32).map((_, i) => (i % 4 === 0 ? rough * 255 : i % 4 === 1 ? dunes * 255 : 255)) });
const stats = (v: number[]) => {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean: m, rms: Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) };
};

describe('Computed relief', () => {
  it('rock: zero-mean, rougher where Magellan measured steeper metre-scale slopes', () => {
    const params = { radius: 6051, maxWavelength: 16 };
    const sample = (map: ReliefMap) => Array.from({ length: 4000 }, (_, i) => reliefHeight(map, params, -60 + (i % 80) * 0.013, -10 + Math.floor(i / 80) * 0.013, 0.01));
    const smooth = stats(sample(uniform(0, 0)));
    const rough = stats(sample(uniform(1, 0)));
    console.log(`rock relief RMS: ${(smooth.rms * 1000).toFixed(0)} m (smooth plains), ${(rough.rms * 1000).toFixed(0)} m (rough flows)`);
    expect(Math.abs(smooth.mean)).toBeLessThan(smooth.rms);
    expect(rough.rms / smooth.rms).toBeGreaterThan(5);
    // Tens to a couple of hundred metres over kilometres, not mountains: the elevation
    // model has those.
    expect(rough.rms).toBeLessThan(0.25);
  });

  it('adds only wavelengths the mesh can show', () => {
    const params = { radius: 6051, maxWavelength: 16 };
    const map = uniform(0.5, 0);
    // A mesh coarser than the longest wavelength gets nothing.
    expect(reliefHeight(map, params, 10, 10, 20)).toBe(0);
  });

  it('Titan dunes: about 3 km apart and 100 m high, only where the map has dune seas', () => {
    const params = { radius: 2575, maxWavelength: 0.001, dunes: { spacing: 3, height: 0.1 } };
    const lat = (km: number) => (km / 2575) * (180 / Math.PI);
    const line = Array.from({ length: 600 }, (_, i) => reliefHeight(uniform(0, 1), params, 150, lat(i * 0.05), 0.05));
    let crests = 0;
    for (let i = 1; i < line.length - 1; i++) if (line[i] > line[i - 1] && line[i] >= line[i + 1] && line[i] > 0.02) crests++;
    const range = Math.max(...line) - Math.min(...line);
    console.log(`dunes: ${crests} crests in 30 km, ${(range * 1000).toFixed(0)} m crest to trough`);
    expect(crests).toBeGreaterThanOrEqual(7);
    expect(crests).toBeLessThanOrEqual(14);
    expect(range).toBeGreaterThan(0.06);
    expect(range).toBeLessThan(0.15);
    expect(reliefHeight(uniform(0, 0), params, 150, 0, 0.05)).toBe(0);
  });
});
