import { describe, expect, it } from 'vitest';

/**
 * Why the floating origin exists: a point 2 m from the camera, both near Neptune
 * (4.5 billion km from the barycentre). Sending absolute positions to the GPU as
 * float32 loses the 2 m entirely; subtracting in float64 first keeps it to about a millimetre.
 */
describe('floating origin', () => {
  const camera = 4.5e9; // km
  const point = camera + 0.002; // 2 m further out

  it('float32 absolute positions cannot represent the gap', () => {
    const gap = Math.fround(point) - Math.fround(camera);
    expect(Math.abs(gap - 0.002)).toBeGreaterThan(0.001); // error larger than the gap itself
  });

  it('float64 subtraction before float32 conversion keeps it to the millimetre', () => {
    const gap = Math.fround(point - camera);
    expect(Math.abs(gap - 0.002)).toBeLessThan(1e-6) // 1 mm;
  });
});
