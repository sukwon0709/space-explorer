/**
 * Earth's atmosphere: single scattering by air molecules (Rayleigh) and aerosols (Mie),
 * with ozone absorption, integrated along each view ray. Coefficients are the
 * standard sea-level values used by Bruneton's precomputed model (2017 reference
 * implementation), in km^-1. Everything works in the body frame with z scaled by a/b,
 * which turns the WGS84 ellipsoid into a sphere of radius a.
 */
export const ATMOSPHERE = {
  bottom: 6378.137,
  top: 6378.137 + 80,
  rayleigh: [5.802e-3, 13.558e-3, 33.1e-3],
  rayleighHeight: 8,
  mieScattering: 3.996e-3,
  mieExtinction: 4.44e-3,
  mieHeight: 1.2,
  mieG: 0.8,
  ozone: [0.65e-3, 1.881e-3, 0.085e-3],
};

export const ATMOSPHERE_GLSL = /* glsl */ `
const float ATM_BOTTOM = ${ATMOSPHERE.bottom.toFixed(3)};
const float ATM_TOP = ${ATMOSPHERE.top.toFixed(3)};
const vec3 RAYLEIGH = vec3(${ATMOSPHERE.rayleigh.map((v) => v.toExponential(4)).join(', ')});
const float RAYLEIGH_H = ${ATMOSPHERE.rayleighHeight.toFixed(1)};
const float MIE_S = ${ATMOSPHERE.mieScattering.toExponential(4)};
const float MIE_E = ${ATMOSPHERE.mieExtinction.toExponential(4)};
const float MIE_H = ${ATMOSPHERE.mieHeight.toFixed(2)};
const float MIE_G = ${ATMOSPHERE.mieG.toFixed(2)};
const vec3 OZONE = vec3(${ATMOSPHERE.ozone.map((v) => v.toExponential(4)).join(', ')});
const float PI_A = 3.14159265;

// Densities relative to sea level: (rayleigh, mie, ozone). Ozone is a tent at 25 km.
vec3 atmDensity(float h) {
  h = max(h, 0.0);
  return vec3(exp(-h / RAYLEIGH_H), exp(-h / MIE_H), max(0.0, 1.0 - abs(h - 25.0) / 15.0));
}

vec3 atmExtinction(vec3 d) {
  return RAYLEIGH * d.x + vec3(MIE_E) * d.y + OZONE * d.z;
}

// Distances along the ray to a sphere of radius r centred at the origin; (-1,-1) if missed.
vec2 atmSphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

// Optical depth (summed extinction) from p toward the sun; large if the ground is in the way.
vec3 atmSunDepth(vec3 p, vec3 sunDir) {
  vec2 ground = atmSphere(p, sunDir, ATM_BOTTOM - 0.5);
  if (ground.x > 0.0) return vec3(1e4);
  float len = atmSphere(p, sunDir, ATM_TOP).y;
  const int N = 6;
  float dt = len / float(N);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 q = p + sunDir * (float(i) + 0.5) * dt;
    sum += atmDensity(length(q) - ATM_BOTTOM);
  }
  return sum * dt;
}

vec3 atmSunTransmittance(vec3 p, vec3 sunDir) {
  return exp(-atmExtinction(atmSunDepth(p, sunDir)));
}

float rayleighPhase(float mu) { return 3.0 / (16.0 * PI_A) * (1.0 + mu * mu); }
float miePhase(float mu) {
  float g2 = MIE_G * MIE_G;
  return 3.0 / (8.0 * PI_A) * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * MIE_G * mu, 1.5));
}

// Light scattered toward the camera along ro + rd*t for t in [t0, t1], and the
// transmittance over that segment. Irradiance of the sun is 1.
void atmScatter(vec3 ro, vec3 rd, float t0, float t1, vec3 sunDir, out vec3 inscatter, out vec3 transmittance) {
  const int N = 14;
  float dt = (t1 - t0) / float(N);
  vec3 depth = vec3(0.0);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * (t0 + (float(i) + 0.5) * dt);
    vec3 d = atmDensity(length(p) - ATM_BOTTOM) * dt;
    depth += d;
    vec3 t = exp(-atmExtinction(depth + atmSunDepth(p, sunDir)));
    sumR += t * d.x;
    sumM += t * d.y;
  }
  float mu = dot(rd, sunDir);
  inscatter = sumR * RAYLEIGH * rayleighPhase(mu) + sumM * MIE_S * miePhase(mu);
  transmittance = exp(-atmExtinction(depth));
}

// Aerial perspective between the camera and a point, both in the scaled body frame.
void atmBetween(vec3 cam, vec3 p, vec3 sunDir, out vec3 inscatter, out vec3 transmittance) {
  vec3 rd = p - cam;
  float dist = length(rd);
  rd /= dist;
  vec2 top = atmSphere(cam, rd, ATM_TOP);
  float t0 = max(top.x, 0.0);
  float t1 = min(dist, top.y);
  if (top.y < 0.0 || t1 <= t0) {
    inscatter = vec3(0.0);
    transmittance = vec3(1.0);
    return;
  }
  atmScatter(cam, rd, t0, t1, sunDir, inscatter, transmittance);
}
`;
