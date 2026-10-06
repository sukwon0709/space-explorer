import type { Vec3 } from './ephemeris';

/** Reference surface heights are measured from: an ellipsoid of revolution (km). */
export interface Shape {
  a: number; // equatorial radius
  b: number; // polar radius
}

export const WGS84: Shape = { a: 6378.137, b: 6356.752314245 };
/** LOLA's reference sphere for lunar heights. */
export const MOON_SPHERE: Shape = { a: 1737.4, b: 1737.4 };
/** MOLA's reference sphere for Mars radii; latitudes are planetocentric, as MOLA's are. */
export const MARS_SPHERE: Shape = { a: 3396.0, b: 3396.0 };

/** Body-fixed position (km) of a point at geodetic longitude/latitude (radians) and height (km). */
export function geodeticToBody(shape: Shape, lon: number, lat: number, h: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const e2 = 1 - (shape.b * shape.b) / (shape.a * shape.a);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = shape.a / Math.sqrt(1 - e2 * sinLat * sinLat);
  out[0] = (n + h) * cosLat * Math.cos(lon);
  out[1] = (n + h) * cosLat * Math.sin(lon);
  out[2] = (n * (1 - e2) + h) * sinLat;
  return out;
}

/** Geodetic longitude, latitude (radians) and height (km) of a body-fixed point (Bowring). */
export function bodyToGeodetic(shape: Shape, p: Vec3): [number, number, number] {
  const { a, b } = shape;
  const e2 = 1 - (b * b) / (a * a);
  const ep2 = (a * a) / (b * b) - 1;
  const r = Math.hypot(p[0], p[1]);
  const lon = Math.atan2(p[1], p[0]);
  if (r < 1e-9) return [lon, Math.sign(p[2]) * Math.PI / 2, Math.abs(p[2]) - b];
  const beta = Math.atan2(a * p[2], b * r);
  const lat = Math.atan2(p[2] + ep2 * b * Math.sin(beta) ** 3, r - e2 * a * Math.cos(beta) ** 3);
  const sinLat = Math.sin(lat);
  const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const h = Math.abs(lat) < 1.4 ? r / Math.cos(lat) - n : p[2] / sinLat - n * (1 - e2);
  return [lon, lat, h];
}

/** Local east, north and up unit vectors (body frame) at a geodetic longitude/latitude. */
export function enu(lon: number, lat: number): { east: Vec3; north: Vec3; up: Vec3 } {
  const sl = Math.sin(lon), cl = Math.cos(lon), sp = Math.sin(lat), cp = Math.cos(lat);
  return {
    east: [-sl, cl, 0],
    north: [-sp * cl, -sp * sl, cp],
    up: [cp * cl, cp * sl, sp],
  };
}
