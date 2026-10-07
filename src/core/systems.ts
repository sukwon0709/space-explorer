import type { Vec3 } from './ephemeris';
import { PC_KM, bolometricCorrection, namedStarPosition, yearsSinceEpoch, type Exoplanet, type NamedStar } from './stars';
import { periastronFromTransit, planetOffset, skyAxes, visualOffset, type PlanetOrbit, type VisualOrbit } from './kepler';

/**
 * Other star systems in full: binary stars on their measured orbits (USNO ORB6) and
 * exoplanets on theirs (NASA Exoplanet Archive), placed around the catalogue stars.
 * Positions are barycentric ICRF in km, like the catalogue stars', and like them they
 * are what we see from Earth now: light time is not taken off, so a transiting planet
 * is in front of its star at the catalogued time of mid-transit.
 */

export const AU_KM = 149597870.7;
export const EARTH_RADIUS_KM = 6371.0;
export const EARTH_GM = 398600.4418;
export const SUN_GM = 1.32712440018e11;
const SOLAR_RADIUS_KM = 695700;
const EARTH_MASSES_PER_SUN = 332946.0487;

/** What build_systems.py adds to a planet in named.json. */
export interface PlanetExtra {
  /** Argument of periastron, degrees. */
  w?: number;
  /** Time of mid-transit and of periastron, BJD (TDB). */
  tc?: number;
  tp?: number;
  /** Impact parameter of the transit, in stellar radii. */
  b?: number;
  /** Light received, in Earth's. */
  insol?: number;
  /** The mass is a minimum, M sin i. */
  msini?: 1;
  transits?: 1;
}

export interface HostExtra {
  mass?: number;
  logg?: number;
  met?: number;
  rotp?: number;
  age?: number;
}

export interface BinaryData {
  wds: string;
  pair: string;
  primary: string;
  primaryHip: number;
  masses: [number, number];
  companion: { star?: string; name?: string; teff?: number; radius?: number; M?: number; kind?: string };
  /** Julian year of the primary's catalogue position and motion. */
  epoch: number;
  orbit: VisualOrbit & { ref: string; ascending: boolean };
}

export interface FeaturedSystem {
  star: string;
  title: string;
  note: string;
}

export interface SystemsData {
  planets: Record<string, PlanetExtra>;
  hosts: Record<string, HostExtra>;
  binaries: BinaryData[];
  featured: FeaturedSystem[];
}

/** How a planet is drawn: estimated from its size, mass and temperature. */
export type PlanetKind = 'gas giant' | 'ice giant' | 'sub-Neptune' | 'lava world' | 'hot rock' | 'temperate rock' | 'ice world';

export interface PlanetInfo {
  /** Index among all planets (ids are built from it). */
  index: number;
  name: string;
  /** Host star, an index into named stars. */
  host: number;
  data: Exoplanet;
  extra: PlanetExtra;
  orbit: PlanetOrbit;
  /** Earth radii and masses, measured or estimated (see the flags). */
  radius: number;
  mass: number;
  radiusEstimated: boolean;
  massEstimated: boolean;
  /** The mass is a minimum (M sin i) with the true tilt unknown. */
  massMinimum: boolean;
  inclinationKnown: boolean;
  phaseKnown: boolean;
  /** Equilibrium temperature, K (zero albedo, heat spread evenly). */
  teq: number;
  kind: PlanetKind;
  /** Geometric albedo assumed for its kind. */
  albedo: number;
  /** Close enough to its star to keep one face to it. */
  locked: boolean;
}

/** A star of a binary that is not in the star catalogue (white dwarfs, faint companions). */
export interface CompanionStar {
  index: number;
  name: string;
  teff: number;
  /** Solar radii. */
  radius: number;
  /** Absolute V. */
  M: number;
  kind: string;
  binary: number;
}

export interface Binary {
  data: BinaryData;
  primary: number;
  /** The companion: a named star index, or a companion star. */
  secondary: { star: number } | { companion: number };
  /** Mass fraction of the secondary. */
  f: number;
  /** Arcseconds to km at the system's distance. */
  scale: number;
  axes: { north: Vec3; east: Vec3; away: Vec3 };
  /** TDB seconds of the primary's catalogue epoch. */
  epochTdb: number;
}

export interface State {
  p: Vec3;
  v: Vec3;
  acc: Vec3;
}

/**
 * Planet radius from mass and back (Chen and Kipping 2017, "Forecaster"): rocky worlds
 * below 2 Earth masses, Neptune-like ones to 0.41 Jupiter masses, gas giants beyond.
 */
export function radiusFromMass(m: number): number {
  if (m < 2.04) return 1.008 * m ** 0.279;
  if (m < 131.6) return 0.808 * m ** 0.589;
  return Math.max(9, 17.74 * m ** -0.044);
}

export function massFromRadius(r: number): number {
  if (r < 1.23) return (r / 1.008) ** (1 / 0.279);
  if (r < 14.2) return (r / 0.808) ** (1 / 0.589);
  return 318; // a gas giant's size barely depends on its mass: a Jupiter mass
}

/** A planet's kind from its size, density and temperature. */
export function planetKind(radius: number, mass: number, teq: number, massMeasured: boolean): PlanetKind {
  const density = (5.513 * mass) / radius ** 3;
  if (radius >= 8 || mass >= 60) return 'gas giant';
  if (radius >= 3.5) return 'ice giant';
  const rocky = radius < 1.6 || (massMeasured && density > 4.5);
  if (!rocky) return 'sub-Neptune';
  if (teq >= 1000) return 'lava world';
  if (teq >= 400) return 'hot rock';
  if (teq >= 180) return 'temperate rock';
  return 'ice world';
}

/** Geometric albedo by kind (gas giants by temperature, after Sudarsky et al. 2000). */
export function planetAlbedo(kind: PlanetKind, teq: number): number {
  switch (kind) {
    case 'gas giant':
      return teq < 150 ? 0.5 : teq < 350 ? 0.8 : teq < 800 ? 0.12 : teq < 1400 ? 0.04 : 0.4;
    case 'ice giant':
      return teq < 300 ? 0.4 : 0.3;
    case 'sub-Neptune':
      return 0.35;
    case 'lava world':
      return 0.1;
    case 'hot rock':
      return 0.12;
    case 'temperate rock':
      return 0.2;
    case 'ice world':
      return 0.6;
  }
}

const jdToTdb = (jd: number) => (jd - 2451545) * 86400;
const julianYearToTdb = (y: number) => (y - 2000) * 365.25 * 86400;

/** A string's 32-bit FNV-1a hash, for per-planet looks that stay the same. */
export function hashName(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class StarSystems {
  readonly planets: PlanetInfo[] = [];
  readonly companions: CompanionStar[] = [];
  readonly binaries: Binary[] = [];
  /** Planets of each named star. */
  readonly planetsOf = new Map<number, PlanetInfo[]>();
  /** The binary a named star belongs to. */
  readonly binaryOf = new Map<number, Binary>();
  readonly featured: Array<FeaturedSystem & { host: number }> = [];

  constructor(readonly stars: NamedStar[], readonly data: SystemsData, private readonly fallbackMass: (star: NamedStar) => number) {
    const byName = new Map<string, number>();
    stars.forEach((s, k) => { if (!byName.has(s.name)) byName.set(s.name, k); });
    const byHip = new Map<number, number>();
    stars.forEach((s, k) => { if (s.hip) byHip.set(s.hip, k); });

    for (const b of data.binaries) {
      const primary = byHip.get(b.primaryHip);
      if (primary === undefined) continue;
      const star = stars[primary];
      const d = Math.hypot(...star.pos);
      const dir: Vec3 = [star.pos[0] / d, star.pos[1] / d, star.pos[2] / d];
      let secondary: Binary['secondary'];
      if (b.companion.star) {
        // The catalogue's companion is the next entry of that name after the primary
        // when names repeat (61 Cyg A and B are both "Bessel's Star").
        const k = stars.findIndex((s, i) => i !== primary && s.name === b.companion.star && s.hip !== b.primaryHip);
        if (k < 0) continue;
        secondary = { star: k };
      } else {
        const c: CompanionStar = {
          index: this.companions.length, name: b.companion.name!, teff: b.companion.teff!, M: b.companion.M ?? 10,
          radius: b.companion.radius ?? 0, kind: b.companion.kind ?? 'star', binary: this.binaries.length,
        };
        // Radius from luminosity and temperature where it isn't measured (Stefan-Boltzmann).
        if (!c.radius) c.radius = Math.sqrt(10 ** (-0.4 * (c.M + bolometricCorrection(c.teff) - 4.74))) * (5772 / c.teff) ** 2;
        this.companions.push(c);
        secondary = { companion: c.index };
      }
      const binary: Binary = {
        data: b, primary, secondary, f: b.masses[1] / (b.masses[0] + b.masses[1]),
        scale: d * AU_KM, axes: skyAxes(dir), epochTdb: julianYearToTdb(b.epoch),
      };
      this.binaries.push(binary);
      this.binaryOf.set(primary, binary);
      if ('star' in secondary) this.binaryOf.set(secondary.star, binary);
    }

    stars.forEach((star, k) => {
      if (!star.planets) return;
      const list: PlanetInfo[] = [];
      const host = data.hosts[star.name] ?? {};
      const mStar = this.massOf(k, host);
      for (const p of star.planets) {
        const info = this.makePlanet(p, data.planets[p.name] ?? {}, k, mStar);
        if (!info) continue;
        this.planets.push(info);
        list.push(info);
      }
      if (list.length) this.planetsOf.set(k, list);
    });

    for (const f of data.featured) {
      const k = byName.get(f.star);
      if (k !== undefined) this.featured.push({ ...f, host: k });
    }
  }

  /** A named star's mass in Suns: dynamical for binaries, the archive's for hosts, else estimated. */
  massOf(k: number, host = this.data.hosts[this.stars[k].name]): number {
    const b = this.binaryOf.get(k);
    if (b) return b.primary === k ? b.data.masses[0] : b.data.masses[1];
    return host?.mass ?? this.fallbackMass(this.stars[k]);
  }

  companionMass(c: CompanionStar): number {
    return this.binaries[c.binary].data.masses[1];
  }

  private makePlanet(p: Exoplanet, x: PlanetExtra, host: number, mStar: number): PlanetInfo | undefined {
    const star = this.stars[host];
    // Kepler's third law fills in whichever of period and size is missing.
    let period = p.period, a = p.a;
    if (!period && a) period = 365.25 * Math.sqrt(a ** 3 / mStar);
    if (!a && period) a = Math.cbrt(mStar * (period / 365.25) ** 2);
    if (!period || !a) return undefined;
    const e = Math.min(0.97, Math.max(0, p.e ?? 0));
    const w = x.w ?? 90;
    const inclinationKnown = p.incl !== undefined || (!!x.transits && x.b !== undefined);
    // An unknown tilt is drawn at 60°, the median for orbits turned at random.
    let i = p.incl ?? (x.transits ? 89 : 60);
    // A transit's measured impact parameter fixes the tilt best: the composite table's
    // inclination, size of orbit and stellar radius can come from different papers.
    const rStarAu = (star.radius * SOLAR_RADIUS_KM) / AU_KM;
    if (x.transits && x.b !== undefined && x.b >= 0) {
      const cosI = (x.b * rStarAu * (1 + e * Math.sin(w * Math.PI / 180))) / (a * (1 - e * e));
      if (cosI < 1) i = (Math.acos(cosI) * 180) / Math.PI;
    }
    let tPeri = 0;
    let phaseKnown = true;
    if (x.tc !== undefined) tPeri = periastronFromTransit(jdToTdb(x.tc), period, e, w);
    else if (x.tp !== undefined) tPeri = jdToTdb(x.tp);
    else phaseKnown = false;
    const radiusEstimated = !p.radius;
    const massEstimated = !p.mass;
    const massMinimum = !!x.msini && !inclinationKnown;
    const mass = p.mass ?? (p.radius ? massFromRadius(p.radius) : 1);
    const radius = p.radius ?? radiusFromMass(mass);
    const teq = p.teq ?? star.teff * Math.sqrt((star.radius * SOLAR_RADIUS_KM) / (2 * a * AU_KM));
    const kind = planetKind(radius, mass, teq, !massEstimated);
    return {
      index: this.planets.length, name: p.name, host, data: p, extra: x,
      orbit: { period, a, e, w, i, node: 0, tPeri },
      radius, mass, radiusEstimated, massEstimated, massMinimum, inclinationKnown, phaseKnown, teq, kind,
      albedo: planetAlbedo(kind, teq),
      // Tidal locking within ~0.1 AU of a Sun-like star (sooner around small stars).
      locked: a < 0.1 * Math.cbrt(mStar) * 1.5 || period < 15,
    };
  }

  /** A named star's state (barycentric ICRF, km, km/s, km/s²): on its binary orbit if it has one. */
  starState(k: number, tdb: number, out?: State): State {
    const s = out ?? { p: [0, 0, 0], v: [0, 0, 0], acc: [0, 0, 0] };
    const b = this.binaryOf.get(k);
    if (b) return this.binaryState(b, b.primary === k ? 0 : 1, tdb, s);
    const star = this.stars[k];
    namedStarPosition(star, yearsSinceEpoch(tdb), s.p);
    for (let a = 0; a < 3; a++) {
      s.p[a] *= PC_KM;
      s.v[a] = star.vel[a];
      s.acc[a] = 0;
    }
    return s;
  }

  companionState(c: number, tdb: number, out?: State): State {
    return this.binaryState(this.binaries[this.companions[c].binary], 1, tdb, out ?? { p: [0, 0, 0], v: [0, 0, 0], acc: [0, 0, 0] });
  }

  /**
   * A binary star's member (0 primary, 1 secondary). The primary's catalogue position
   * and motion are its own at the catalogue epoch, orbit included: the barycentre is
   * set from them there and moves in a straight line, and each star circles it.
   */
  binaryState(b: Binary, member: 0 | 1, tdb: number, s: State): State {
    const star = this.stars[b.primary];
    const rel = this.relative(b, tdb);
    const ep = this.relative(b, b.epochTdb);
    namedStarPosition(star, yearsSinceEpoch(tdb), s.p);
    const k = member === 0 ? -b.f : 1 - b.f;
    const dt = tdb - b.epochTdb;
    for (let a = 0; a < 3; a++) {
      const bary = s.p[a] * PC_KM + b.f * (ep.p[a] + ep.v[a] * dt);
      const vBary = star.vel[a] + b.f * ep.v[a];
      s.p[a] = bary + k * rel.p[a];
      s.v[a] = vBary + k * rel.v[a];
      s.acc[a] = k * rel.acc[a];
    }
    return s;
  }

  /** Secondary minus primary, ICRF km. */
  relative(b: Binary, tdb: number): State {
    const o = visualOffset(b.data.orbit, tdb);
    const { north, east, away } = b.axes;
    const map = (q: Vec3): Vec3 => [0, 1, 2].map((a) => (north[a] * q[0] + east[a] * q[1] + away[a] * q[2]) * b.scale) as Vec3;
    return { p: map(o.p), v: map(o.v), acc: map(o.acc) };
  }

  /** A planet's state: its star's, plus its orbit. */
  planetState(j: number, tdb: number, out?: State): State {
    const info = this.planets[j];
    const s = this.starState(info.host, tdb, out);
    const o = planetOffset(info.orbit, tdb);
    const star = this.stars[info.host];
    const d = Math.hypot(...star.pos);
    const { north, east, away } = skyAxes([star.pos[0] / d, star.pos[1] / d, star.pos[2] / d]);
    for (let a = 0; a < 3; a++) {
      s.p[a] += (north[a] * o.p[0] + east[a] * o.p[1] + away[a] * o.p[2]) * AU_KM;
      s.v[a] += (north[a] * o.v[0] + east[a] * o.v[1] + away[a] * o.v[2]) * AU_KM;
      s.acc[a] += (north[a] * o.acc[0] + east[a] * o.acc[1] + away[a] * o.acc[2]) * AU_KM;
    }
    return s;
  }

  /** The planet's offset from its star, ICRF km (for drawing orbits). */
  planetOffsetIcrf(j: number, tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const info = this.planets[j];
    const o = planetOffset(info.orbit, tdb);
    const star = this.stars[info.host];
    const d = Math.hypot(...star.pos);
    const { north, east, away } = skyAxes([star.pos[0] / d, star.pos[1] / d, star.pos[2] / d]);
    for (let a = 0; a < 3; a++) out[a] = (north[a] * o.p[0] + east[a] * o.p[1] + away[a] * o.p[2]) * AU_KM;
    return out;
  }

  /** Visual luminosity of a named star in Suns (absolute V against the Sun's 4.83). */
  starLuminosityV(k: number): number {
    return 10 ** (-0.4 * (this.stars[k].M - 4.83));
  }

  /** GM of a planet, km³/s². */
  planetGm(info: PlanetInfo): number {
    return info.mass * EARTH_GM;
  }

  /** Radius of a planet's sphere of influence (Hill sphere at periastron), km. */
  planetInfluence(info: PlanetInfo): number {
    const mStar = this.massOf(info.host);
    return info.orbit.a * (1 - info.orbit.e) * AU_KM * Math.cbrt(info.mass / (3 * mStar * EARTH_MASSES_PER_SUN));
  }
}
