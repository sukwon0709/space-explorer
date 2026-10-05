import { pckRadii } from './iau';

/**
 * Every body drawn as a globe: the Sun, planets, major moons, Pluto and Charon, and the
 * four largest asteroids. Ids are NAIF ids. Planets use their centre ids (599 for
 * Jupiter), whose positions come from the satellite kernels once a system's moons file
 * has loaded; until then the ephemeris falls back to the system barycentre.
 *
 * Radii are from NAIF's pck00011 (IAU WGCCRE 2015). Geometric albedos are the visual
 * values from the JPL Solar System Dynamics physical parameter tables (planets: Mallama
 * et al. 2017); colours are approximate true colours, used for maps that are
 * monochrome and for bodies with no global map.
 */

export type Kind = 'star' | 'planet' | 'dwarf' | 'moon' | 'asteroid';
/** How sunlight reflects: rocky regolith, icy regolith, or a cloud deck (limb-darkened). */
export type Shading = 'rocky' | 'icy' | 'cloud';

export interface Body {
  id: number;
  name: string;
  kind: Kind;
  /** Equatorial and polar radius, km (mean of the two equatorial axes for triaxial bodies). */
  radius: [number, number];
  /** Triaxial radii, km (a along the prime meridian, b, c polar). */
  radii: [number, number, number];
  /** North pole RA/Dec, degrees (J2000), used when a body has no rotation model. */
  pole: [number, number];
  /** Approximate true colour (sRGB hex). */
  color: string;
  /** Visual geometric albedo. */
  albedo: number;
  shading: Shading;
  /** Global map in public/data/maps (see pipeline/build_maps.py). */
  map?: string;
  /** Body the orbit line is drawn around (NAIF id), and orbital period in days. */
  orbit?: { around: number; periodDays: number };
  /** Ephemeris file with this body's positions (moons-<system>.bin), if not DE440. */
  file?: string;
  emissive?: boolean;
}

type Spec = Omit<Body, 'radius' | 'radii' | 'pole'> & { radii?: [number, number, number]; pole?: [number, number] };

const SPECS: Spec[] = [
  { id: 10, name: 'Sun', kind: 'star', color: '#fff4e0', albedo: 1, shading: 'cloud', emissive: true },
  { id: 199, name: 'Mercury', kind: 'planet', color: '#a19a92', albedo: 0.142, shading: 'rocky', map: 'mercury', orbit: { around: 10, periodDays: 87.969 } },
  { id: 299, name: 'Venus', kind: 'planet', color: '#f1e6c8', albedo: 0.689, shading: 'cloud', orbit: { around: 10, periodDays: 224.701 } },
  { id: 399, name: 'Earth', kind: 'planet', color: '#4a78b5', albedo: 0.434, shading: 'rocky', orbit: { around: 10, periodDays: 365.256 } },
  { id: 301, name: 'Moon', kind: 'moon', color: '#a9a59e', albedo: 0.12, shading: 'rocky', orbit: { around: 399, periodDays: 27.3217 } },
  { id: 499, name: 'Mars', kind: 'planet', color: '#c1673f', albedo: 0.17, shading: 'rocky', map: 'mars', orbit: { around: 10, periodDays: 686.98 } },
  { id: 401, name: 'Phobos', kind: 'moon', color: '#6e655c', albedo: 0.071, shading: 'rocky', map: 'phobos', orbit: { around: 499, periodDays: 0.31891 }, file: 'mars' },
  { id: 402, name: 'Deimos', kind: 'moon', color: '#7a7068', albedo: 0.068, shading: 'rocky', orbit: { around: 499, periodDays: 1.26244 }, file: 'mars' },
  { id: 2000001, name: 'Ceres', kind: 'dwarf', color: '#8c8780', albedo: 0.09, shading: 'rocky', map: 'ceres', orbit: { around: 10, periodDays: 1680.1 }, file: 'asteroids' },
  { id: 2000004, name: 'Vesta', kind: 'asteroid', color: '#a8a39b', albedo: 0.423, shading: 'rocky', map: 'vesta', orbit: { around: 10, periodDays: 1325.8 }, file: 'asteroids' },
  { id: 2000002, name: 'Pallas', kind: 'asteroid', color: '#8f8c88', albedo: 0.101, shading: 'rocky', orbit: { around: 10, periodDays: 1686 }, file: 'asteroids', radii: [275, 258, 238] },
  { id: 2000010, name: 'Hygiea', kind: 'asteroid', color: '#6f6b66', albedo: 0.072, shading: 'rocky', orbit: { around: 10, periodDays: 2031 }, file: 'asteroids', radii: [225, 215, 210], pole: [306, 66] },
  { id: 599, name: 'Jupiter', kind: 'planet', color: '#d8c3a0', albedo: 0.538, shading: 'cloud', map: 'jupiter', orbit: { around: 10, periodDays: 4332.59 } },
  { id: 501, name: 'Io', kind: 'moon', color: '#d9c66b', albedo: 0.63, shading: 'rocky', map: 'io', orbit: { around: 599, periodDays: 1.769138 }, file: 'jupiter' },
  { id: 502, name: 'Europa', kind: 'moon', color: '#d9cdb4', albedo: 0.67, shading: 'icy', map: 'europa', orbit: { around: 599, periodDays: 3.551181 }, file: 'jupiter' },
  { id: 503, name: 'Ganymede', kind: 'moon', color: '#a49a8a', albedo: 0.43, shading: 'icy', map: 'ganymede', orbit: { around: 599, periodDays: 7.154553 }, file: 'jupiter' },
  { id: 504, name: 'Callisto', kind: 'moon', color: '#8f8270', albedo: 0.22, shading: 'rocky', map: 'callisto', orbit: { around: 599, periodDays: 16.689018 }, file: 'jupiter' },
  { id: 699, name: 'Saturn', kind: 'planet', color: '#e3d3a4', albedo: 0.499, shading: 'cloud', map: 'saturn', orbit: { around: 10, periodDays: 10759.22 } },
  { id: 601, name: 'Mimas', kind: 'moon', color: '#d8d6d2', albedo: 0.962, shading: 'icy', orbit: { around: 699, periodDays: 0.942422 }, file: 'saturn' },
  { id: 602, name: 'Enceladus', kind: 'moon', color: '#f2f2ef', albedo: 1.375, shading: 'icy', map: 'enceladus', orbit: { around: 699, periodDays: 1.370218 }, file: 'saturn' },
  { id: 603, name: 'Tethys', kind: 'moon', color: '#e6e2db', albedo: 1.229, shading: 'icy', map: 'tethys', orbit: { around: 699, periodDays: 1.887802 }, file: 'saturn' },
  { id: 604, name: 'Dione', kind: 'moon', color: '#dcd8d0', albedo: 0.998, shading: 'icy', map: 'dione', orbit: { around: 699, periodDays: 2.736915 }, file: 'saturn' },
  { id: 605, name: 'Rhea', kind: 'moon', color: '#d9d4ca', albedo: 0.949, shading: 'icy', map: 'rhea', orbit: { around: 699, periodDays: 4.5175 }, file: 'saturn' },
  { id: 606, name: 'Titan', kind: 'moon', color: '#d9a35b', albedo: 0.22, shading: 'cloud', orbit: { around: 699, periodDays: 15.945421 }, file: 'saturn' },
  { id: 607, name: 'Hyperion', kind: 'moon', color: '#b5a48f', albedo: 0.3, shading: 'icy', orbit: { around: 699, periodDays: 21.276609 }, file: 'saturn', pole: [40.589, 83.537] },
  { id: 608, name: 'Iapetus', kind: 'moon', color: '#d6c9b0', albedo: 0.6, shading: 'icy', map: 'iapetus', orbit: { around: 699, periodDays: 79.330183 }, file: 'saturn' },
  { id: 609, name: 'Phoebe', kind: 'moon', color: '#5d5853', albedo: 0.081, shading: 'rocky', orbit: { around: 699, periodDays: 550.31 }, file: 'saturn' },
  { id: 799, name: 'Uranus', kind: 'planet', color: '#b3d6dc', albedo: 0.488, shading: 'cloud', map: 'uranus', orbit: { around: 10, periodDays: 30685.4 } },
  { id: 705, name: 'Miranda', kind: 'moon', color: '#b6b2ad', albedo: 0.32, shading: 'icy', orbit: { around: 799, periodDays: 1.413479 }, file: 'uranus' },
  { id: 701, name: 'Ariel', kind: 'moon', color: '#b9b5b0', albedo: 0.53, shading: 'icy', orbit: { around: 799, periodDays: 2.520379 }, file: 'uranus' },
  { id: 702, name: 'Umbriel', kind: 'moon', color: '#77736f', albedo: 0.26, shading: 'icy', orbit: { around: 799, periodDays: 4.144177 }, file: 'uranus' },
  { id: 703, name: 'Titania', kind: 'moon', color: '#a7a19a', albedo: 0.35, shading: 'icy', orbit: { around: 799, periodDays: 8.705872 }, file: 'uranus' },
  { id: 704, name: 'Oberon', kind: 'moon', color: '#9c938b', albedo: 0.31, shading: 'icy', orbit: { around: 799, periodDays: 13.463239 }, file: 'uranus' },
  { id: 899, name: 'Neptune', kind: 'planet', color: '#a6c5da', albedo: 0.442, shading: 'cloud', map: 'neptune', orbit: { around: 10, periodDays: 60189 } },
  { id: 801, name: 'Triton', kind: 'moon', color: '#d8cbc0', albedo: 0.76, shading: 'icy', map: 'triton', orbit: { around: 899, periodDays: 5.876854 }, file: 'neptune' },
  { id: 999, name: 'Pluto', kind: 'dwarf', color: '#d2b394', albedo: 0.52, shading: 'icy', map: 'pluto', orbit: { around: 10, periodDays: 90560 } },
  { id: 901, name: 'Charon', kind: 'moon', color: '#b1a79e', albedo: 0.41, shading: 'icy', map: 'charon', orbit: { around: 999, periodDays: 6.38723 }, file: 'pluto' },
];

export const BODIES: Body[] = SPECS.map((s) => {
  const radii = s.radii ?? pckRadii(s.id);
  if (!radii) throw new Error(`No radii for ${s.name}`);
  return { ...s, radii, radius: [(radii[0] + radii[1]) / 2, radii[2]], pole: s.pole ?? [0, 90] };
});

/** NAIF ids of planet systems whose moons files load on demand: system name -> planet id. */
export const SYSTEMS: Record<string, number> = { mars: 499, jupiter: 599, saturn: 699, uranus: 799, neptune: 899, pluto: 999, asteroids: 10 };

/**
 * Ring systems, km from the planet's centre, in its equator plane. Saturn's radial
 * profile comes from a Cassini occultation (see rings.ts); the others are narrow,
 * dark rings with widths and normal optical depths from Voyager and ground-based
 * occultations (Uranus: French et al. 1991; Neptune: Porco et al. 1995; Jupiter:
 * Throop et al. 2004), widened where a ring is narrower than a pixel would show.
 */
export interface Ringlet { name: string; inner: number; outer: number; tau: number }
export const RINGS: Record<number, { color: string; albedo: number; bands: Ringlet[] }> = {
  599: {
    color: '#b59c80', albedo: 0.05,
    bands: [
      { name: 'Halo', inner: 92000, outer: 122500, tau: 1e-6 },
      { name: 'Main ring', inner: 122500, outer: 129000, tau: 5e-6 },
      { name: 'Amalthea gossamer ring', inner: 129000, outer: 182000, tau: 1e-7 },
    ],
  },
  699: {
    color: '#e2d2b4', albedo: 0.5,
    bands: [
      { name: 'D ring', inner: 66900, outer: 74510, tau: 0.002 },
      { name: 'C ring', inner: 74658, outer: 92000, tau: 0.1 },
      { name: 'B ring', inner: 92000, outer: 117580, tau: 2.0 },
      { name: 'Cassini Division', inner: 117580, outer: 122170, tau: 0.1 },
      { name: 'A ring', inner: 122170, outer: 136775, tau: 0.5 },
      { name: 'F ring', inner: 140180, outer: 140270, tau: 0.5 },
    ],
  },
  799: {
    color: '#5b5a58', albedo: 0.02,
    bands: [
      { name: 'Ring 6', inner: 41837, outer: 41839, tau: 0.3 },
      { name: 'Ring 5', inner: 42234, outer: 42237, tau: 0.5 },
      { name: 'Ring 4', inner: 42571, outer: 42574, tau: 0.3 },
      { name: 'Alpha', inner: 44711, outer: 44721, tau: 0.4 },
      { name: 'Beta', inner: 45654, outer: 45665, tau: 0.3 },
      { name: 'Eta', inner: 47174, outer: 47176, tau: 0.4 },
      { name: 'Gamma', inner: 47625, outer: 47629, tau: 1.5 },
      { name: 'Delta', inner: 48298, outer: 48304, tau: 0.5 },
      { name: 'Epsilon', inner: 51124, outer: 51182, tau: 1.0 },
    ],
  },
  899: {
    color: '#6e6a66', albedo: 0.04,
    bands: [
      { name: 'Galle', inner: 40900, outer: 42900, tau: 1e-4 },
      { name: 'Le Verrier', inner: 53150, outer: 53250, tau: 0.02 },
      { name: 'Lassell', inner: 53200, outer: 57200, tau: 1.5e-4 },
      { name: 'Adams', inner: 62918, outer: 62968, tau: 0.03 },
    ],
  },
};

export function bodyById(id: number): Body {
  const body = BODIES.find((b) => b.id === id);
  if (!body) throw new Error(`Unknown body ${id}`);
  return body;
}

export function findBody(id: number): Body | undefined {
  return BODIES.find((b) => b.id === id);
}
