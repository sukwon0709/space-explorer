import type { Vec3 } from './ephemeris';

/** Mean obliquity of the ecliptic at J2000 (IAU 2006), 84381.406 arcseconds. */
export const OBLIQUITY_J2000 = (84381.406 / 3600) * (Math.PI / 180);

const cosE = Math.cos(OBLIQUITY_J2000);
const sinE = Math.sin(OBLIQUITY_J2000);

/**
 * ICRF (equatorial) to the scene's axes: ecliptic J2000 with y up, so the planets
 * orbit in the horizontal plane. Scene = (x_ecl, z_ecl, -y_ecl).
 */
export function icrfToScene(v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const x = v[0];
  const yEcl = cosE * v[1] + sinE * v[2];
  const zEcl = -sinE * v[1] + cosE * v[2];
  out[0] = x;
  out[1] = zEcl;
  out[2] = -yEcl;
  return out;
}

/** Unit vector in ICRF for right ascension / declination in degrees. */
export function raDecToIcrf(raDeg: number, decDeg: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const ra = (raDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  out[0] = Math.cos(dec) * Math.cos(ra);
  out[1] = Math.cos(dec) * Math.sin(ra);
  out[2] = Math.sin(dec);
  return out;
}

export function sub(a: Vec3, b: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
  return out;
}

export function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}
