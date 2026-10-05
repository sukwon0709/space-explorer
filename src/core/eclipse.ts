import type { Ephemeris, Vec3 } from './ephemeris';
import type { Mat3, Orientation } from './orientation';
import { bodyToGeodetic, geodeticToBody, WGS84 } from './geodesy';

/**
 * Solar eclipses from the ephemeris alone, in float64 and in the barycentric frame:
 * a ground point is in the Moon's umbra when the Moon's disc, seen from there, covers
 * the Sun's. Light travel time is applied to both (the Sun as it was 8.3 minutes
 * earlier, the Moon about 1.3 s earlier), which is all the "apparent position"
 * correction a barycentric calculation needs; aberration only arises in a moving
 * observer's frame.
 *
 * Radii follow the conventions of NASA's eclipse predictions so results can be
 * compared with them: for totality the Moon's radius is k = 0.272281 Earth radii,
 * a little under its mean radius to stand in for the valleys along its limb (Espenak
 * and Meeus, Five Millennium Canon of Solar Eclipses), and the Sun's radius is 959.63
 * arcseconds at 1 AU.
 */

export const C_KM_S = 299792.458;
export const MOON_K_RADIUS = 0.272281 * 6378.137;
export const SUN_ECLIPSE_RADIUS = (959.63 / 206264.806) * 149597870.7;
/** Earth's rotation rate, rad per second of UT1. */
const OMEGA_EARTH = 7.2921150e-5;

export interface EclipseOptions {
  /**
   * Seconds to add to the UT1 the Earth orientation file implies. Comparing with a
   * prediction that assumed a different Delta T (TT - UT1): pass ourDeltaT - theirDeltaT.
   */
  ut1Shift?: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const angle = (a: Vec3, b: Vec3) => {
  const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
  return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
};

export class EclipseCalculator {
  private readonly m: Mat3 = new Float64Array(9);

  constructor(
    private readonly ephemeris: Ephemeris,
    private readonly orientation: Orientation,
    private readonly options: EclipseOptions = {},
  ) {}

  /** ICRF -> Earth-fixed (ITRF93) rotation at a TDB epoch, with the optional UT1 shift. */
  private earthRotation(tdb: number): Mat3 {
    const r = this.orientation.icrfToBody(399, tdb, this.m);
    const theta = OMEGA_EARTH * (this.options.ut1Shift ?? 0);
    if (theta === 0) return r;
    // Turning the Earth further by theta is a frame rotation about its pole: R3(theta) * R.
    const c = Math.cos(theta), s = Math.sin(theta);
    const out = new Float64Array(9);
    for (let j = 0; j < 3; j++) {
      out[j] = c * r[j] + s * r[3 + j];
      out[3 + j] = -s * r[j] + c * r[3 + j];
      out[6 + j] = r[6 + j];
    }
    return out;
  }

  /** Barycentric ICRF position (km) of a point on the WGS84 ellipsoid. */
  groundPoint(latDeg: number, lonDeg: number, tdb: number, heightKm = 0): Vec3 {
    const local = geodeticToBody(WGS84, (lonDeg * Math.PI) / 180, (latDeg * Math.PI) / 180, heightKm);
    const r = this.earthRotation(tdb);
    const earth = this.ephemeris.position(399, tdb);
    return [0, 1, 2].map((k) => earth[k] + r[k] * local[0] + r[3 + k] * local[1] + r[6 + k] * local[2]) as Vec3;
  }

  /** Sun and Moon as seen from a barycentric point at a TDB epoch, with light time. */
  view(observer: Vec3, tdb: number): { sun: Vec3; moon: Vec3; sunRadius: number; moonRadius: number } {
    const at = (id: number) => {
      let p = this.ephemeris.position(id, tdb);
      for (let i = 0; i < 2; i++) p = this.ephemeris.position(id, tdb - len(sub(p, observer)) / C_KM_S);
      return sub(p, observer);
    };
    const sun = at(10), moon = at(301);
    return { sun, moon, sunRadius: Math.asin(SUN_ECLIPSE_RADIUS / len(sun)), moonRadius: Math.asin(MOON_K_RADIUS / len(moon)) };
  }

  /**
   * Totality margin (radians) at a ground point: Moon radius minus Sun radius minus the
   * separation of their centres. Positive inside the umbra.
   */
  totalityMargin(latDeg: number, lonDeg: number, tdb: number): number {
    const v = this.view(this.groundPoint(latDeg, lonDeg, tdb), tdb);
    return v.moonRadius - v.sunRadius - angle(v.sun, v.moon);
  }

  /**
   * Where the shadow axis (the line from the Sun's centre through the Moon's) meets the
   * ground, as geodetic latitude/longitude in degrees, or null if it misses the Earth.
   */
  centralPoint(tdb: number): [number, number] | null {
    const earth = this.ephemeris.position(399, tdb);
    const r = this.earthRotation(tdb);
    let x: Vec3 = earth;
    let hit: [number, number] | null = null;
    for (let iter = 0; iter < 4; iter++) {
      const sun = this.ephemeris.position(10, tdb - len(sub(this.ephemeris.position(10, tdb), x)) / C_KM_S);
      const moon = this.ephemeris.position(301, tdb - len(sub(this.ephemeris.position(301, tdb), x)) / C_KM_S);
      const axis = sub(moon, sun);
      const d = len(axis);
      // Ray from the Moon away from the Sun, in Earth-fixed axes, ellipsoid scaled to a sphere.
      const o = sub(moon, earth);
      const toBody = (v: Vec3): Vec3 => [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[3] * v[0] + r[4] * v[1] + r[5] * v[2], r[6] * v[0] + r[7] * v[1] + r[8] * v[2]];
      const ob = toBody(o), db = toBody([axis[0] / d, axis[1] / d, axis[2] / d]);
      const f = WGS84.a / WGS84.b;
      const os: Vec3 = [ob[0], ob[1], ob[2] * f], ds: Vec3 = [db[0], db[1], db[2] * f];
      const a = ds[0] ** 2 + ds[1] ** 2 + ds[2] ** 2;
      const b = 2 * (os[0] * ds[0] + os[1] * ds[1] + os[2] * ds[2]);
      const c = os[0] ** 2 + os[1] ** 2 + os[2] ** 2 - WGS84.a ** 2;
      const disc = b * b - 4 * a * c;
      if (disc < 0) return null;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      const pb: Vec3 = [ob[0] + db[0] * t, ob[1] + db[1] * t, ob[2] + db[2] * t];
      const [lon, lat] = bodyToGeodetic(WGS84, pb);
      hit = [(lat * 180) / Math.PI, (lon * 180) / Math.PI];
      x = [0, 1, 2].map((k) => earth[k] + r[k] * pb[0] + r[3 + k] * pb[1] + r[6 + k] * pb[2]) as Vec3;
    }
    return hit;
  }

  /** Start and end (TDB) of totality at a ground point near `tdb`, or null if it is not total there. */
  totality(latDeg: number, lonDeg: number, tdb: number, window = 900): [number, number] | null {
    const m = (t: number) => this.totalityMargin(latDeg, lonDeg, t);
    const peak = this.maxMargin(latDeg, lonDeg, tdb, window);
    if (peak.margin <= 0) return null;
    const edge = (inside: number, outside: number) => {
      for (let i = 0; i < 50; i++) {
        const mid = (inside + outside) / 2;
        if (m(mid) > 0) inside = mid;
        else outside = mid;
      }
      return (inside + outside) / 2;
    };
    return [edge(peak.tdb, peak.tdb - window), edge(peak.tdb, peak.tdb + window)];
  }

  /** Largest totality margin at a ground point within +-window seconds of tdb (golden section). */
  maxMargin(latDeg: number, lonDeg: number, tdb: number, window = 900): { tdb: number; margin: number } {
    const g = (Math.sqrt(5) - 1) / 2;
    let a = tdb - window, b = tdb + window;
    let c = b - g * (b - a), d = a + g * (b - a);
    let fc = this.totalityMargin(latDeg, lonDeg, c), fd = this.totalityMargin(latDeg, lonDeg, d);
    for (let i = 0; i < 60; i++) {
      if (fc > fd) {
        b = d; d = c; fd = fc;
        c = b - g * (b - a); fc = this.totalityMargin(latDeg, lonDeg, c);
      } else {
        a = c; c = d; fc = fd;
        d = a + g * (b - a); fd = this.totalityMargin(latDeg, lonDeg, d);
      }
    }
    return fc > fd ? { tdb: c, margin: fc } : { tdb: d, margin: fd };
  }
}
