/**
 * Earth's clouds as an optical depth, shared by the cloud deck (sky.ts) and the ground's
 * cloud shadows (globe.ts).
 *
 * The cover map (pipeline/build_clouds.py) comes from the infrared brightness of the cloud
 * tops: 0 for clear sky, 1 for the coldest, deepest cloud. It is read as optical depth
 * (tau 40 for a thunderstorm anvil, a few for thin cloud), and the light follows from tau
 * with the two-stream approximation for cloud droplets (asymmetry g = 0.85): reflectance
 * R = (1 - g) tau / (2 + (1 - g) tau). Thin cloud is a grey veil over the sea, thick cloud
 * is bright white, and the ground under it gets the light the cloud lets through.
 */
export const CLOUD_ALTITUDE_KM = 6;

export const CLOUD_GLSL = /* glsl */ `
uniform sampler2D uClouds;
uniform float uHasClouds;
const float CLOUD_ALTITUDE = ${CLOUD_ALTITUDE_KM.toFixed(1)};
// Equirectangular map coordinates of a body-frame point (as latLonSphere, lod.ts).
vec2 cloudUv(vec3 p) {
  float lon = atan(p.y, p.x);
  float lat = asin(clamp(p.z / length(p), -1.0, 1.0));
  return vec2((lon + PI) / (2.0 * PI), (0.5 * PI - lat) / PI);
}
float cloudTau(float cover) { return 40.0 * pow(cover, 1.5); }
float cloudReflectance(float tau) { return 0.15 * tau / (2.0 + 0.15 * tau); }
`;
