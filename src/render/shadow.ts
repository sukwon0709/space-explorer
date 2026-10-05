/**
 * Eclipses and shadows, computed from geometry: the fraction of the Sun's disc that a
 * point sees, given spheres between it and the Sun. The same function, in float64 on
 * the CPU (core/eclipse.ts) and in GLSL here, makes solar eclipses on Earth, lunar
 * eclipses, moon shadows on Jupiter and planet shadows on rings.
 */
export const SHADOW_GLSL = /* glsl */ `
// Fraction of a disc of angular radius R covered by a disc of radius r at separation d (radians).
float discOverlap(float R, float r, float d) {
  if (d >= R + r) return 0.0;
  if (d <= abs(R - r)) return r >= R ? 1.0 : (r * r) / (R * R);
  float R2 = R * R, r2 = r * r, d2 = d * d;
  float a = r2 * acos(clamp((d2 + r2 - R2) / (2.0 * d * r), -1.0, 1.0))
          + R2 * acos(clamp((d2 + R2 - r2) / (2.0 * d * R), -1.0, 1.0))
          - 0.5 * sqrt(max(0.0, (-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R)));
  return clamp(a / (3.14159265 * R2), 0.0, 1.0);
}

// Angle between two unit vectors, accurate for small angles (unlike acos of the dot).
float angleBetween(vec3 a, vec3 b) {
  return atan(length(cross(a, b)), dot(a, b));
}

// Sunlight reaching point p, 0..1, with the Sun at sunPos (radius sunRadius) and a sphere
// (centre.xyz, radius centre.w) possibly in the way. All in one frame, any origin.
float occlusion(vec3 p, vec3 sunPos, float sunRadius, vec4 sphere) {
  vec3 toSun = sunPos - p;
  float ds = length(toSun);
  vec3 toO = sphere.xyz - p;
  float dO = length(toO);
  if (dO >= ds || dot(toO, toSun) <= 0.0 || dO <= sphere.w) return 1.0;
  float R = asin(min(1.0, sunRadius / ds));
  float r = asin(min(1.0, sphere.w / dO));
  return 1.0 - discOverlap(R, r, angleBetween(toO / dO, toSun / ds));
}
`;

/**
 * Eclipses on a body with terrain (Earth, the Moon): one other body that can cover the
 * Sun. Positions are in the body-fixed frame, km from the body's centre.
 */
export const ECLIPSE_GLSL = /* glsl */ `
${SHADOW_GLSL}
uniform vec3 uEclSun;
uniform float uEclSunRadius;
uniform vec4 uEclOcc;
float eclipseVisibility(vec3 pBody) {
  if (uEclOcc.w <= 0.0) return 1.0;
  return occlusion(pBody, uEclSun, uEclSunRadius, uEclOcc);
}
`;

/** CPU twin of discOverlap (float64). */
export function discOverlap(R: number, r: number, d: number): number {
  if (d >= R + r) return 0;
  if (d <= Math.abs(R - r)) return r >= R ? 1 : (r * r) / (R * R);
  const R2 = R * R, r2 = r * r, d2 = d * d;
  const a =
    r2 * Math.acos(Math.min(1, Math.max(-1, (d2 + r2 - R2) / (2 * d * r)))) +
    R2 * Math.acos(Math.min(1, Math.max(-1, (d2 + R2 - r2) / (2 * d * R)))) -
    0.5 * Math.sqrt(Math.max(0, (-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R)));
  return Math.min(1, Math.max(0, a / (Math.PI * R2)));
}
