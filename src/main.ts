import * as THREE from 'three';
import { Ephemeris } from './core/ephemeris';
import { Orientation } from './core/orientation';
import { BODIES, RINGS, SYSTEMS, bodyById, findBody, type Body } from './core/bodies';
import { Clock, tdbToUtc, utcToTdb } from './core/time';
import { parseSatellites, type SatelliteSnapshot } from './core/satellites';
import { OBLIQUITY_J2000, icrfToScene, length, raDecToIcrf, sceneToIcrf, sub } from './core/frames';
import type { Vec3 } from './core/ephemeris';
import { bodyToGeodetic, enu, geodeticToBody, MARS_SPHERE, MOON_SPHERE, WGS84, type Shape } from './core/geodesy';
import { TileStore, type Manifest } from './core/tilestore';
import { asteroidOrbit, cometOrbit, orbitPosition, parseAsteroids, type AsteroidSet, type Comet, type Orbit } from './core/smallbodies';
import { AU, SUN_RADIUS, SolarSystem, lockedFrame } from './render/world';
import { CameraRig, SCENE_BASIS, type Anchor, type Frame } from './render/camera';
import { Globe, type GlobeFrame, type SurfaceKind } from './render/globe';
import { EarthSky } from './render/sky';
import { ThickSky, TITAN_AIR, VENUS_AIR, belowDeck, diffuseLight, tauAbove, veil, type ThickAirParams } from './render/thickair';
import { reliefHeight, type ReliefMap, type ReliefParams } from './core/relief';
import { discOverlap } from './render/shadow';
import { SmallBodies } from './render/smallbodies';
import { albedoScale } from './render/planets';
import { StarField, makeSingleStar, type DustGrid } from './render/stars';
import { Constellations, type ConstellationData } from './render/constellations';
import { StarGlobe } from './render/starglobe';
import { CATALOGUE_PRECISION, Systems } from './systems';
import type { SystemsData } from './core/systems';
import { SUN_SURFACE_BRIGHTNESS } from './render/sun';
import { MilkyWayGlow } from './render/milkyway';
import { icrsPcToGalactocentric } from './core/milkyway';
import { DeepSky } from './deepsky';
import { BlackHoles, type SStar } from './blackholes';
import { COSMIC_KEYS, CosmicEvents, GW_PEAK, type CosmicData, type CosmicKey } from './cosmic';
import { CosmicPanel, type CosmicChart } from './ui/cosmicpanel';
import { DAY as DAY_S, SN1987A } from './core/supernova';
import { bandpass, matchModel } from './core/merger';
import { EhtPanel, type EhtMeta } from './ui/ehtpanel';
import { MPC_KM, type GalaxyIndex } from './core/galaxies';
import type { SkyImage } from './render/images';
import type { GalaxyModelSpec } from './core/galaxymodel';
import { CmbLayer } from './render/cmb';
import { PC_KM, apparentMagnitude, namedStarPosition, parseStarIndex, yearsSinceEpoch, type Exoplanet, type NamedStar } from './core/stars';
import { NAMED_SATELLITES, SatelliteLayer } from './render/satellites';
import { formatDistance, formatUtc, formatYears as formatYearCount } from './ui/format';
import { eventGroups, type EventCatalogue, type SkyEvent } from './ui/events';
import eventCatalogue from './generated/events.json';
import { Visitor } from './render/visitors';
import { Trajectory, SOI, type BodyPosition } from './core/mission';
import { MissionView } from './render/mission';
import { MISSIONS } from './ui/missions';
import { MissionPanel, type MissionData, type Moment } from './ui/missionpanel';
import missionCatalogue from './generated/missions.json';
import { TOURS, TourPlayer, type TourStep } from './ui/tours';
import { FlightControls, FlightHud } from './ui/flight';
import { WalkControls } from './ui/walk';
import { Walker, type WalkWorld } from './core/walker';
import { ShapeWalker, tangent, type ShapeWalkWorld } from './core/shapewalk';
import { ShapeBody, type ShapeFrame } from './render/shapebody';
import type { Mat3 } from './core/orientation';
import { Lander } from './render/lander';
import { BOOST, Ship, apsides, type FlightWorld, type Source, type WarpLimiter } from './core/flight';
import { C_KMS, G0, GM, SolarGravity, parentOf } from './core/gravity';
import { Forecast } from './core/forecast';
import { encounter, flybyStart, stretch } from './core/slingshot';
import { ForecastLine, WellGrid, type Dent } from './render/gravitywell';
import { SUN_V, Trip, aberrate, betaOf, doppler, forwardBackgroundFlux, freeStep, gammaOf, surfaceGain } from './core/relativity';
import { relativityUniforms, setRelativity } from './render/relativity';
import { hasRotation, iauBodyToScene } from './core/iau';
import { horizon } from './core/kerr';
import { SUN_GM_KM } from './core/blackholes';
import manifest from './generated/tiles.json';
import cloudsMeta from './generated/clouds.json';
import mapsMeta from './generated/maps.json';
import sunMeta from './generated/sun.json';

const DEG = Math.PI / 180;
const BASE = import.meta.env.BASE_URL;
/** Search targets that are not globes get ids above these: asteroid or comet index added. */
const ASTEROID_ID = 30_000_000;
const COMET_ID = 40_000_000;
/** Named stars (stars/named.json) get ids from here, plus their index. */
const STAR_ID = 50_000_000;
/** Spacecraft on their missions (ui/missions.ts), by index. */
const CRAFT_ID = 45_000_000;
const MISSION_DATA = missionCatalogue as unknown as Record<string, MissionData>;
const SOLAR_RADIUS = 695700;
/** How much deeper (magnitudes) diffuse light is shown than point sources. */
const DIFFUSE_GAIN = 3;
/** Mars tiles store twice the surface's normal albedo (pipeline/build_surfaces.py). */
const MARS_ALBEDO_SCALE = 0.5;
/** Worlds with terrain tiles besides Earth, the Moon and Mars (pipeline/build_worlds.py). */
interface WorldInfo {
  body: number;
  name: string;
  radius: number;
  mean: Vec3;
  /** Surface albedo and colour where the body's own are its clouds' (Venus, Titan). */
  albedo?: number;
  color?: string;
  atmosphere?: 'venus' | 'titan';
  /** A relief map (public/data/relief) steers computed detail (relief.ts). */
  relief?: boolean;
}
const WORLDS = (manifest as unknown as { worlds?: WorldInfo[] }).worlds ?? [];
const THICK_AIR = { venus: VENUS_AIR, titan: TITAN_AIR };
/** Computed relief: longest wavelength (about twice the elevation model's real resolution) and dunes. */
const RELIEF: Record<string, Omit<ReliefParams, 'radius'>> = {
  venus: { maxWavelength: 16 },
  titan: { maxWavelength: 24, dunes: { spacing: 3, height: 0.1 } },
};
/** A world's terrain replaces its plain globe once it is this many pixels across. */
const TERRAIN_PIXELS = 48;

interface Surface {
  globe: Globe;
  shape: Shape;
  /** Body-fixed to scene rotation for the current frame. */
  bodyToScene: Float64Array;
  sky?: EarthSky | ThickSky;
  /** A thick atmosphere: the ground shows only from below its deck. */
  air?: ThickAirParams;
  /** Ground albedo for exposure, where the body's own albedo is its clouds'. */
  albedo?: number;
}

interface MapInfo {
  source: string;
  kind: string;
  coverage: number;
  mean: Vec3;
}

interface Target {
  id: number;
  name: string;
  /** Detail line for the HUD. */
  kind: string;
  /** Radius used for viewing distances, km. */
  radius: number;
}

/** Places to land and walk, by name in the search box: where the data is sharpest. */
interface Site {
  name: string;
  aliases: string[];
  body: number;
  lat: number;
  lon: number;
  /** Camera on arrival: distance (km), heading and tilt (degrees). */
  dist: number;
  heading: number;
  tilt: number;
  /** Named features (IAU): size, km. */
  diameter?: number;
}

/** Named surface features of the worlds with terrain (pipeline/build_features.py). */
interface FeatureData {
  bodies: Record<string, [name: string, lat: number, lon: number, diameter: number, type: string][]>;
}
const FEATURES: Site[] = [];

const SITES: Site[] = [
  // 25 m west of Eagle's descent stage (see `eagle` below), facing it.
  { name: 'Tranquility Base (Apollo 11)', aliases: ['tranquility base', 'apollo 11', 'apollo11', 'eagle'], body: 301, lat: 0.67416, lon: 23.47232, dist: 0.04, heading: 90, tilt: 12 },
  // Perseverance's landing site, Octavia E. Butler Landing (NASA/JPL).
  { name: 'Jezero crater (Perseverance)', aliases: ['jezero', 'jezero crater', 'perseverance', 'octavia e. butler landing'], body: 499, lat: 18.4447, lon: 77.4508, dist: 0.25, heading: 280, tilt: 18 },
  { name: 'Grand Canyon (Mather Point)', aliases: ['grand canyon', 'mather point'], body: 399, lat: 36.0618, lon: -112.1076, dist: 0.3, heading: 0, tilt: 10 },
  // Landers on the worlds with thick atmospheres: Venera 13 and 14 (7.55 S 303.69 E,
  // 13.05 S 310.19 E; Basilevsky et al. 1985) and Huygens (10.573 S 192.335 W; Karkoschka
  // et al. 2016).
  { name: 'Venera 13 landing site (Venus)', aliases: ['venera 13', 'venera13', 'venera'], body: 299, lat: -7.55, lon: -56.31, dist: 0.05, heading: 0, tilt: 8 },
  { name: 'Venera 14 landing site (Venus)', aliases: ['venera 14', 'venera14'], body: 299, lat: -13.05, lon: -49.81, dist: 0.05, heading: 0, tilt: 8 },
  { name: 'Huygens landing site (Titan)', aliases: ['huygens', 'huygens landing site'], body: 606, lat: -10.573, lon: 167.665, dist: 0.05, heading: 90, tilt: 8 },
];

/**
 * The nearest site on a body within 50 km, or named feature within its own size (and
 * at least 50 km): name, distance (km) and compass direction.
 */
function nearestSite(body: number, lon: number, lat: number): { name: string; distance: number; direction: string } | undefined {
  const DEG = Math.PI / 180;
  let best: { name: string; distance: number; direction: string } | undefined;
  const R = bodyById(body).radius[0];
  for (const site of [...SITES, ...FEATURES]) {
    if (site.body !== body) continue;
    const dLat = site.lat * DEG - lat, dLon = ((site.lon * DEG - lon + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    const n = dLat * R, e = dLon * Math.cos(lat) * R;
    const distance = Math.hypot(n, e);
    if (distance > Math.max(50, site.diameter ?? 0) || (best && distance > best.distance)) continue;
    const az = (Math.atan2(e, n) / DEG + 360) % 360;
    best = { name: site.name.replace(/ \(.*\)$/, ''), distance, direction: distance < 0.002 ? 'here' : ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(az / 45) % 8] };
  }
  return best;
}

async function main() {
  // The live cosmic events' data (pipeline/fetch_cosmic.py), loaded alongside the rest.
  const cosmicLoad: Promise<CosmicData> = Promise.all(['sn1987a', 'gw150914', 'pms'].map((name) => fetch(`${BASE}data/cosmic/${name}.json`).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined)))
    .then(([sn1987a, gw, pms]) => ({ sn1987a, gw, pms }));
  const [ephemeris, orientation, starIndexRaw, namedStars, constellationData, dust, cloudTexture, satelliteSnapshot, smallBuffer, asteroidsBuffer, cometData, asteroidNames, saturnRings, galaxyIndex, galaxyBuffer, skyImages, sstarData, ehtMeta, galaxyModels, systemsData] = await Promise.all([
    Ephemeris.load(`${BASE}data/de440.bin`),
    Orientation.load(`${BASE}data/orientation.bin`),
    fetch(`${BASE}data/stars/index.json`).then((r) => r.json()),
    fetch(`${BASE}data/stars/named.json`).then((r) => r.json() as Promise<NamedStar[]>).catch(() => [] as NamedStar[]),
    fetch(`${BASE}data/stars/constellations.json`).then((r) => r.json() as Promise<ConstellationData>).catch(() => undefined),
    loadDust(`${BASE}data/dust`).catch(() => undefined),
    new THREE.TextureLoader().loadAsync(`${BASE}data/clouds.png`).catch(() => undefined),
    fetch(`${BASE}data/satellites.json`).then((r) => r.json() as Promise<SatelliteSnapshot>).catch(() => undefined),
    Ephemeris.fetch(`${BASE}data/moons-asteroids.bin`).catch(() => undefined),
    fetch(`${BASE}data/asteroids.bin`).then((r) => r.arrayBuffer()).catch(() => undefined),
    fetch(`${BASE}data/comets.json`).then((r) => r.json() as Promise<{ comets: Comet[] }>).catch(() => ({ comets: [] as Comet[] })),
    fetch(`${BASE}data/asteroid-names.json`).then((r) => r.json() as Promise<Array<{ name: string; designation: string; index: number }>>).catch(() => []),
    fetch(`${BASE}data/saturn-rings.json`).then((r) => r.json()).catch(() => undefined),
    fetch(`${BASE}data/galaxies/index.json`).then((r) => r.json() as Promise<GalaxyIndex>).catch(() => undefined),
    fetch(`${BASE}data/galaxies/local.bin`).then((r) => (r.ok ? r.arrayBuffer() : undefined)).catch(() => undefined),
    fetch(`${BASE}data/images/index.json`).then((r) => r.json() as Promise<{ images: SkyImage[] }>).then((j) => j.images).catch(() => [] as SkyImage[]),
    fetch(`${BASE}data/blackholes/sstars.json`).then((r) => r.json() as Promise<{ stars: SStar[] }>).then((j) => j.stars).catch(() => [] as SStar[]),
    fetch(`${BASE}data/blackholes/eht.json`).then((r) => r.json() as Promise<Record<string, EhtMeta>>).catch(() => ({}) as Record<string, EhtMeta>),
    fetch(`${BASE}data/galaxies/models.json`).then((r) => r.json() as Promise<{ models: GalaxyModelSpec[] }>).then((j) => j.models).catch(() => [] as GalaxyModelSpec[]),
    fetch(`${BASE}data/stars/systems.json`).then((r) => r.json() as Promise<SystemsData>).catch(() => ({ planets: {}, hosts: {}, binaries: [], featured: [] }) as SystemsData),
  ]);
  if (smallBuffer) ephemeris.add(smallBuffer);
  // Didymos's orbit is its system's barycentre: the primary sits off it by Dimorphos's
  // share of the mass, opposite Dimorphos (moons-visited.bin).
  ephemeris.setBarycentre(2065803, 120065803, GM[120065803] / (GM[2065803] + GM[120065803]));
  const asteroids: AsteroidSet | undefined = asteroidsBuffer ? parseAsteroids(asteroidsBuffer) : undefined;
  // Defunct comets (D/, such as the fragments of Shoemaker-Levy 9) and sungrazers that
  // did not survive perihelion would be drawn on orbits nothing follows any more.
  // (Comets drawn from their shape models are bodies of their own.)
  const comets = cometData.comets.filter((c) => !c.name.startsWith('D/') && c.q > 0.02 && !BODIES.some((b) => b.name === c.name || b.aliases?.includes(c.name)));

  // URL parameters make any view reproducible:
  //   ?focus=Earth&lat=36.06&lon=-112.14&dist=3&heading=20&tilt=12&t=2026-10-05T16:00Z
  //   ?focus=Saturn&t=2017-06-15T00:00Z&dist=420000&yaw=0.9&pitch=0.45&rate=86400
  const params = new URLSearchParams(location.search);
  const startTime = params.has('t') ? Date.parse(params.get('t')!) : Date.now();
  const clock = new Clock(startTime, Math.max(ephemeris.start, orientation.start), Math.min(ephemeris.end, orientation.end));
  if (params.has('rate')) clock.rate = Number(params.get('rate'));

  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: params.has('capture') });
  // Quality: ?quality=low|high, else low on phones and tablets. Low draws at most one
  // pixel per CSS pixel, loads fewer faint stars and traces black holes with longer steps.
  const handheld = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 900;
  const quality = params.get('quality') ?? (handheld ? 'low' : 'auto');
  const maxPixelRatio = Math.min(devicePixelRatio, quality === 'low' ? 1 : 2);
  let pixelRatio = maxPixelRatio;
  renderer.setPixelRatio(pixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 1e-5, 1e13);
  const starIndex = parseStarIndex(starIndexRaw);
  const stars = new StarField(starIndex, (k) => `${BASE}data/stars/pack-${k}.bin`, renderer.getPixelRatio(), dust);
  scene.add(stars.group);
  // The Sun as a star, once the camera is far enough away that its disc is a point.
  const sunStar = makeSingleStar(stars.material, 4.83, Math.round((255 * Math.log(5772 / starIndex.teff[0])) / Math.log(starIndex.teff[1])));
  scene.add(sunStar);
  const constellations = constellationData ? new Constellations(constellationData, stars.uniforms) : undefined;
  if (constellations) scene.add(constellations.lines);
  const starGlobe = new StarGlobe();
  scene.add(starGlobe.group);
  // Other star systems: binary companions and exoplanets on their orbits.
  const sys = new Systems(namedStars, systemsData, STAR_ID, stars.material, starMass);
  scene.add(sys.group);
  const teffCode = (t: number) => (255 * Math.log(t / starIndex.teff[0])) / Math.log(starIndex.teff[1]);
  const glow = new MilkyWayGlow(dust);
  scene.add(glow.composite);
  const deep = new DeepSky(
    galaxyIndex, galaxyBuffer, skyImages, renderer.getPixelRatio(), Math.min(8, renderer.capabilities.getMaxAnisotropy()),
    `${BASE}data/galaxies/deep.bin`, `${BASE}data/images/`, galaxyModels, `${BASE}data/galaxies/models/`, quality === 'low' ? 72 : 160,
  );
  scene.add(deep.layer.group);
  let cmb: CmbLayer | undefined;
  new THREE.TextureLoader().loadAsync(`${BASE}data/cmb.png`).then((map) => {
    cmb = new CmbLayer(map, deep.cosmology.lastScattering);
    scene.add(cmb.mesh);
  }).catch(() => undefined);

  // Black holes, with the S-stars and the companions drawn by the star field's shader.
  const bhs = new BlackHoles(stars.material, starIndex.teff, sstarData);
  scene.add(bhs.stars.points);
  bhs.view.setQuality(quality === 'low' ? 'low' : quality === 'high' ? 'high' : 'normal');
  // Live cosmic events: supernovae, a star being born, two black holes merging.
  const cosmicData = await cosmicLoad;
  const betelgeuseIndex = namedStars.findIndex((s) => s.name === 'Betelgeuse');
  const cosmic = new CosmicEvents(stars.material, teffCode, cosmicData, () => (betelgeuseIndex >= 0 ? sys.position(STAR_ID + betelgeuseIndex, clock.tdb) : undefined));
  scene.add(cosmic.group);
  cosmic.lens.setQuality(quality === 'low' ? 'low' : quality === 'high' ? 'high' : 'normal');

  const textureLoader = new THREE.TextureLoader();
  const sunMap = await textureLoader.loadAsync(`${BASE}data/maps/sun.jpg`).catch(() => undefined);
  if (sunMap) prepareMap(sunMap, renderer);
  const system = new SolarSystem(ephemeris, orientation, { sunMap, sunScale: sunMeta.scale, saturnRings });
  scene.add(system.group);
  // Small bodies spacecraft visited, drawn from their shape models once near
  // (render/shapebody.ts); far off, their plain globes stand in.
  const shapes = new Map<number, ShapeBody>();
  for (const body of BODIES) {
    if (!body.shape) continue;
    const view = new ShapeBody(body.shape, `${BASE}data/shapes/`, albedoScale(body, undefined));
    scene.add(view.group);
    shapes.set(body.id, view);
  }

  // ---- global maps and moons, loaded as they are needed -------------------------
  let loading = 0;
  const track = <T,>(p: Promise<T>) => {
    loading++;
    return p.finally(() => loading--);
  };
  const maps = mapsMeta as unknown as Record<string, MapInfo>;
  const mapRequested = new Set<string>();
  const requestMap = (name: string | undefined) => {
    if (!name || mapRequested.has(name) || !maps[name]) return;
    mapRequested.add(name);
    track(textureLoader.loadAsync(`${BASE}data/maps/${name}.jpg`))
      .then((t) => system.setMap(name, prepareMap(t, renderer), maps[name].mean))
      .catch((err) => console.warn(`map ${name}:`, err));
  };
  const systemRequested = new Set<string>();
  const requestSystem = (name: string) => {
    if (systemRequested.has(name)) return;
    systemRequested.add(name);
    track(Ephemeris.fetch(`${BASE}data/moons-${name}.bin`))
      .then((buffer) => ephemeris.add(buffer))
      .catch((err) => console.warn(`moons ${name}:`, err));
  };
  const shapeRequested = new Set<number>();
  const requestShape = (id: number) => {
    const view = shapes.get(id);
    if (!view || shapeRequested.has(id)) return;
    shapeRequested.add(id);
    track(view.load()).catch((err) => console.warn(`shape ${id}:`, err));
  };
  /** Load what a body needs to be drawn properly: its system's moons and the maps there. */
  const prepare = (id: number) => {
    const body = findBody(id);
    if (!body) return;
    requestShape(id);
    // A binary asteroid: both shapes.
    for (const b of BODIES) if (b.shape && (b.orbit?.around === id || b.id === body.orbit?.around)) requestShape(b.id);
    const planet = body.orbit && body.orbit.around !== 10 ? body.orbit.around : body.id;
    for (const [name, planetId] of Object.entries(SYSTEMS)) if (planetId === planet) requestSystem(name);
    if (body.file) requestSystem(body.file);
    for (const b of BODIES) if (b.id === planet || b.orbit?.around === planet) requestMap(b.map);
  };

  // ---- surfaces with terrain: Earth, the Moon, Mars and every other solid world -----
  const store = new TileStore(manifest as unknown as Manifest, `${BASE}data/tiles/`);
  const surfaces = new Map<number, Surface>();
  /** Body-fixed to scene rotation: the measured one for Earth and the Moon, else the IAU model. */
  const rotationAt = (id: number, tdb: number, out: Float64Array) => {
    if (orientation.has(id)) return orientation.bodyToScene(id, tdb, out);
    if (hasRotation(id)) return iauBodyToScene(id, tdb, out);
    const body = findBody(id);
    if (body?.shape && body.orbit && body.orbit.around !== 10 && ephemeris.available(id, tdb + 60)) return lockedFrame(ephemeris, id, body.orbit.around, tdb, out);
    return undefined;
  };
  // The other worlds (pipeline/build_worlds.py): a reference sphere, and their tiles'
  // mean colour, scaled to the body's albedo as its distant globe is (planets.ts).
  const terrain: [number, Shape, SurfaceKind, Vec3][] = [
    [399, WGS84, 'earth', [1, 1, 1]],
    [301, MOON_SPHERE, 'airless', [0.4, 0.4, 0.4]],
    [499, MARS_SPHERE, 'mars', [MARS_ALBEDO_SCALE, MARS_ALBEDO_SCALE, MARS_ALBEDO_SCALE]],
    ...WORLDS.map((w): [number, Shape, SurfaceKind, Vec3] => {
      const body = bodyById(w.body);
      const ground = w.albedo !== undefined ? { ...body, albedo: w.albedo, color: w.color ?? body.color } : body;
      return [w.body, { a: w.radius, b: w.radius }, w.atmosphere ? 'thick' : 'airless', albedoScale(ground, w.mean)];
    }),
  ];
  for (const [id, shape, kind, albedo] of terrain) {
    if (!store.hasBody(id) || !rotationAt(id, clock.tdb, new Float64Array(9))) continue;
    const world = WORLDS.find((w) => w.body === id);
    const air = world?.atmosphere ? THICK_AIR[world.atmosphere] : undefined;
    let relief: ((lon: number, lat: number, spacing: number) => number) | undefined;
    let reliefReady: Promise<unknown> | undefined;
    if (world?.relief && RELIEF[world.name]) {
      // The map is small; tiles wait for it (or build without relief if it fails).
      let map: ReliefMap | undefined;
      const params: ReliefParams = { radius: world.radius, ...RELIEF[world.name] };
      reliefReady = loadReliefMap(`${BASE}data/relief/${world.name}.png`).then((m) => (map = m)).catch((err) => console.warn(`relief ${world.name}:`, err));
      relief = (lon, lat, spacing) => (map ? reliefHeight(map, params, lon, lat, spacing) : 0);
    }
    const globe = new Globe(id, shape, store, kind, { air, relief, reliefReady });
    globe.uniforms.uAlbedoScale.value.set(...albedo);
    // Close-up grain on bare rock; Earth's ground is too varied for one texture.
    globe.uniforms.uDetail.value = kind === 'earth' ? 0 : 1;
    if (id === 301) globe.uniforms.uEclTint.value.set(0.02, 0.006, 0.002);
    const surface: Surface = { globe, shape, bodyToScene: new Float64Array(9), air, albedo: world?.albedo };
    if (air) {
      surface.sky = new ThickSky(air, globe.uniforms);
      scene.add(surface.sky.group);
    } else if (kind !== 'airless') {
      surface.sky = new EarthSky(globe, kind === 'earth' ? cloudTexture : undefined);
      scene.add(surface.sky.group);
    }
    scene.add(globe.group);
    surfaces.set(id, surface);
  }
  /** Bodies drawn by terrain instead of a plain globe (the other worlds only up close). */
  const hidden = new Set([399, 301, 499].filter((id) => surfaces.has(id)));
  const WORLD_IDS = new Set(WORLDS.map((w) => w.body));
  /** The body whose shadow can fall on this one. */
  const eclipser = (id: number) => {
    if (id === 399) return 301;
    if (id === 301) return 399;
    if (id === 499) return 401;
    if (id === 999) return 901;
    const around = findBody(id)?.orbit?.around;
    return around !== undefined && around !== 10 ? around : -1;
  };
  const meanRadius = (id: number) => {
    const r = bodyById(id).radii;
    return (r[0] + r[1] + r[2]) / 3;
  };
  /** Body-fixed to scene rotation of any globe, terrain or shape model. */
  const axesOf = (id: number): Mat3 => surfaces.get(id)?.bodyToScene ?? system.orientationOf(id);
  const toBodyAxes = (b: Mat3, v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 => {
    out[0] = b[0] * v[0] + b[3] * v[1] + b[6] * v[2];
    out[1] = b[1] * v[0] + b[4] * v[1] + b[7] * v[2];
    out[2] = b[2] * v[0] + b[5] * v[1] + b[8] * v[2];
    return out;
  };
  const toSceneAxes = (b: Mat3, v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 => {
    const x = v[0], y = v[1], z = v[2];
    for (let k = 0; k < 3; k++) out[k] = b[k * 3] * x + b[k * 3 + 1] * y + b[k * 3 + 2] * z;
    return out;
  };
  /**
   * A shape model's surface seen from outside along a direction from its centre (unit,
   * body frame): distance from the centre (km), or the mean radius before it has loaded.
   */
  const shapeRadius = (id: number, dir: Vec3, rocks = false): number => {
    const view = shapes.get(id)!;
    if (!view.ready) return meanRadius(id);
    const R = view.index!.radius * 1.05;
    const hit = view.raycast([dir[0] * R, dir[1] * R, dir[2] * R], [-dir[0], -dir[1], -dir[2]], R, rocks);
    return hit ? R - hit.t : view.index!.minRadius;
  };
  const radialDir = (lon: number, lat: number): Vec3 => [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];

  // ---- asteroids and comets -----------------------------------------------------
  const smallBodies = asteroids ? new SmallBodies(asteroids, comets, renderer.getPixelRatio()) : undefined;
  if (smallBodies) scene.add(smallBodies.group);
  const smallOrbits = new Map<number, Orbit>();
  const targets = new Map<number, Target>();
  const KIND_NAME: Partial<Record<Body['kind'], string>> = { comet: 'comet nucleus', kbo: 'Kuiper belt object' };
  for (const body of BODIES) targets.set(body.id, { id: body.id, name: body.name, kind: KIND_NAME[body.kind] ?? body.kind, radius: body.radius[0] });
  if (asteroids) {
    for (const a of asteroidNames) {
      const number = Number(a.designation.split(' ')[0]);
      if (BODIES.some((b) => b.name === a.name || (Number.isInteger(number) && b.id === 2000000 + number))) continue;
      const id = ASTEROID_ID + a.index;
      smallOrbits.set(id, asteroidOrbit(asteroids, a.index));
      targets.set(id, { id, name: a.name, kind: a.designation, radius: 1 });
    }
  }
  comets.forEach((c, k) => {
    smallOrbits.set(COMET_ID + k, cometOrbit(c));
    targets.set(COMET_ID + k, { id: COMET_ID + k, name: c.name, kind: 'comet', radius: 1 });
  });
  namedStars.forEach((star, k) => {
    targets.set(STAR_ID + k, { id: STAR_ID + k, name: star.name, kind: 'star', radius: star.radius * SOLAR_RADIUS });
  });
  for (const t of deep.targets) targets.set(t.id, { id: t.id, name: t.name, kind: t.kind, radius: t.radius });
  for (const t of bhs.targets) targets.set(t.id, { id: t.id, name: t.name, kind: t.kind, radius: t.radius });
  for (const t of cosmic.targets) targets.set(t.id, { id: t.id, name: t.name, kind: t.kind, radius: t.radius });
  for (const t of sys.targets) targets.set(t.id, { id: t.id, name: t.name, kind: t.kind, radius: t.radius });
  MISSIONS.forEach((m, k) => {
    if (MISSION_DATA[m.slug]) targets.set(CRAFT_ID + k, { id: CRAFT_ID + k, name: m.name, kind: 'spacecraft', radius: 0.005 });
  });
  const isCraft = (id: number) => id >= CRAFT_ID && id < CRAFT_ID + MISSIONS.length;
  /** The spacecraft being followed, once its trajectory has loaded. */
  let missionView: MissionView | undefined;
  const isHole = (id: number) => bhs.has(id);
  const isCosmic = (id: number) => cosmic.has(id);
  const isStar = (id: number) => id >= STAR_ID && id < STAR_ID + namedStars.length;
  /** A companion star or exoplanet (systems.ts). */
  const isSys = (id: number) => sys.has(id);
  const isDeep = (id: number) => deep.has(id);
  const starOf = (id: number) => namedStars[id - STAR_ID];
  const helio: Vec3 = [0, 0, 0];
  const starPc: Vec3 = [0, 0, 0];
  const positionOf = (id: number, out: Vec3 = [0, 0, 0]): Vec3 => {
    if (isDeep(id)) return deep.position(id, out);
    if (isHole(id)) return bhs.position(id, out);
    if (isCosmic(id)) return cosmic.position(id, out);
    if (isStar(id) || isSys(id)) return sys.position(id, clock.tdb, out);
    if (isCraft(id)) {
      if (missionView && missionView.mission === MISSIONS[id - CRAFT_ID]) return missionView.position(clock.tdb, out);
      const e = system.position(399);
      out[0] = e[0]; out[1] = e[1]; out[2] = e[2];
      return out;
    }
    const orbit = smallOrbits.get(id);
    if (!orbit) {
      const p = system.position(id);
      out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
      return out;
    }
    orbitPosition(orbit, clock.tdb / 86400, helio);
    const sun = system.position(10);
    out[0] = sun[0] + helio[0];
    out[1] = sun[1] + helio[2];
    out[2] = sun[2] - helio[1];
    return out;
  };

  const bodyVector = (s: Surface, v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 => {
    const b = s.bodyToScene; // scene = B * body, so body = B^T * scene
    out[0] = b[0] * v[0] + b[3] * v[1] + b[6] * v[2];
    out[1] = b[1] * v[0] + b[4] * v[1] + b[7] * v[2];
    out[2] = b[2] * v[0] + b[5] * v[1] + b[8] * v[2];
    return out;
  };
  const sceneVector = (s: Surface, v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 => {
    const b = s.bodyToScene;
    for (let k = 0; k < 3; k++) out[k] = b[k * 3] * v[0] + b[k * 3 + 1] * v[1] + b[k * 3 + 2] * v[2];
    return out;
  };
  const updateOrientation = () => {
    for (const [id, s] of surfaces) rotationAt(id, clock.tdb, s.bodyToScene);
  };

  /** Height of the look point, smoothed so it settles gently as finer terrain loads. */
  const anchorHeights = new Map<number, number>();
  const anchorTimes = new Map<number, number>();
  const frameOf = (id: number, anchor?: Anchor): Frame => {
    const centre = positionOf(id);
    const s = surfaces.get(id);
    if (isDeep(id)) return deep.frame(id, centre) ?? { origin: centre, ...SCENE_BASIS };
    if (isHole(id)) return bhs.frame(id, centre);
    if (isCosmic(id)) return cosmic.frame(id, centre);
    if (anchor && shapes.has(id)) {
      // A shape model: the look point is where the line from the centre meets the surface.
      const dir = radialDir(anchor.lon, anchor.lat);
      const h = settle(id, shapeRadius(id, dir));
      const b = axesOf(id);
      const local = enu(anchor.lon, anchor.lat);
      const origin = toSceneAxes(b, [dir[0] * h, dir[1] * h, dir[2] * h]);
      for (let k = 0; k < 3; k++) origin[k] += centre[k];
      return { origin, east: toSceneAxes(b, local.east), north: toSceneAxes(b, local.north), up: toSceneAxes(b, local.up) };
    }
    if (!s || !anchor) return { origin: centre, ...SCENE_BASIS };
    const h = settle(id, s.globe.heightAt(anchor.lon, anchor.lat));
    const local = enu(anchor.lon, anchor.lat);
    const origin = sceneVector(s, geodeticToBody(s.shape, anchor.lon, anchor.lat, h));
    for (let k = 0; k < 3; k++) origin[k] += centre[k];
    return { origin, east: sceneVector(s, local.east), north: sceneVector(s, local.north), up: sceneVector(s, local.up) };
  };
  /** Ease the look point's height toward the ground's as finer ground loads. */
  const settle = (id: number, target: number) => {
    const prev = anchorHeights.get(id) ?? target;
    // Settle over about a sixth of a second whatever the frame rate.
    const now = performance.now() / 1000;
    const k = 1 - Math.exp(-6 * Math.min(1, now - (anchorTimes.get(id) ?? now)));
    anchorTimes.set(id, now);
    const h = prev + (target - prev) * Math.max(k, 0.15);
    anchorHeights.set(id, h);
    return h;
  };

  // The focus body's moons (and so its exact position) load first.
  const siteParam = params.has('site') ? SITES.find((x) => x.aliases.includes(params.get('site')!.toLowerCase())) : undefined;
  const focusName = (params.get('focus') ?? (siteParam ? bodyById(siteParam.body).name : 'Earth')).toLowerCase();
  const focusTarget = [...targets.values()].find((t) => t.name.toLowerCase() === focusName) ?? targets.get(399)!;
  prepare(focusTarget.id);
  await waitFor(() => loading === 0, 20000);

  system.update(clock.tdb);
  updateOrientation();

  /** A look point on the sunlit side: the subsolar point, moved 35 degrees west. */
  const sunlitAnchor = (id: number): Anchor => {
    const toSun = sub(system.position(10), system.position(id));
    const d = toBodyAxes(axesOf(id), toSun);
    return { lon: Math.atan2(d[1], d[0]) - 35 * DEG, lat: Math.max(-1.2, Math.min(1.2, Math.asin(d[2] / length(d)))) };
  };
  /** Azimuth (from north toward east) and altitude of the Sun at a ground point, radians. */
  const sunAzAlt = (id: number, a: Anchor): [number, number] => {
    const s = surfaces.get(id)!;
    const d = bodyVector(s, sub(system.position(10), system.position(id)));
    const p = geodeticToBody(s.shape, a.lon, a.lat, 0);
    const v: Vec3 = [d[0] - p[0], d[1] - p[1], d[2] - p[2]];
    const { east, north, up } = enu(a.lon, a.lat);
    return [Math.atan2(dot(v, east), dot(v, north)), Math.asin(dot(v, up) / length(v))];
  };
  /** For other targets: an orbit angle 35 degrees off the Sun direction, slightly above. */
  const sunlitView = (id: number): [number, number] => {
    if (id === 10 || isStar(id) || (isSys(id) && !sys.isPlanet(id))) return [-0.3, 0.9];
    // An exoplanet: from the side its star lights.
    const light = isSys(id) ? positionOf(STAR_ID + sys.planet(id).host) : system.position(10);
    const d = sub(light, positionOf(id), [0, 0, 0]);
    return [-(Math.atan2(d[0], d[2]) + 0.6), 0.2];
  };
  const viewFor = (id: number) => {
    const target = targets.get(id)!;
    if (surfaces.has(id) || shapes.has(id)) return { distance: target.radius * 3, yaw: 0, pitch: 1.25, anchor: sunlitAnchor(id) };
    if (isDeep(id)) return { ...deep.view(id, target.radius), anchor: undefined };
    if (isHole(id)) return { ...bhs.viewFor(id), anchor: undefined };
    if (isCosmic(id)) return { ...cosmic.viewFor(id), anchor: undefined };
    const [yaw, pitch] = sunlitView(id);
    const body = findBody(id);
    const distance = isStar(id) || (isSys(id) && !sys.isPlanet(id)) ? target.radius * 6 : isSys(id) ? target.radius * 4 : !body ? 3e6 : RINGS[id] && id === 699 ? target.radius * 7 : target.radius * 4;
    return { distance, yaw, pitch, anchor: undefined };
  };

  const initial = viewFor(focusTarget.id);
  let anchor = initial.anchor;
  // ?site=jezero starts at a landing site (see SITES); lat, lon, dist, heading, tilt still apply.
  const startSite = params.has('site') ? SITES.find((x) => x.aliases.includes(params.get('site')!.toLowerCase())) : undefined;
  if (startSite && startSite.body === focusTarget.id) {
    anchor = { lat: startSite.lat * DEG, lon: startSite.lon * DEG };
    if (!params.has('dist')) params.set('dist', String(startSite.dist));
    if (!params.has('heading')) params.set('heading', String(startSite.heading));
    if (!params.has('tilt')) params.set('tilt', String(startSite.tilt));
  }
  if ((surfaces.has(focusTarget.id) || shapes.has(focusTarget.id)) && params.has('lat') && params.has('lon')) {
    anchor = { lat: Number(params.get('lat')) * DEG, lon: Number(params.get('lon')) * DEG };
  }
  const rig = new CameraRig(focusTarget.id, Number(params.get('dist') ?? initial.distance), anchor);
  rig.yaw = initial.yaw;
  rig.pitch = initial.pitch;
  if (params.has('yaw')) rig.yaw = Number(params.get('yaw'));
  if (params.has('pitch')) rig.pitch = Number(params.get('pitch'));
  if (params.has('heading')) rig.yaw = Number(params.get('heading')) * DEG;
  if (params.has('tilt')) rig.pitch = Number(params.get('tilt')) * DEG;
  /** Turns the view up from the look point toward the sky (radians): ?look=76 */
  let lookUp = Number(params.get('look') ?? 0) * DEG;
  // ?aim=sun: face the Sun from a ground point (heading and look follow from its position).
  if (params.get('aim') === 'sun' && anchor && surfaces.has(focusTarget.id)) {
    const [az, alt] = sunAzAlt(focusTarget.id, anchor);
    rig.yaw = az;
    lookUp = alt + rig.pitch;
  }
  /** Vertical field of view, degrees: narrow it to see the eclipsed Sun up close (?fov=3). */
  let fov = Number(params.get('fov') ?? 50);
  /** ?sky=ra,dec (degrees): look at a point on the sky, celestial north up. */
  let skyAim: Vec3 | undefined;
  /** Keep the Sun in the middle of the view (events seen from the ground: eclipses, transits). */
  let followSun = params.get('aim') === 'sun' && anchor !== undefined && surfaces.has(focusTarget.id);
  if (params.has('sky')) {
    const [ra, dec] = params.get('sky')!.split(',').map(Number);
    skyAim = icrfToScene(raDecToIcrf(ra, dec));
  }
  /**
   * Faintest magnitude shown with a 50 degree field of view (about the naked-eye limit
   * in a dark sky); narrower views show fainter stars, like binoculars and telescopes.
   */
  const magnitudeBase = Number(params.get('mlim') ?? 7.5);
  const layers = {
    constellations: params.get('constellations') === '1',
    names: params.get('names') !== '0',
    planets: params.get('exoplanets') === '1',
    cmb: params.get('cmb') === '1',
    radio: params.get('radio') !== '0',
  };

  // ---- Earth satellites -------------------------------------------------------
  // The bundled CelesTrak snapshot shows straight away; current elements replace it
  // when CelesTrak can be reached.
  const satellites = new SatelliteLayer(
    parseSatellites(satelliteSnapshot?.objects ?? []),
    (unixMs, out) => orientation.bodyToScene(399, utcToTdb(unixMs), out),
    renderer.getPixelRatio(),
  );
  scene.add(satellites.group);
  let satelliteSource = satelliteSnapshot ? `CelesTrak elements of ${satelliteSnapshot.fetched}` : '';
  if (!params.has('capture') && satelliteSnapshot) {
    fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((fresh: SatelliteSnapshot['objects']) => {
        const byId = new Map(satelliteSnapshot.objects.map((o) => [o.NORAD_CAT_ID, o]));
        for (const o of fresh) byId.set(o.NORAD_CAT_ID, { ...o, GROUPS: byId.get(o.NORAD_CAT_ID)?.GROUPS ?? ['stations'] });
        satellites.setSatellites(parseSatellites([...byId.values()]));
        satelliteSource = 'current CelesTrak elements';
        updateCredits();
      })
      .catch(() => { /* keep the bundled snapshot */ });
  }

  // ---- labels, planet list and search ---------------------------------------
  const labelLayer = document.getElementById('labels')!;
  const list = document.getElementById('bodies')!;
  const labels = new Map<number, HTMLElement>();
  const buttons = new Map<number, HTMLButtonElement>();
  /** Fly to a target once its position is known (a moon's orbit may still be loading). */
  /** In the ship, picking a name sets the destination instead of flying there. */
  let pick: ((id: number) => boolean) | undefined;
  const flyTo = (id: number) => {
    if (isCraft(id)) {
      startMission(id - CRAFT_ID);
      return;
    }
    prepare(id);
    if (pick?.(id)) return;
    waitFor(() => id >= ASTEROID_ID || system.available(id), 30000).then(() => {
      const v = viewFor(id);
      rig.flyTo(id, v.distance, performance.now() / 1000, v.yaw, v.pitch, v.anchor);
      lookUp = 0;
      fov = 50;
      followSun = false;
    });
  };
  const makeLabel = (id: number, name: string, className = 'label') => {
    const label = document.createElement('div');
    label.className = className;
    label.textContent = name;
    label.addEventListener('click', () => flyTo(id));
    labelLayer.append(label);
    labels.set(id, label);
    return label;
  };
  for (const body of BODIES) {
    makeLabel(body.id, body.name, `label ${body.kind}`);
    if (body.kind === 'star' || body.kind === 'planet' || body.id === 301 || body.id === 999) {
      const button = document.createElement('button');
      button.textContent = body.name;
      button.addEventListener('click', () => flyTo(body.id));
      list.append(button);
      buttons.set(body.id, button);
    }
  }
  // Small bodies get a label only while they are the focus.
  const focusLabel = makeLabel(-1, '', 'label smallbody');

  const search = document.getElementById('search') as HTMLInputElement;
  const options = document.getElementById('search-options') as HTMLDataListElement;
  const byName = new Map<string, number>();
  for (const t of targets.values()) byName.set(t.name.toLowerCase(), t.id);
  for (const b of BODIES) for (const alias of b.aliases ?? []) if (!byName.has(alias.toLowerCase())) byName.set(alias.toLowerCase(), b.id);
  namedStars.forEach((star, k) => {
    for (const alias of [star.desig, star.host, ...(star.aka ?? [])]) if (alias && !byName.has(alias.toLowerCase())) byName.set(alias.toLowerCase(), STAR_ID + k);
  });
  for (const t of deep.targets) for (const alias of t.aliases) if (!byName.has(alias.toLowerCase())) byName.set(alias.toLowerCase(), t.id);
  for (const t of bhs.targets) for (const alias of t.aliases) if (!byName.has(alias.toLowerCase())) byName.set(alias.toLowerCase(), t.id);
  for (const t of cosmic.targets) for (const alias of t.aliases) if (!byName.has(alias.toLowerCase())) byName.set(alias.toLowerCase(), t.id);
  for (const t of sys.targets) for (const alias of t.aliases) if (!byName.has(alias.toLowerCase())) byName.set(alias.toLowerCase(), t.id);
  for (const f of sys.model.featured) if (!byName.has(f.title.toLowerCase())) byName.set(f.title.toLowerCase(), STAR_ID + f.host);
  const deepById = new Map(deep.targets.map((t) => [t.id, t]));
  options.append(...[...targets.values()].map((t) => {
    const o = document.createElement('option');
    o.value = t.name;
    if (isDeep(t.id)) o.label = [...(deepById.get(t.id)?.aliases.slice(0, 2) ?? []), t.kind].join(' · ');
    else if (isHole(t.id)) o.label = 'black hole';
    else if (isSys(t.id)) o.label = sys.isPlanet(t.id) ? `planet of ${namedStars[sys.planet(t.id).host].name} · ${sys.planet(t.id).kind}` : t.kind;
    else if (isStar(t.id)) {
      const star = starOf(t.id);
      o.label = [star.desig, star.host, star.planets ? `${star.planets.length} planet${star.planets.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') || 'star';
    } else if (isCraft(t.id)) o.label = 'spacecraft · ride along';
    else if (shapes.has(t.id)) o.label = `${t.kind} · spacecraft shape model · land and walk`;
    else if (t.id >= ASTEROID_ID) o.label = t.id >= COMET_ID ? 'comet' : t.kind;
    return o;
  }));
  const findSite = (q: string) => SITES.find((site) => site.name.toLowerCase() === q || site.aliases.includes(q));
  /** A named feature by "Name (World)" or just its name (the largest of that name). */
  const findFeature = (q: string) => FEATURES.find((f) => f.name.toLowerCase() === q) ?? FEATURES.find((f) => f.aliases[0] === q);
  // Named features on every world with terrain: fly there, then land or walk.
  fetch(`${BASE}data/features.json`).then((r) => r.json()).then((data: FeatureData) => {
    const added: HTMLOptionElement[] = [];
    for (const [key, list] of Object.entries(data.bodies)) {
      const body = Number(key);
      if (!surfaces.has(body)) continue;
      const world = bodyById(body);
      for (const [name, lat, lon, diameter, type] of list) {
        // Big features are seen from high up, small ones from low over their rim.
        const dist = Math.min(Math.max(1.6 * diameter, 2), 2 * world.radius[0]);
        FEATURES.push({ name: `${name} (${world.name})`, aliases: [name.toLowerCase()], body, lat, lon, dist, heading: 0, tilt: diameter > 300 ? 60 : 35, diameter });
        const o = document.createElement('option');
        o.value = `${name} (${world.name})`;
        o.label = `${type.toLowerCase()} on ${world.name}${diameter ? ` · ${diameter < 10 ? diameter.toFixed(1) : Math.round(diameter)} km` : ''}`;
        added.push(o);
      }
    }
    options.append(...added);
  }).catch(() => undefined);
  const flyToSite = (site: Site) => {
    prepare(site.body);
    waitFor(() => system.available(site.body), 30000).then(() => {
      rig.flyTo(site.body, site.dist, performance.now() / 1000, site.heading * DEG, site.tilt * DEG, { lat: site.lat * DEG, lon: site.lon * DEG });
      lookUp = 0;
      fov = 50;
      skyAim = undefined;
      followSun = false;
    });
  };
  for (const site of SITES) {
    const o = document.createElement('option');
    o.value = site.name;
    o.label = 'landing site · walk here';
    options.prepend(o);
  }
  const go = () => {
    const q = search.value.trim().toLowerCase();
    if (!q) return;
    const site = findSite(q) ?? (byName.has(q) ? undefined : findFeature(q));
    if (site) {
      search.value = site.name;
      search.blur();
      setFlight(false);
      setWalking(undefined);
      flyToSite(site);
      return;
    }
    const id = byName.get(q) ?? [...targets.values()].find((t) => t.name.toLowerCase().includes(q))?.id
      ?? [...byName.entries()].find(([name]) => name.includes(q))?.[1];
    if (id === undefined) {
      search.classList.add('miss');
      return;
    }
    search.classList.remove('miss');
    search.value = targets.get(id)!.name;
    search.blur();
    flyTo(id);
  };
  search.addEventListener('change', go);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  const starLabels = new Map<number, HTMLElement>();
  const sysLabels = new Map<number, HTMLElement>();
  const deepLabels = new Map<number, HTMLElement>();
  const makeStarLabel = (k: number) => {
    const label = document.createElement('div');
    label.className = 'label skystar';
    label.textContent = namedStars[k].name;
    label.addEventListener('click', () => flyTo(STAR_ID + k));
    labelLayer.append(label);
    return label;
  };
  const constellationLabels = (constellations?.data.figures ?? []).map((f) => {
    const label = document.createElement('div');
    label.className = 'label constellation';
    label.textContent = f.name;
    label.style.display = 'none';
    labelLayer.append(label);
    return label;
  });
  // Sky layers: constellation figures, star names, stars with known planets.
  const layerBar = document.getElementById('layers')!;
  for (const [key, title] of [['constellations', 'Constellations'], ['names', 'Star names'], ['planets', 'Exoplanets'], ['cmb', 'Microwave background'], ['radio', 'Radio 230 GHz']] as const) {
    const button = document.createElement('button');
    button.textContent = title;
    button.classList.toggle('active', layers[key]);
    button.addEventListener('click', () => {
      layers[key] = !layers[key];
      button.classList.toggle('active', layers[key]);
    });
    layerBar.append(button);
  }
  const radioButton = layerBar.lastElementChild as HTMLElement;
  const bhLabels = new Map<number, HTMLElement>();
  const ehtPanel = new EhtPanel(document.getElementById('eht')!, ehtMeta, `${BASE}data/blackholes/`);

  const satelliteLabels = new Map<number, HTMLElement>();
  for (const [id, name] of NAMED_SATELLITES) {
    const label = document.createElement('div');
    label.className = 'label satellite';
    label.textContent = name;
    labelLayer.append(label);
    satelliteLabels.set(id, label);
  }

  // ---- input ----------------------------------------------------------------
  // Drag pans across the ground on Earth and the Moon (orbits elsewhere);
  // right-drag or shift-drag turns and tilts the view. On touch screens, one finger
  // drags, two fingers pinch to zoom and move together to turn and tilt.
  let drag: { button: number; shift: boolean } | undefined;
  const pointers = new Map<number, { x: number; y: number }>();
  const pinch = () => {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  let pinchState: { d: number; x: number; y: number } | undefined;
  const pixelsPerRadian = () => innerHeight / (2 * Math.tan((camera.fov * DEG) / 2));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    drag = pointers.size === 1 ? { button: e.button, shift: e.shiftKey } : undefined;
    pinchState = pointers.size === 2 ? pinch() : undefined;
  });
  const release = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    drag = undefined;
    pinchState = undefined;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointermove', (e) => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    last.x = e.clientX;
    last.y = e.clientY;
    if (controls.active) {
      if (pointers.size === 1) controls.drag(dx, dy);
      return;
    }
    if (walkControls.active) {
      if (pointers.size === 1) walkControls.drag(dx, dy);
      return;
    }
    if (pinchState && pointers.size === 2) {
      const now = pinch();
      if (now.d > 0 && pinchState.d > 0) rig.zoom(Math.log(pinchState.d / now.d) / 0.0015);
      rig.orbit(now.x - pinchState.x, now.y - pinchState.y);
      pinchState = now;
      return;
    }
    if (!drag) return;
    followSun = false;
    if (rig.anchor && drag.button === 0 && !drag.shift) rig.pan(dx, dy, pixelsPerRadian(), targets.get(rig.focus)!.radius);
    else rig.orbit(dx, dy);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (controls.active) controls.scroll(e.deltaY);
    else if (!walkControls.active) rig.zoom(e.deltaY);
  }, { passive: false });

  // ---- time bar -------------------------------------------------------------
  const rateButtons = [...document.querySelectorAll<HTMLButtonElement>('#timebar button[data-rate]')];
  const syncRate = () => rateButtons.forEach((b) => b.classList.toggle('active', Number(b.dataset.rate) === (clock.paused ? 0 : clock.rate)));
  rateButtons.forEach((b) => b.addEventListener('click', () => {
    const rate = Number(b.dataset.rate);
    clock.paused = rate === 0;
    if (rate !== 0) clock.rate = rate;
    syncRate();
  }));
  document.getElementById('now')!.addEventListener('click', () => { clock.setUtc(Date.now()); clock.rate = 1; clock.paused = false; syncRate(); });
  syncRate();

  const dateInput = document.getElementById('date') as HTMLInputElement;
  dateInput.min = new Date(clock.minUtc).toISOString().slice(0, 16);
  dateInput.max = new Date(clock.maxUtc).toISOString().slice(0, 16);
  dateInput.addEventListener('change', () => {
    const t = Date.parse(`${dateInput.value}Z`);
    if (Number.isFinite(t)) clock.setUtc(t);
  });
  // Events: a few highlights, then every eclipse, transit and close approach in range,
  // with the next few coming up from the current date listed first.
  const eventSelect = document.getElementById('events') as HTMLSelectElement;
  const groups = eventGroups(eventCatalogue as EventCatalogue, clock.minUtc, clock.maxUtc);
  const eventList: SkyEvent[] = [];
  const option = (ev: SkyEvent) => {
    const o = document.createElement('option');
    o.value = String(eventList.length);
    o.textContent = ev.title;
    eventList.push(ev);
    return o;
  };
  const upcoming = document.createElement('optgroup');
  upcoming.label = 'Coming up';
  eventSelect.append(upcoming);
  const fillUpcoming = () => {
    upcoming.replaceChildren();
    const now = clock.utc;
    for (const g of groups.slice(1)) {
      const next = g.events.filter((e) => Date.parse(e.utc) > now).slice(0, g.label === 'Close approaches' ? 1 : 2);
      for (const ev of next) upcoming.append(option(ev));
    }
  };
  fillUpcoming();
  eventSelect.addEventListener('focus', fillUpcoming);
  for (const g of groups) {
    const og = document.createElement('optgroup');
    og.label = g.label;
    for (const ev of g.events) og.append(option(ev));
    eventSelect.append(og);
  }
  /** The asteroid or comet of the event being watched, if any. */
  let visitor: Visitor | undefined;
  let visitorLabel: HTMLElement | undefined;
  const showVisitor = (v: SkyEvent['visitor']) => {
    if (visitor) {
      scene.remove(visitor.group);
      visitor = undefined;
    }
    if (!v) return;
    Visitor.load(`${BASE}data/events/${v.track}`, v.name, v.comet).then((loaded) => {
      visitor = loaded;
      scene.add(loaded.group);
      if (!visitorLabel) {
        visitorLabel = document.createElement('div');
        visitorLabel.className = 'label';
        labelLayer.append(visitorLabel);
      }
      visitorLabel.textContent = v.name;
    }).catch(() => hud.say(`Couldn't load the track of ${v.name}`));
  };
  /** Start an event (at its start time, or `at` if given) and fly to its view. */
  const playEvent = (ev: SkyEvent, at?: number, rate?: number) => {
    clock.setUtc(at ?? Date.parse(ev.utc));
    clock.paused = false;
    clock.rate = rate ?? ev.rate;
    syncRate();
    const id = byName.get(ev.focus.toLowerCase())!;
    prepare(id);
    showVisitor(ev.visitor);
    const anchor = ev.lat !== undefined && ev.lon !== undefined ? { lat: ev.lat * DEG, lon: ev.lon * DEG } : undefined;
    waitFor(() => system.available(id), 30000).then(() => {
      const v = viewFor(id);
      let yaw = ev.heading !== undefined ? ev.heading * DEG : v.yaw;
      const pitch = ev.tilt !== undefined ? ev.tilt * DEG : v.pitch;
      lookUp = 0;
      skyAim = undefined;
      followSun = false;
      system.update(clock.tdb);
      updateOrientation();
      if (ev.aimSun && anchor) {
        // Face the Sun as it will be when the flight lands, and keep following it.
        const [az, alt] = sunAzAlt(id, anchor);
        yaw = az;
        lookUp = alt + pitch;
      }
      rig.flyTo(id, ev.dist, performance.now() / 1000, yaw, pitch, anchor ?? v.anchor);
      followSun = !!ev.aimSun && !!anchor;
      fov = ev.fov ?? 50;
      if (ev.note) hud.say(ev.note, 8);
    });
  };
  eventSelect.addEventListener('change', () => {
    const ev = eventList[Number(eventSelect.value)];
    eventSelect.value = '';
    eventSelect.blur();
    if (ev) playEvent(ev);
  });

  // On phones the HUD shows a few lines; a tap shows the rest.
  document.getElementById('hud')!.addEventListener('click', (e) => (e.currentTarget as HTMLElement).classList.toggle('expanded'));

  // ---- guided tours -----------------------------------------------------------
  const tourSelect = document.getElementById('tours') as HTMLSelectElement;
  TOURS.forEach((t, k) => {
    const o = document.createElement('option');
    o.value = String(k);
    o.textContent = t.title;
    tourSelect.append(o);
  });
  const tourStep = (step: TourStep) => {
    const id = byName.get(step.focus.toLowerCase());
    if (id === undefined) return;
    if (step.radio !== undefined) {
      layers.radio = step.radio;
      radioButton.classList.toggle('active', step.radio);
    }
    prepare(id);
    waitFor(() => id >= ASTEROID_ID || system.available(id), 30000).then(() => {
      const v = viewFor(id);
      rig.flyTo(id, step.dist ?? v.distance, performance.now() / 1000, step.yaw ?? v.yaw, step.pitch ?? v.pitch, v.anchor, step.flight ?? 6);
      lookUp = 0;
      fov = 50;
      skyAim = undefined;
      followSun = false;
    });
  };
  const tours = new TourPlayer(document.getElementById('tour')!, tourStep);
  tourSelect.addEventListener('change', () => {
    const tour = TOURS[Number(tourSelect.value)];
    tourSelect.value = '';
    if (tour) tours.start(tour);
  });
  // ---- star systems -------------------------------------------------------------
  const systemSelect = document.getElementById('systems') as HTMLSelectElement;
  sys.model.featured.forEach((f, k) => {
    const o = document.createElement('option');
    o.value = String(k);
    o.textContent = f.title;
    o.title = f.note;
    systemSelect.append(o);
  });
  systemSelect.addEventListener('change', () => {
    const f = sys.model.featured[Number(systemSelect.value)];
    systemSelect.value = '';
    systemSelect.blur();
    if (!f) return;
    flyTo(STAR_ID + f.host);
    hud.say(`${f.title}: ${f.note}`, 8);
  });

  // ?tour=1&step=3 starts a tour (numbered from 1) at a step.
  if (params.has('tour')) {
    const tour = TOURS[Number(params.get('tour')) - 1];
    if (tour) tours.start(tour, Number(params.get('step') ?? 1) - 1);
  }


  // ---- the ship ---------------------------------------------------------------
  // An optional piloted mode: the camera becomes a ship that flies under the gravity
  // of the real bodies (core/flight.ts), with a warp drive for the long distances.
  const solar = new SolarGravity(ephemeris);
  const scratch: Vec3 = [0, 0, 0];
  const zero = (out: Vec3) => { out[0] = out[1] = out[2] = 0; return out; };
  const holeHorizon = (id: number) => horizon(bhs.hole(id).spin) * bhs.hole(id).mass * SUN_GM_KM;
  const isSmall = (id: number) => smallOrbits.has(id);
  /** A small body's position at any time (positionOf only knows the clock's time). */
  const smallAt = (id: number, tdb: number, out: Vec3) => {
    orbitPosition(smallOrbits.get(id)!, tdb / 86400, helio);
    const sun = solar.position(10, tdb, scratch);
    out[0] = sun[0] + helio[0];
    out[1] = sun[1] + helio[2];
    out[2] = sun[2] - helio[1];
    return out;
  };
  const m0 = new Float64Array(9), m1 = new Float64Array(9);
  const flightWorld: FlightWorld = {
    position(id, tdb, out = [0, 0, 0]) {
      if (findBody(id)) return solar.position(id, tdb, out);
      if (isStar(id) || isSys(id)) return sys.position(id, tdb, out);
      if (isSmall(id)) return smallAt(id, tdb, out);
      return positionOf(id, out); // galaxies and black holes stay put
    },
    velocity(id, tdb, out = [0, 0, 0]) {
      if (findBody(id)) return solar.velocity(id, tdb, out);
      if (isStar(id) || isSys(id)) return sys.velocity(id, tdb, out);
      if (isSmall(id)) {
        const a = smallAt(id, tdb + 30, [0, 0, 0]), b = smallAt(id, tdb - 30, [0, 0, 0]);
        for (let k = 0; k < 3; k++) out[k] = (a[k] - b[k]) / 60;
        return out;
      }
      return zero(out);
    },
    acceleration(id, tdb, out = [0, 0, 0]) {
      if (isStar(id) || isSys(id)) return sys.acceleration(id, tdb, out);
      return findBody(id) ? solar.acceleration(id, tdb, out) : zero(out);
    },
    sources(abs, tdb) {
      const list: Source[] = solar.sources(abs, tdb).map((id) => ({ id, gm: GM[id], accel: shapeGravity(id) }));
      const years = yearsSinceEpoch(tdb);
      const icrf = sceneToIcrf(abs, [0, 0, 0]);
      namedStars.forEach((star, k) => {
        namedStarPosition(star, years, starPc);
        const d = Math.hypot(starPc[0] * PC_KM - icrf[0], starPc[1] * PC_KM - icrf[1], starPc[2] * PC_KM - icrf[2]);
        if (d < 0.05 * PC_KM) list.push({ id: STAR_ID + k, gm: sys.model.massOf(k) * GM[10] });
      });
      sys.sources(abs, list);
      for (const t of bhs.targets) {
        const p = bhs.position(t.id, scratch);
        if (Math.hypot(p[0] - abs[0], p[1] - abs[1], p[2] - abs[2]) < 10 * PC_KM) {
          list.push({ id: t.id, gm: bhs.hole(t.id).mass * GM[10], horizon: holeHorizon(t.id) });
        }
      }
      return list;
    },
    altitude(id, rel) {
      if (shapes.get(id)?.ready) {
        const p = toBodyAxes(axesOf(id), rel, [0, 0, 0]);
        const r = length(p);
        return r - shapeRadius(id, [p[0] / r, p[1] / r, p[2] / r]);
      }
      const s = surfaces.get(id);
      if (s) {
        const [lon, lat, h] = bodyToGeodetic(s.shape, bodyVector(s, rel, scratch));
        return h - Math.max(s.globe.heightAt(lon, lat), s.globe.heightAt(lon, lat, true)) - 0.002;
      }
      const body = findBody(id);
      if (body) return length(rel) - body.radius[0];
      if (isStar(id)) return length(rel) - starOf(id).radius * SOLAR_RADIUS;
      if (isSys(id)) return length(rel) - targets.get(id)!.radius;
      return NaN;
    },
    spin(id, tdb) {
      if (!findBody(id) || !rotationAt(id, tdb, m0)) return undefined;
      rotationAt(id, tdb + 10, m1);
      // M1 M0^T = I + [w]x dt for the small turn between them.
      const r = (i: number, j: number) => m1[i * 3] * m0[j * 3] + m1[i * 3 + 1] * m0[j * 3 + 1] + m1[i * 3 + 2] * m0[j * 3 + 2];
      return [(r(2, 1) - r(1, 2)) / 20, (r(0, 2) - r(2, 0)) / 20, (r(1, 0) - r(0, 1)) / 20];
    },
    radius(id) {
      if (isHole(id)) return holeHorizon(id);
      return targets.get(id)?.radius ?? 1;
    },
  };

  /**
   * An irregular body's own gravity close in (the polyhedron's, from its shape model and
   * mass); further out, a point mass does as well.
   */
  const shapeGravity = (id: number): Source['accel'] => {
    const view = shapes.get(id);
    const poly = view?.gravity;
    if (!view || !poly) return undefined;
    const reach = 4 * view.index!.radius;
    const local: Vec3 = [0, 0, 0], a: Vec3 = [0, 0, 0];
    return (rel, out) => {
      const r = length(rel);
      if (r > reach) {
        for (let k = 0; k < 3; k++) out[k] = (-GM[id] * rel[k]) / (r * r * r);
        return out;
      }
      const b = axesOf(id);
      poly.acceleration(toBodyAxes(b, rel, local), a);
      return toSceneAxes(b, a, out);
    };
  };

  /** Galaxies and other deep-sky objects don't move: their positions once. */
  const deepPositions = new Map<number, Vec3>();
  const deepAt = (id: number) => {
    let p = deepPositions.get(id);
    if (!p) deepPositions.set(id, (p = deep.position(id)));
    return p;
  };

  /**
   * What the ship flies relative to: the smallest sphere of influence it is inside (a
   * moon's, a planet's, the Sun's), else the nearest star or black hole it is near,
   * else the galaxy (or nebula, or cluster) it is in, else the nearest one.
   */
  const chooseRef = (abs: Vec3, tdb: number): number => {
    let best = -1, bestSize = Infinity;
    for (const body of BODIES) {
      if (!solar.has(body.id, tdb)) continue;
      const infl = solar.influence(body.id, tdb);
      const p = solar.position(body.id, tdb, scratch);
      if (infl < bestSize && Math.hypot(p[0] - abs[0], p[1] - abs[1], p[2] - abs[2]) < infl) {
        best = body.id;
        bestSize = infl;
      }
    }
    if (best >= 0) return best;
    const years = yearsSinceEpoch(tdb);
    const icrf = sceneToIcrf(abs, [0, 0, 0]);
    // Among the stars in reach, the one pulling hardest (in a binary, the nearer star).
    let pull = 0;
    namedStars.forEach((star, k) => {
      namedStarPosition(star, years, starPc);
      const d = Math.hypot(starPc[0] * PC_KM - icrf[0], starPc[1] * PC_KM - icrf[1], starPc[2] * PC_KM - icrf[2]);
      const m = sys.model.massOf(k);
      const infl = 2e4 * AU * Math.sqrt(m);
      if (d < infl) {
        const p = sys.position(STAR_ID + k, tdb, scratch);
        const g = m / Math.max(1, (p[0] - abs[0]) ** 2 + (p[1] - abs[1]) ** 2 + (p[2] - abs[2]) ** 2);
        if (g > pull) {
          best = STAR_ID + k;
          bestSize = infl;
          pull = g;
        }
      }
    });
    if (best >= 0) {
      // A white dwarf companion, or a planet whose sphere of influence the ship is in.
      const primary = sys.systemOf(best);
      if (primary >= 0) {
        for (const id of sys.starsOf(primary)) {
          if (!isSys(id)) continue;
          const p = sys.position(id, tdb, scratch);
          const g = sys.starLook(id).mass / Math.max(1, (p[0] - abs[0]) ** 2 + (p[1] - abs[1]) ** 2 + (p[2] - abs[2]) ** 2);
          if (g > pull) {
            best = id;
            pull = g;
          }
        }
        for (const id of sys.planetsIn(primary)) {
          const p = sys.position(id, tdb, scratch);
          const infl = sys.influence(id);
          if (Math.hypot(p[0] - abs[0], p[1] - abs[1], p[2] - abs[2]) < infl && infl < bestSize) {
            best = id;
            bestSize = infl;
          }
        }
      }
    }
    for (const t of bhs.targets) {
      const p = bhs.position(t.id, scratch);
      const infl = Math.min(3 * PC_KM, 2e4 * AU * Math.sqrt(bhs.hole(t.id).mass));
      if (Math.hypot(p[0] - abs[0], p[1] - abs[1], p[2] - abs[2]) < infl && infl < bestSize) {
        best = t.id;
        bestSize = infl;
      }
    }
    if (best >= 0) return best;
    let nearest = -1, nearestRatio = Infinity;
    for (const t of deep.targets) {
      const p = deepAt(t.id);
      const ratio = Math.hypot(p[0] - abs[0], p[1] - abs[1], p[2] - abs[2]) / t.radius;
      if (ratio < 1.5 && t.radius < bestSize) {
        best = t.id;
        bestSize = t.radius;
      }
      if (ratio < nearestRatio) {
        nearest = t.id;
        nearestRatio = ratio;
      }
    }
    return best >= 0 ? best : nearest >= 0 ? nearest : 10;
  };

  /** Everything the warp drive slows down for, and the destination. */
  const warpLimiters = (tdb: number): WarpLimiter[] => {
    const list: WarpLimiter[] = [];
    for (const body of BODIES) {
      if (!solar.has(body.id, tdb)) continue;
      const r = body.radius[0];
      list.push({ id: body.id, pos: solar.position(body.id, tdb), radius: r, arrive: body.id === 10 ? 15 * r : r });
    }
    const years = yearsSinceEpoch(tdb);
    namedStars.forEach((star, k) => {
      const r = star.radius * SOLAR_RADIUS;
      if (sys.model.binaryOf.has(k)) {
        list.push({ id: STAR_ID + k, pos: sys.position(STAR_ID + k, tdb), radius: r, arrive: 10 * r });
        return;
      }
      namedStarPosition(star, years, starPc);
      for (let c = 0; c < 3; c++) starPc[c] *= PC_KM;
      list.push({ id: STAR_ID + k, pos: icrfToScene(starPc), radius: r, arrive: 10 * r });
    });
    // The companions and planets of the systems the ship is in and is heading for.
    const primaries = new Set([ship ? sys.systemOf(ship.ref) : -1, flight.target !== undefined ? sys.systemOf(flight.target) : -1]);
    for (const primary of primaries) {
      if (primary < 0) continue;
      for (const id of [...sys.starsOf(primary), ...sys.planetsIn(primary)]) {
        if (!isSys(id)) continue;
        const r = targets.get(id)!.radius;
        list.push({ id, pos: sys.position(id, tdb), radius: r, arrive: sys.isPlanet(id) ? 3 * r : 10 * r });
      }
    }
    for (const t of bhs.targets) {
      const rg = bhs.hole(t.id).mass * SUN_GM_KM;
      list.push({ id: t.id, pos: bhs.position(t.id), radius: holeHorizon(t.id), arrive: 25 * rg });
    }
    for (const t of deep.targets) if (t.kind === 'galaxy') list.push({ id: t.id, pos: deepAt(t.id), radius: t.radius, arrive: 0, soft: true });
    if (flight.target !== undefined && !findBody(flight.target) && !isStar(flight.target) && !isHole(flight.target) && !isSys(flight.target)) {
      // Galaxies, nebulae, asteroids and comets: stop at the usual viewing distance.
      const id = flight.target;
      const pos = isSmall(id) ? smallAt(id, tdb, [0, 0, 0]) : isDeep(id) ? deepAt(id) : positionOf(id);
      list.push({ id, pos, radius: 0, arrive: isSmall(id) ? 3000 : viewFor(id).distance });
    }
    return list;
  };

  const controls = new FlightControls({
    warp: () => {
      if (rocket.on) return rocketGo();
      return ship && !ship.warp.on && !flight.going && flight.target !== undefined ? travel() : toggleWarp();
    },
    assist: () => {
      if (!ship) return;
      ship.assist = !ship.assist;
      hud.say(ship.assist ? 'Flight assist on: the ship holds still when you let go' : 'Flight assist off: nothing stops you but your engines');
    },
    align: () => {
      if (flight.target === undefined) hud.say('Pick a destination first: type a name or click a label');
      else {
        flight.aligning = true;
        flight.going = false;
        controls.turned = false;
      }
    },
    jump: () => {
      if (flight.target === undefined) hud.say('Pick a destination first: type a name or click a label');
      else jump(flight.target);
    },
    stepOut: () => stepOut(),
    drive: () => setRocket(!rocket.on),
    flyby: () => setupFlyby(),
    path: () => {
      gravityView.path = !gravityView.path;
      hud.say(gravityView.path ? 'Coasting path on: where gravity takes you with the engines off' : 'Coasting path off');
    },
    well: () => {
      gravityView.well = !gravityView.well;
      hud.say(gravityView.well ? 'Gravity well on: the sheet sinks where gravity pulls hardest' : 'Gravity well off');
    },
    exit: () => setFlight(false),
  });
  const hud = new FlightHud();
  const flight = {
    target: undefined as number | undefined,
    aligning: false,
    /** Turning toward the destination, to warp there once the nose is on it. */
    going: false,
    /** Waiting for an instant trip to finish, to take the controls again. */
    jumping: undefined as 'start' | 'flying' | undefined,
    power: Number(params.get('power') ?? 10),
    assist: params.get('assist') !== '0',
  };
  let ship: Ship | undefined;
  // ---- the rocket: real physics at near light speed --------------------------------
  // Instead of the warp drive (faster than light, a fiction), a rocket under constant
  // proper acceleration (core/relativity.ts). Time on board runs slow against the
  // stars' time, and the sky changes: aberration, Doppler shift, the starbow.
  const rocket = {
    on: params.get('drive') === 'rocket',
    /** A trip under way: accelerate halfway, turn around, decelerate to rest. */
    trip: undefined as undefined | { trip: Trip; target: number; start: Vec3; dir: Vec3; tau: number },
    /** Proper velocity (km/s, scene axes) relative to the ship's reference, in free flight. */
    u: [0, 0, 0] as Vec3,
    /** Time on board, and the stars' time, since the rocket was lit (s). */
    tau: 0,
    earth: 0,
    /** The stars' time (TDB s) it is now, which can run past the end of the ephemeris. */
    now: 0,
    /** Engine power the warp drive had (restored when switching back). */
    warpPower: 10,
  };
  /** Velocity (fraction of c, scene axes) for the sky shaders and labels this frame. */
  const beta: Vec3 = [0, 0, 0];
  /** Camera direction and up last frame, for taking over the view. */
  const lastView = { eye: [0, 0, 0] as Vec3, dir: [0, 0, -1] as Vec3, up: [0, 1, 0] as Vec3 };
  const flyButton = document.createElement('button');
  flyButton.id = 'fly';
  flyButton.textContent = 'Pilot a ship';
  flyButton.title = 'Fly yourself, under real gravity, with a warp drive for the long distances';
  flyButton.addEventListener('click', () => setFlight(!ship));
  list.prepend(flyButton);

  const nameOf = (id: number) => targets.get(id)?.name ?? '';
  const setFlight = (on: boolean) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (on && !ship) {
      tours.stop();
      const tdb = clock.tdb;
      const ref = chooseRef(lastView.eye, tdb);
      const p = flightWorld.position(ref, tdb);
      ship = new Ship(ref, sub(lastView.eye, p));
      ship.look(lastView.dir, lastView.up);
      ship.power = flight.power;
      ship.assist = flight.assist;
      ship.stop(flightWorld, tdb);
      // The ship flies in real time: engines can't push through paused or racing time.
      clock.paused = false;
      clock.rate = 1;
      lookUp = 0;
      skyAim = undefined;
      followSun = false;
      fov = 60;
      hud.say(`You have the controls, near ${nameOf(ref)}. Pick a destination and press X to fly there, or W to thrust and drag to turn.`, 8);
      if (rocket.on) setRocket(true);
    } else if (!on && ship) {
      if (flyby) {
        flyby = undefined;
        clock.rate = 1;
        syncRate();
      }
      if (rocket.on) {
        // Back to the stars' time running at its usual pace.
        rocket.trip = undefined;
        clock.rate = 1;
        syncRate();
      }
      const eye = ship.position(flightWorld, clock.tdb);
      const focus = ship.ref;
      ship = undefined;
      flight.aligning = flight.going = false;
      const frame = frameOf(focus);
      rig.place(focus, frame, sub(eye, frame.origin));
      fov = 50;
    }
    const active = ship !== undefined;
    controls.show(active);
    hud.show(active);
    flyButton.classList.toggle('active', active);
    flyButton.textContent = active ? 'Leave the ship' : 'Pilot a ship';
    document.body.classList.toggle('flying', active);
  };
  pick = (id) => {
    if (!ship) return false;
    flight.target = id;
    flight.aligning = flight.going = false;
    hud.say(`Destination: ${nameOf(id)}. X flies you there, G jumps there instantly.`, 6);
    return true;
  };
  const toggleWarp = (going = false) => {
    if (!ship) return;
    const tdb = clock.tdb;
    if (ship.warp.on || flight.going) {
      if (ship.warp.on) ship.dropWarp(flightWorld, tdb);
      flight.aligning = flight.going = false;
      hud.say('Warp drive off');
      return;
    }
    // The drive runs as fast as it safely can; W and S trim it.
    const blocked = ship.engageWarp(flightWorld, tdb, warpLimiters(tdb), true);
    if (blocked) hud.say(blocked.id === flight.target ? `You are already at ${nameOf(blocked.id)}` : `Too close to ${nameOf(blocked.id)} to warp toward it: turn away or fly out first`);
    else if (going) hud.say(`On the way to ${nameOf(flight.target!)}: X stops`);
    else hud.say('Warp drive on: it slows by itself near anything ahead. S slower, W faster, X stops');
  };
  /** One press to travel: turn toward the destination, then warp there. */
  const travel = () => {
    flight.aligning = flight.going = true;
    controls.turned = false;
    hud.say(`Turning toward ${nameOf(flight.target!)}`);
  };
  /** Instant travel from the ship: the usual flight there, then the controls back. */
  const jump = (id: number) => {
    setFlight(false);
    flight.jumping = 'start';
    flyTo(id);
  };
  /** Switch between the warp drive and the rocket. */
  const setRocket = (on: boolean) => {
    if (!ship) return;
    const tdb = clock.tdb;
    if (ship.warp.on) ship.dropWarp(flightWorld, tdb);
    flight.aligning = flight.going = false;
    rocket.on = on;
    rocket.trip = undefined;
    if (on) {
      // Start at rest in the reference's frame, at 1 g: what a crew could live with.
      ship.stop(flightWorld, tdb);
      rocket.u = [0, 0, 0];
      ship.vel = ship.frameVelocity(flightWorld, tdb);
      rocket.warpPower = ship.power;
      ship.power = 1;
      flight.power = 1;
      rocket.tau = rocket.earth = 0;
      rocket.now = tdb;
      hud.say('Rocket drive: real physics, nothing faster than light. Pick a destination and press X; W thrusts. The time bar sets how fast time on board runs.', 9);
    } else {
      ship.power = rocket.warpPower;
      flight.power = ship.power;
      ship.vel = ship.frameVelocity(flightWorld, tdb);
      clock.rate = 1;
      syncRate();
      hud.say('Warp drive: faster than light (a fiction), no relativity');
    }
  };
  /** Where a trip to `id` stops: the warp drive's arrival distance, or the usual view. */
  const stopDistance = (id: number, tdb: number) => {
    const l = warpLimiters(tdb).find((x) => x.id === id);
    return l ? l.radius + (l.soft ? Math.max(l.radius, viewFor(id).distance) * 0.5 : l.arrive) : viewFor(id).distance;
  };
  /** X with the rocket: turn toward the destination, then fly there at the engines' g. */
  const rocketGo = () => {
    if (!ship) return;
    if (rocket.trip) {
      // Engines off: coast on at this speed.
      const st = rocket.trip.trip.at(rocket.trip.tau);
      const v = st.beta * C_KMS;
      rocket.u = [rocket.trip.dir[0] * v * st.gamma, rocket.trip.dir[1] * v * st.gamma, rocket.trip.dir[2] * v * st.gamma];
      rocket.trip = undefined;
      hud.say('Engines off: coasting. X again flies on to the destination.');
      return;
    }
    if (flight.target === undefined) return hud.say('Pick a destination first: type a name or click a label');
    flight.aligning = flight.going = true;
    controls.turned = false;
    hud.say(`Turning toward ${nameOf(flight.target)}`);
  };
  /** Light the engines for a trip to the destination, from wherever the ship is now. */
  const startTrip = (id: number) => {
    if (!ship) return;
    const tdb = clock.tdb;
    const here = ship.position(flightWorld, tdb);
    const start = sub(here, flightWorld.position(id, tdb));
    const d = length(start);
    const dist = d - stopDistance(id, tdb);
    if (dist <= 0) return hud.say(`You are already at ${nameOf(id)}`);
    // A trip starts from rest: any coasting speed is dropped (the engines spend it first).
    const trip = new Trip(dist, ship.power * G0);
    ship.ref = id;
    ship.rel = [...start];
    ship.landed = undefined;
    const dir: Vec3 = [-start[0] / d, -start[1] / d, -start[2] / d];
    rocket.trip = { trip, target: id, start, dir, tau: 0 };
    rocket.u = [0, 0, 0];
    // Time on board runs so the whole trip takes about a minute (the time bar changes it).
    clock.rate = Math.max(1, trip.tau / 60);
    clock.paused = false;
    syncRate();
    hud.say(`Off to ${nameOf(id)} at ${formatG(ship.power)}: ${formatYears(trip.tau)} on board, ${formatYears(trip.t)} on Earth. Top speed ${formatBeta(trip.peakBeta)}.`, 10);
  };
  /**
   * Advance the rocket `dtau` seconds of time on board; returns the stars' time passed.
   * On a trip the motion is exact (core/relativity.ts Trip); in free flight the engines
   * push along the ship's axes and nothing else acts (gravity is left out).
   */
  const stepRocket = (s: Ship, dtau: number, input: { thrust: Vec3; boost: boolean }): number => {
    const r = rocket.trip;
    if (r) {
      const before = r.trip.at(r.tau);
      const tauBefore = r.tau;
      r.tau = Math.max(0, Math.min(r.trip.tau, r.tau + dtau));
      const st = r.trip.at(r.tau);
      s.ref = r.target;
      for (let k = 0; k < 3; k++) {
        s.rel[k] = r.start[k] + r.dir[k] * st.x;
        s.vel[k] = r.dir[k] * st.beta * C_KMS;
      }
      rocket.tau += r.tau - tauBefore;
      const dt = st.t - before.t;
      if (r.tau >= r.trip.tau) {
        rocket.trip = undefined;
        rocket.u = [0, 0, 0];
        s.vel = [0, 0, 0];
        clock.rate = 1;
        syncRate();
        hud.say(`Arrived at ${nameOf(r.target)}: ${formatYears(r.trip.tau)} passed on board, ${formatYears(r.trip.t)} on Earth.`, 12);
      }
      return dt;
    }
    if (dtau <= 0) return 0;
    const a = s.power * G0 * (input.boost ? BOOST : 1);
    const t = input.thrust;
    const fwd = s.forward(), right = s.right(), up = s.up();
    const alpha: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) alpha[k] = a * (t[0] * right[k] + t[1] * up[k] + t[2] * fwd[k]);
    rocket.tau += dtau;
    const dt = freeStep(s.rel, rocket.u, alpha, dtau);
    betaOf(rocket.u, s.vel);
    for (let k = 0; k < 3; k++) s.vel[k] *= C_KMS;
    return dt;
  };
  // Events and tours move the camera themselves: they leave the ship (and stop walking).
  eventSelect.addEventListener('change', () => { setFlight(false); setWalking(undefined); }, { capture: true });
  tourSelect.addEventListener('change', () => { setFlight(false); setWalking(undefined); }, { capture: true });

  // ---- on foot ------------------------------------------------------------------
  // Land the ship, step outside (or "Walk here" from a low view) and walk on the
  // ground of any solid world at its true gravity (core/walker.ts).
  const walkControls = new WalkControls({
    board: () => board(),
    exit: () => setWalking(undefined),
    time: () => {
      if (!shapeWalker) return;
      realTime = !realTime;
      clock.rate = realTime ? 1 : shapeRate;
      clock.paused = false;
      syncRate();
      hud.say(realTime ? 'Real time: every step as slow as this gravity makes it' : `Time ${Math.round(shapeRate)}× faster again, so a walk looks like one on Earth`);
    },
  });
  let walker: Walker | undefined;
  /** On foot on a small body drawn from its shape model (core/shapewalk.ts). */
  let shapeWalker: ShapeWalker | undefined;
  /** How much faster time runs on foot there (Froude similarity), unless switched to real time. */
  let shapeRate = 1;
  let realTime = false;
  /** Leaving a small body at more than its escape speed. */
  let escaped = false;
  let walkBody = -1;
  const onFoot = () => walker !== undefined || shapeWalker !== undefined;
  const shapeWorld = (id: number): ShapeWalkWorld => {
    const view = shapes.get(id)!;
    const w = flightWorld.spin(id, clock.tdb) ?? [0, 0, 0];
    return {
      gravity: (p, out = [0, 0, 0]) => view.gravity!.acceleration(p, out),
      spin: toBodyAxes(axesOf(id), w),
      raycast: (o, d, t) => view.raycast(o, d, t, true),
      gm: GM[id],
      radius: view.index!.radius,
    };
  };
  /** Local up (against gravity) and north at a point on a small body, body frame. */
  const shapeUp = (id: number, p: Vec3) => {
    const up = new ShapeWalker(p, [1, 0, 0], [0, 0, 1]).up(shapeWorld(id));
    return { up, north: tangent([0, 0, 1], up) };
  };
  /** The ship, parked where its pilot stepped out (body-fixed km, heading). */
  let parked: { body: number; p: Vec3; heading: number } | undefined;
  const shipModel = new Lander(true);
  scene.add(shipModel.group);
  // Eagle's descent stage, where LRO's cameras show it (LROC, 0.67416 N 23.47314 E).
  const eagle = { body: 301, lon: 23.47314 * DEG, lat: 0.67416 * DEG };
  const eagleModel = new Lander(false);
  scene.add(eagleModel.group);
  const walkWorld = (id: number): WalkWorld => {
    const s = surfaces.get(id)!;
    const w = flightWorld.spin(id, clock.tdb) ?? [0, 0, 0];
    return {
      shape: s.shape,
      gm: GM[id],
      spin: bodyVector(s, w),
      ground: (lon, lat) => s.globe.heightAt(lon, lat, true),
    };
  };
  const WALK_HELP = [
    '<b>W / S</b> walk forward and back · <b>A / D</b> sideways · hold <b>Shift</b> to run',
    '<b>Space</b> jump · <b>drag</b> or <b>arrows</b> to look around',
    'Walking pace and jumps follow the local gravity',
    '<b>B</b> boards the ship when you are next to it · <b>Esc</b> stops walking',
  ].join('<br>');
  const walkButton = document.createElement('button');
  walkButton.id = 'walk';
  walkButton.textContent = 'Walk here';
  walkButton.title = 'Stand on the ground here and walk, at this body\'s gravity';
  walkButton.hidden = true;
  walkButton.addEventListener('click', () => {
    if (onFoot()) return setWalking(undefined);
    if (shapes.has(rig.focus)) {
      const local = toBodyAxes(axesOf(rig.focus), sub(lastView.eye, system.position(rig.focus), [0, 0, 0]));
      const [lon, lat] = rig.anchor ? [rig.anchor.lon, rig.anchor.lat] : [Math.atan2(local[1], local[0]), Math.asin(local[2] / length(local))];
      return setWalking(rig.focus, lon, lat, rig.anchor ? rig.yaw : 0);
    }
    const s = surfaces.get(rig.focus);
    if (!s) return;
    const local = bodyVector(s, sub(lastView.eye, system.position(rig.focus), [0, 0, 0]));
    const [lon, lat] = rig.anchor ? [rig.anchor.lon, rig.anchor.lat] : bodyToGeodetic(s.shape, local);
    setWalking(rig.focus, lon, lat, rig.anchor ? rig.yaw : 0);
  });
  flyButton.after(walkButton);

  /** Start walking at a ground point (radians), or stop (body undefined). */
  const setWalking = (body: number | undefined, lon = 0, lat = 0, heading = 0) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (body !== undefined && shapes.has(body)) {
      const view = shapes.get(body)!;
      if (!view.ready || !view.gravity) return;
      setFlight(false);
      tours.stop();
      const dir = radialDir(lon, lat);
      const r = shapeRadius(body, dir);
      const p: Vec3 = [dir[0] * r, dir[1] * r, dir[2] * r];
      view.requestAround(p, 0.05);
      const world = shapeWorld(body);
      const { north, east, up } = enu(lon, lat);
      const facing: Vec3 = [0, 1, 2].map((k) => north[k] * Math.cos(heading) + east[k] * Math.sin(heading)) as Vec3;
      shapeWalker = new ShapeWalker(p, facing, up);
      walker = undefined;
      walkBody = body;
      escaped = false;
      // Time runs faster, so the gait (set by the Froude number) looks like one on Earth.
      shapeRate = Math.round(ShapeWalker.timeRate(world, p));
      realTime = false;
      clock.rate = shapeRate;
      clock.paused = false;
      syncRate();
      rig.focus = body;
      lookUp = 0;
      skyAim = undefined;
      followSun = false;
      fov = 60;
      prepare(body);
      hud.setHelp(SHAPE_WALK_HELP);
      const g = length(shapeWalker.effective(world)) * 1000;
      hud.say(`On foot on ${nameOf(body)}: gravity ${formatAccel(g / 1000)}, escape speed ${formatSlow(shapeWalker.escapeSpeed(world) * 1000)}. Time runs ${shapeRate}× faster so walking looks natural (T for real time).`, 10);
    } else if (body !== undefined) {
      const s = surfaces.get(body);
      if (!s) return;
      setFlight(false);
      tours.stop();
      // The finest ground loaded (what the feet stand on), not the coarser mesh drawn now.
      walker = new Walker(s.shape, lon, lat, s.globe.heightAt(lon, lat, true));
      walker.onGround = true;
      walker.heading = heading;
      walker.pitch = 0;
      walkBody = body;
      rig.focus = body;
      lookUp = 0;
      skyAim = undefined;
      followSun = false;
      fov = 60;
      prepare(body);
      hud.setHelp(WALK_HELP);
      hud.say(`On foot on ${nameOf(body)}. W to walk, Shift to run, Space to jump, drag to look around.`, 7);
    } else if (shapeWalker) {
      const w = shapeWalker;
      shapeWalker = undefined;
      clock.rate = 1;
      syncRate();
      fov = 50;
      hud.setHelp(hud.shipHelp);
      if (escaped) {
        // Drifting away for good: the camera stays where the walker is.
        const frame = frameOf(walkBody);
        rig.place(walkBody, frame, sub(lastView.eye, frame.origin));
      } else {
        const [lon, lat] = [Math.atan2(w.p[1], w.p[0]), Math.asin(w.p[2] / length(w.p))];
        const { north, east } = enu(lon, lat);
        rig.flyTo(walkBody, 0.03, performance.now() / 1000, Math.atan2(dot(w.fwd, east), dot(w.fwd, north)), 12 * DEG, { lon, lat }, 1);
      }
    } else if (walker) {
      const s = surfaces.get(walkBody)!;
      const [lon, lat] = walker.geodetic(s.shape);
      const heading = walker.heading;
      walker = undefined;
      rig.flyTo(walkBody, 0.03, performance.now() / 1000, heading, 12 * DEG, { lon, lat }, 1);
      fov = 50;
      hud.setHelp(hud.shipHelp);
    }
    const active = onFoot();
    walkControls.show(active);
    hud.show(active || ship !== undefined);
    walkButton.textContent = active ? 'Stop walking' : 'Walk here';
    walkButton.classList.toggle('active', active);
    document.body.classList.toggle('walking', active);
  };

  /** From a ship standing on the ground: park it and step out beside it. */
  const stepOut = () => {
    if (!ship) return;
    const body = ship.landed;
    if (body !== undefined && ship.ref === body && shapes.get(body)?.ready) {
      // Down the ladder onto a small body: 7 m in front of the ship, facing away from it.
      const b = axesOf(body);
      const p = toBodyAxes(b, ship.rel);
      const { up, north } = shapeUp(body, p);
      const fwd = tangent(toBodyAxes(b, ship.forward()), up);
      const east = cross(north, up);
      parked = { body, p: [...p], heading: Math.atan2(dot(fwd, east), dot(fwd, north)) };
      const q: Vec3 = [p[0] + fwd[0] * 0.007, p[1] + fwd[1] * 0.007, p[2] + fwd[2] * 0.007];
      const r = length(q);
      const lon = Math.atan2(q[1], q[0]), lat = Math.asin(q[2] / r);
      const local = enu(lon, lat);
      setWalking(body, lon, lat, Math.atan2(dot(fwd, local.east), dot(fwd, local.north)));
      return;
    }
    const s = body !== undefined ? surfaces.get(body) : undefined;
    if (body === undefined || !s || ship.ref !== body) {
      hud.say('Land first: set down on a world with a solid surface, then O steps outside');
      return;
    }
    const p = bodyVector(s, ship.rel);
    const [lon, lat] = bodyToGeodetic(s.shape, p);
    const { east, north } = enu(lon, lat);
    const fwd = bodyVector(s, ship.forward());
    const heading = Math.atan2(dot(fwd, east), dot(fwd, north));
    parked = { body, p: [...p], heading };
    // Down the ladder: 7 m in front of the ship, facing away from it.
    const step = 0.007 / s.shape.a;
    setWalking(body, lon + (step * Math.sin(heading)) / Math.max(0.01, Math.cos(lat)), lat + step * Math.cos(heading), heading);
  };

  /** Back into the parked ship, standing on the ground. */
  const board = () => {
    if (shapeWalker && parked && parked.body === walkBody) {
      const d = length(sub(shapeWalker.p, parked.p, [0, 0, 0])) * 1000;
      if (d > 20) return hud.say(`Your ship is ${d < 1000 ? d.toFixed(0) + ' m' : formatDistance(d / 1000)} away: walk to it to board`);
      const body = walkBody;
      const b = axesOf(body);
      const world = shapeWorld(body);
      const dir = toSceneAxes(b, shapeWalker.view(world).dir);
      const up = toSceneAxes(b, shapeUp(body, parked.p).up);
      const p = parked.p;
      parked = undefined;
      setWalking(undefined);
      lastView.eye = add(system.position(body), toSceneAxes(b, p));
      lastView.dir = dir;
      lastView.up = up;
      setFlight(true);
      if (ship) {
        ship.landed = body;
        hud.say(`Aboard, on ${nameOf(body)}. R or Space to lift off.`);
      }
      return;
    }
    if (!walker || !parked || parked.body !== walkBody) {
      hud.say('Your ship is not here');
      return;
    }
    const s = surfaces.get(walkBody)!;
    const d = length(sub(walker.p, parked.p, [0, 0, 0])) * 1000;
    if (d > 20) {
      hud.say(`Your ship is ${d < 1000 ? d.toFixed(0) + ' m' : formatDistance(d / 1000)} away: walk to it to board`);
      return;
    }
    const body = walkBody;
    const p = parked.p;
    const [lon, lat] = bodyToGeodetic(s.shape, p);
    const { north, up } = enu(lon, lat);
    const dir = sceneVector(s, walker.view(s.shape).dir);
    parked = undefined;
    setWalking(undefined);
    lastView.eye = add(system.position(body), sceneVector(s, p));
    const u = sceneVector(s, up);
    lastView.dir = dir;
    lastView.up = u;
    void north;
    setFlight(true);
    if (ship) {
      ship.landed = body;
      hud.say(`Aboard, on ${nameOf(body)}. R or Space to lift off.`);
    }
  };

  /** Advance the walker; return the camera for this frame. */
  const walk = (w: Walker, dt: number) => {
    const s = surfaces.get(walkBody)!;
    const world = walkWorld(walkBody);
    const look = walkControls.look();
    const ppr = innerHeight / (2 * Math.tan((fov * DEG) / 2));
    w.look(look.dx / ppr + look.keyYaw * 1.6 * dt, -look.dy / ppr + look.keyPitch * 1.2 * dt);
    const input = walkControls.input();
    const wasFlying = !w.onGround;
    const landed = w.step(world, dt, input);
    if (landed && wasFlying && w.airTime > 0.3) hud.say(`Jump: ${w.peak.toFixed(2)} m high, ${w.airTime.toFixed(1)} s in the air`, 5);
    const centre = system.position(walkBody);
    const eye = add(centre, sceneVector(s, w.eye(s.shape)));
    const v = w.view(s.shape);
    return { eye, dir: sceneVector(s, v.dir), up: sceneVector(s, v.up) };
  };

  const SHAPE_WALK_HELP = [
    '<b>W / S</b> walk forward and back · <b>A / D</b> sideways · hold <b>Shift</b> to run',
    '<b>Space</b> hops gently · <b>Shift + Space</b> leaps at 3.1 m/s, as on Earth (faster than most of these can hold)',
    '<b>T</b> real time or sped up · <b>drag</b> or <b>arrows</b> to look around',
    '<b>B</b> boards the ship when you are next to it · <b>Esc</b> stops walking',
  ].join('<br>');
  /** Advance someone on foot on a small body; return the camera for this frame. */
  const walkShape = (w: ShapeWalker, simDt: number, dt: number) => {
    const world = shapeWorld(walkBody);
    const look = walkControls.look();
    const ppr = innerHeight / (2 * Math.tan((fov * DEG) / 2));
    w.look(world, look.dx / ppr + look.keyYaw * 1.6 * dt, -look.dy / ppr + look.keyPitch * 1.2 * dt);
    const input = walkControls.input();
    const event = w.step(world, simDt, dt, input);
    if (event === 'landed' && w.airTime > 5) hud.say(`Hop: ${w.peak < 10 ? w.peak.toFixed(1) : w.peak.toFixed(0)} m high, ${formatDuration(w.airTime)} in the air`, 5);
    const b = axesOf(walkBody);
    const centre = system.position(walkBody);
    const eye = add(centre, toSceneAxes(b, w.eye(world)));
    const v = w.view(world);
    if (event === 'escaped') {
      escaped = true;
      hud.say(`You left ${nameOf(walkBody)} at ${formatSlow(length(w.v) * 1000)}, faster than its escape speed of ${formatSlow(w.escapeSpeed(world) * 1000)}: nothing will bring you back down.`, 10);
      lastView.eye = eye;
      setWalking(undefined);
    }
    return { eye, dir: toSceneAxes(b, v.dir), up: toSceneAxes(b, v.up) };
  };
  /** A slow speed: mm/s, cm/s or m/s. */
  const formatSlow = (ms: number) => (ms < 0.01 ? `${(ms * 1000).toPrecision(2)} mm/s` : ms < 1 ? `${(ms * 100).toPrecision(2)} cm/s` : `${ms.toFixed(1)} m/s`);
  const updateShapeWalkHud = (w: ShapeWalker) => {
    const world = shapeWorld(walkBody);
    const g = length(w.effective(world));
    const out: string[] = [];
    const speed = length(w.v) * 1000;
    const pace = w.pace(world, false) * 1000, run = w.pace(world, true) * 1000;
    const state = !w.onGround ? 'in the air' : speed < pace * 0.05 ? 'standing' : speed > (pace + run) / 2 ? 'running' : 'walking';
    out.push(`On foot on ${nameOf(walkBody)} · ${state}${speed >= pace * 0.05 ? ` ${formatSlow(speed)}` : ''}`);
    out.push(`Gravity ${formatAccel(g)} (${(g / G0).toPrecision(2)} g) · escape speed ${formatSlow(w.escapeSpeed(world) * 1000)}`);
    if (!w.onGround) {
      const up = w.up(world);
      const ground = world.raycast([w.p[0] + up[0] * 0.0005, w.p[1] + up[1] * 0.0005, w.p[2] + up[2] * 0.0005], [-up[0], -up[1], -up[2]], 50);
      out.push(`Up ${formatDuration(w.airTime)}${ground ? `, ${((ground.t - 0.0005) * 1000).toFixed(1)} m above the ground` : ''}`);
    } else out.push(`Walk ${formatSlow(pace)}, run ${formatSlow(run)} at this gravity`);
    out.push(realTime || clock.rate === 1 ? 'Real time · T speeds it up' : `Time runs ${Math.round(clock.rate)}× faster, so walking looks as on Earth · T for real time`);
    if (parked && parked.body === walkBody) {
      const d = length(sub(w.p, parked.p, [0, 0, 0])) * 1000;
      out.push(`Your ship: ${d < 1000 ? `${d.toFixed(0)} m` : formatDistance(d / 1000)}${d <= 20 ? ' · B to board' : ''}`);
      const pScene = add(system.position(walkBody), toSceneAxes(axesOf(walkBody), parked.p));
      markDir('target', sub(pScene, lastView.eye, [0, 0, 0]), 'Ship', false);
    } else hud.mark('target', 0, 0, false);
    hud.mark('nose', 0, 0, false);
    hud.mark('prograde', 0, 0, false);
    hud.mark('retrograde', 0, 0, false);
    hud.set(out);
  };

  const updateWalkHud = (w: Walker) => {
    const s = surfaces.get(walkBody)!;
    const world = walkWorld(walkBody);
    const g = length(w.gravity(world)) * 1000;
    const out: string[] = [];
    // Speed over the ground (the body-fixed frame already turns with it).
    const speed = length(w.v) * 1000;
    const pace = w.pace(world, false) * 1000, run = w.pace(world, true) * 1000;
    out.push(`On foot on ${nameOf(walkBody)} · ${!w.onGround ? 'in the air' : speed < 0.05 ? 'standing' : speed > (pace + run) / 2 ? 'running' : 'walking'}${speed >= 0.05 ? ` ${speed.toFixed(1)} m/s` : ''}`);
    out.push(`Gravity ${g.toFixed(2)} m/s² (${(g / 9.80665).toFixed(2)} g): walk ${pace.toFixed(1)} m/s, run ${run.toFixed(1)} m/s`);
    const [lon, lat] = w.geodetic(s.shape);
    const site = nearestSite(walkBody, lon, lat);
    const toEagle = walkBody === eagle.body ? sub(geodeticToBody(s.shape, eagle.lon, eagle.lat, 0), geodeticToBody(s.shape, lon, lat, 0), [0, 0, 0]) : undefined;
    if (toEagle && length(toEagle) < 3) {
      const { east, north } = enu(lon, lat);
      const az = (Math.atan2(dot(toEagle, east), dot(toEagle, north)) / DEG + 360) % 360;
      out.push(`Eagle (Apollo 11): ${(length(toEagle) * 1000).toFixed(0)} m ${['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(az / 45) % 8]}`);
    } else if (site) out.push(`${site.name}: ${site.distance < 1 ? `${(site.distance * 1000).toFixed(0)} m` : formatDistance(site.distance)} ${site.direction}`);
    if (parked && parked.body === walkBody) {
      const d = length(sub(w.p, parked.p, [0, 0, 0])) * 1000;
      out.push(`Your ship: ${d < 1000 ? `${d.toFixed(0)} m` : formatDistance(d / 1000)}${d <= 20 ? ' · B to board' : ''}`);
      const pScene = add(system.position(walkBody), sceneVector(s, parked.p));
      markDir('target', sub(pScene, lastView.eye, [0, 0, 0]), 'Ship', false);
    } else hud.mark('target', 0, 0, false);
    hud.mark('nose', 0, 0, false);
    hud.mark('prograde', 0, 0, false);
    hud.mark('retrograde', 0, 0, false);
    hud.tides(0, 1, '', false);
    hud.set(out);
  };

  /** Draw the parked ship and Eagle's descent stage when the camera is near them. */
  const drawLanders = (eye: Vec3) => {
    const place = (model: Lander, body: number, p: Vec3, heading: number) => {
      if (shapes.has(body)) {
        const b = axesOf(body);
        const centre = system.position(body);
        const rel = sub(add(centre, toSceneAxes(b, p)), eye, [0, 0, 0]);
        if (length(rel) > 30) return model.hide();
        const { up, north } = shapeUp(body, p);
        const sun = sub(system.position(10), centre, [0, 0, 0]);
        const intensity = system.intensity(body);
        model.update(rel, toSceneAxes(b, up), toSceneAxes(b, north), heading, [sun[0] / length(sun), sun[1] / length(sun), sun[2] / length(sun)], intensity, [intensity * 0.02, intensity * 0.016, intensity * 0.013]);
        return;
      }
      const s = surfaces.get(body);
      if (!s) return model.hide();
      const centre = system.position(body);
      const rel = sub(add(centre, sceneVector(s, p)), eye, [0, 0, 0]);
      if (length(rel) > 30) return model.hide();
      const [lon, lat] = bodyToGeodetic(s.shape, p);
      const { north, up } = enu(lon, lat);
      const sun = sub(system.position(10), centre, [0, 0, 0]);
      const sunDir: Vec3 = [sun[0] / length(sun), sun[1] / length(sun), sun[2] / length(sun)];
      const intensity = s.globe.uniforms.uSunIntensity.value;
      const sky = s.sky ? 0.15 : 0.02; // light from the sky (or from the bright ground around)
      model.update(rel, sceneVector(s, up), sceneVector(s, north), heading, sunDir, intensity, [intensity * sky, intensity * sky * 0.8, intensity * sky * 0.65]);
    };
    if (parked && !ship) place(shipModel, parked.body, parked.p, parked.heading);
    else shipModel.hide();
    const ms = surfaces.get(eagle.body);
    if (ms) {
      const ground = Math.max(ms.globe.heightAt(eagle.lon, eagle.lat, true), -3);
      place(eagleModel, eagle.body, geodeticToBody(ms.shape, eagle.lon, eagle.lat, ground), 0);
    }
  };

  /** Advance the ship and return the camera for this frame. */
  const flyShip = (s: Ship, tdbBefore: number, dt: number) => {
    const tdb = clock.tdb;
    const take = controls.take();
    const ppr = innerHeight / (2 * Math.tan((fov * DEG) / 2));
    if (take.dx || take.dy) s.rotateBody([-take.dy / ppr, -take.dx / ppr, 0]);
    if (take.wheel) {
      s.power = Math.min(1e4, Math.max(0.01, s.power * Math.exp(-take.wheel * 0.002)));
      flight.power = s.power;
    }
    flight.assist = s.assist;
    if (controls.turned) flight.aligning = flight.going = false;
    if (flight.aligning && flight.target !== undefined) {
      const dir = sub(flightWorld.position(flight.target, tdb), s.position(flightWorld, tdb));
      const d = length(dir);
      const left = s.align([dir[0] / d, dir[1] / d, dir[2] / d], 2.5, dt);
      if (flight.going && left < 0.01) {
        // Nose on the target: away we go (and keep tracking it on the way).
        flight.going = false;
        if (rocket.on) {
          flight.aligning = false;
          startTrip(flight.target);
        } else {
          toggleWarp(true);
          if (!s.warp.on) flight.aligning = false;
        }
      } else if (left < 1e-4 && !s.warp.on && !flight.going) flight.aligning = false;
    }
    if (rocket.on) {
      // The rocket: turning as usual, then time on board at the time bar's rate.
      const input = controls.input(false);
      s.step(flightWorld, tdb, 0, dt, { ...input, thrust: [0, 0, 0] }, []);
      if (rocket.now <= clock.maxTdb && Math.abs(clock.tdb - rocket.now) > 1) rocket.now = clock.tdb;
      const dtau = clock.paused ? 0 : clock.rate * dt;
      const passed = stepRocket(s, rocket.trip ? dtau : Math.max(0, dtau), input);
      rocket.earth += passed;
      rocket.now += passed;
      clock.hold(rocket.now);
      const eye = s.position(flightWorld, clock.tdb);
      return { eye, dir: s.forward(), up: s.up() };
    }
    const input = controls.input(s.warp.on);
    const limiters = s.warp.on ? warpLimiters(tdb) : [];
    const events = s.step(flightWorld, tdbBefore, tdb - tdbBefore, dt, input, limiters);
    paceFlyby(s, input, dt);
    for (const e of events) {
      if (e.kind === 'landed') hud.say(`Landed on ${nameOf(e.id)}`);
      if (e.kind === 'dropped') hud.say(e.id === flight.target ? `Arrived at ${nameOf(e.id)}` : `Dropped out of warp near ${nameOf(e.id)}`);
      if (e.kind === 'horizon') {
        // Nothing comes back out: start again outside, at rest.
        s.rebase(flightWorld, e.id, tdb);
        const r = length(s.rel);
        const rg = bhs.hole(e.id).mass * SUN_GM_KM;
        for (let k = 0; k < 3; k++) s.rel[k] *= (30 * rg) / Math.max(r, 1e-9);
        s.warp.on = false;
        s.stop(flightWorld, tdb);
        hud.say(`You crossed the event horizon of ${nameOf(e.id)}. Nothing gets back out, so here is a new ship, 30 gravitational radii out.`, 8);
      }
    }
    if (s.landed === undefined) {
      const abs = s.position(flightWorld, tdb);
      const ref = chooseRef(abs, tdb);
      if (ref !== s.ref) s.rebase(flightWorld, ref, tdb);
    }
    // Small bodies are not gravity sources: being near the destination is enough.
    if (flight.target !== undefined && isSmall(flight.target) && !s.warp.on) {
      const d = length(sub(flightWorld.position(flight.target, tdb), s.position(flightWorld, tdb)));
      if (d < 5e4) s.rebase(flightWorld, flight.target, tdb);
    }
    const eye = s.position(flightWorld, tdb);
    return { eye, dir: s.forward(), up: s.up() };
  };

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  function updateCredits() {
    document.getElementById('credit')!.textContent = [
      'Positions: JPL DE440 and satellite ephemerides; asteroids and comets: JPL SBDB',
      'Earth: NASA Blue Marble, Black Marble, NOAA ETOPO 2022; Grand Canyon: Copernicus Sentinel-2 and DEM GLO-30',
      `Clouds: NOAA GMGSI ${cloudsMeta.time.replace('T', ' ')}`,
      'Moon: LRO LROC and LOLA',
      `Sun: SDO/HMI ${sunMeta.time.slice(0, 16).replace('T', ' ')} UTC`,
      'Planets and moons: NASA/USGS mosaics (MESSENGER, Viking, Voyager, Galileo, Cassini, New Horizons), HST OPAL',
      'Saturn rings: Cassini RSS',
      'Asteroid and comet shapes: OSIRIS-REx, Hayabusa2, Hayabusa, NEAR, Rosetta, New Horizons, DART, Deep Impact and Lucy teams, via NAIF, ESA, JAXA and the PDS',
      satelliteSource && `Satellites: ${satelliteSource}`,
      'Stars: ESA Gaia DR3, Hipparcos (XHIP), Bailer-Jones distances; dust: Edenhofer et al. 2024; exoplanets: NASA Exoplanet Archive; constellations: Stellarium',
      'Galaxies: UNGC, Cosmicflows-4, 2MRS, 6dFGS, SDSS; images: DSS2; CMB: Planck',
      'Black holes: GRAVITY, Gillessen et al. 2017, Gaia, Miller-Jones et al. 2021; EHT images: EHT Collaboration (CC BY 4.0)',
    ].filter(Boolean).join(' · ');
  }
  updateCredits();

  // ---- frame rate ---------------------------------------------------------------
  // The drawing resolution follows the frame rate: down when frames take over 1/30 s
  // (as the ray-traced black holes can on a laptop), back up when there is room.
  // ?stats=1 shows the frame rate.
  const adaptive = quality !== 'high' && !params.has('capture');
  const statsEl = params.has('stats') ? document.body.appendChild(document.createElement('div')) : undefined;
  if (statsEl) statsEl.id = 'stats';
  let frameTime = 1 / 60;
  let lastAdapt = 0;
  const setPixelRatio = (ratio: number) => {
    pixelRatio = ratio;
    renderer.setPixelRatio(ratio);
    // Point sizes are in device pixels: every layer that draws points needs the ratio.
    scene.traverse((o) => {
      const u = ((o as THREE.Mesh).material as THREE.ShaderMaterial | undefined)?.uniforms;
      if (u?.uPixelRatio) u.uPixelRatio.value = ratio;
      if (u?.pixelRatio) u.pixelRatio.value = ratio;
    });
  };
  const adaptResolution = (dt: number) => {
    frameTime += (dt - frameTime) * 0.1;
    const t = performance.now() / 1000;
    if (statsEl && frameNumber % 10 === 0) statsEl.textContent = `${(1 / frameTime).toFixed(0)} fps · ${pixelRatio.toFixed(2)}×`;
    if (!adaptive || t - lastAdapt < 1.5) return;
    if (frameTime > 1 / 30 && pixelRatio > 0.5) {
      setPixelRatio(Math.max(0.5, pixelRatio * 0.8));
      lastAdapt = t;
    } else if (frameTime < 1 / 50 && pixelRatio < maxPixelRatio) {
      setPixelRatio(Math.min(maxPixelRatio, pixelRatio * 1.15));
      lastAdapt = t + 3; // rise slowly
    }
  };


  // ---- the ship's display -----------------------------------------------------
  const camSpace = new THREE.Vector3();
  /** Screen point of a direction (scene axes); off screen or behind, pinned to the edge. */
  const markDir = (name: string, d: Vec3, label = '', always = true) => {
    // From a ship near light speed, things appear shifted toward the motion.
    if (relativityUniforms.uGamma.value > 1) {
      const r = length(d);
      d = aberrate([d[0] / r, d[1] / r, d[2] / r], beta);
    }
    camSpace.set(d[0], d[1], d[2]).normalize().transformDirection(camera.matrixWorldInverse);
    const tanY = Math.tan((camera.fov * DEG) / 2), tanX = tanY * camera.aspect;
    const front = camSpace.z < 0;
    let x = front ? camSpace.x / -camSpace.z / tanX : camSpace.x;
    let y = front ? camSpace.y / -camSpace.z / tanY : camSpace.y;
    const inside = front && Math.abs(x) < 0.95 && Math.abs(y) < 0.92;
    if (!inside) {
      if (!always) return hud.mark(name, 0, 0, false);
      const k = 1 / Math.max(Math.abs(x) / 0.95, Math.abs(y) / 0.92, 1e-9);
      x *= k;
      y *= k;
    }
    hud.mark(name, (x * 0.5 + 0.5) * innerWidth, (-y * 0.5 + 0.5) * innerHeight, true, label, !inside);
  };
  /** The stars' date the rocket has reached: a date, or past the ephemeris, a year. */
  const earthDate = (tdb: number) => {
    if (tdb <= clock.maxTdb) return formatUtc(tdbToUtc(tdb)).slice(0, 10);
    const year = 2000 + tdb / (365.25 * 86400);
    return `the year ${Math.floor(year).toLocaleString('en-US')}`;
  };
  // ---- feeling gravity ----------------------------------------------------------
  // The coasting path ahead (core/forecast.ts), the gravity well around what the ship
  // flies by, the tides across the cabin, the push the crew feels, and one key (Y) to
  // swing past a planet or moon for a gravity assist (core/slingshot.ts).
  const gravityView = { path: params.get('path') !== '0', well: params.get('well') !== '0' };
  /** The forecast drawn, and the next one, worked out in the background to replace it. */
  let forecast = new Forecast();
  let nextForecast = new Forecast();
  const forecastLine = new ForecastLine();
  const wellGrid = new WellGrid();
  scene.add(forecastLine.line, wellGrid.lines);
  /** Readouts for the flight display, worked out with the drawing each frame. */
  let gravityLines: string[] = [];
  /** How hard the tides pull, by the worst level reached (to say so once on the way up). */
  let tideLevel = 0;
  /** A flyby under way: time sped up to suit the pass, until it is over. */
  let flyby: undefined | { id: number; parent: number; before: number; start: number; rate: number; logRate: number };

  const gmOf = (s: Ship, id: number) => s.sources.find((x) => x.id === id)?.gm ?? GM[id];
  /** Velocity of `id` relative to `parent` (km/s, scene). */
  const relVelocity = (id: number, parent: number, tdb: number) => sub(flightWorld.velocity(id, tdb), flightWorld.velocity(parent, tdb), [0, 0, 0]);
  const surfaceOf = (id: number) => findBody(id)?.radius[0] ?? (isStar(id) ? starOf(id).radius * SOLAR_RADIUS : isHole(id) ? holeHorizon(id) : 0);
  const hasParent = (id: number) => findBody(id) !== undefined && id !== 10;
  /** A name in a sentence: "the Sun", "Jupiter". */
  const theName = (id: number) => (id === 10 ? 'the Sun' : id === 301 ? 'the Moon' : nameOf(id));

  /** Y: put the ship on a hyperbola past the destination, passing behind it to gain speed. */
  const setupFlyby = () => {
    if (!ship) return;
    if (rocket.on) return hud.say('Flybys are flown with the warp drive’s ship: V switches back');
    const id = flight.target;
    const tdb = clock.tdb;
    if (id === undefined) return hud.say('Pick a planet or moon first, then Y sets up a flyby of it');
    const body = findBody(id);
    if (!body || id === 10 || GM[id] === undefined || !solar.has(id, tdb)) return hud.say(`Flybys work past planets and moons: pick one as the destination`);
    const parent = parentOf(id);
    const vP = relVelocity(id, parent, tdb);
    const pP = sub(flightWorld.position(id, tdb), flightWorld.position(parent, tdb), [0, 0, 0]);
    // Tilted 20° out of the body's orbital plane, so the way in looks down on its well
    // (the kick, along the body's motion tilted as much, keeps cos 20° = 94% of its use).
    const flat = normalize(cross(pP, vP));
    const tilt = 20 * DEG;
    const ahead = normalize(add(scale(normalize(vP), Math.cos(tilt)), scale(flat, Math.sin(tilt))));
    const normal = normalize(add(scale(flat, Math.cos(tilt)), scale(normalize(vP), -Math.sin(tilt))));
    // Clear of the rings that would wreck a ship (Saturn's, Uranus's, Neptune's).
    const rings = (RINGS[id]?.bands ?? []).filter((b) => b.tau >= 0.01);
    const R = body.radius[0];
    const peri = Math.max(1.3 * R, rings.length ? 1.08 * Math.max(...rings.map((b) => b.outer)) : 0);
    // About how fast a ship on a transfer orbit meets it: 0.4 of its own orbital speed.
    const vInf = 0.4 * length(vP);
    const d0 = Math.min(0.8 * solar.influence(id, tdb), 50 * peri);
    const start = flybyStart(GM[id], peri, vInf, ahead, normal, d0);
    if (ship.warp.on) ship.dropWarp(flightWorld, tdb);
    flight.aligning = flight.going = false;
    ship.ref = id;
    ship.rel = start.rel;
    ship.vel = start.vel;
    ship.landed = undefined;
    ship.spin = [0, 0, 0];
    ship.assist = flight.assist = false;
    ship.look(normalize([-start.rel[0], -start.rel[1], -start.rel[2]]), normal);
    controls.turned = false;
    clock.paused = false;
    const pass = encounter(start.rel, start.vel, GM[id])!;
    const before = length(add(vP, start.vel));
    flyby = { id, parent, before, start: d0, rate: clock.rate, logRate: Math.log(Math.max(1, clock.rate)) };
    hud.say(`Flyby of ${theName(id)}: coasting in at ${formatSpeed(vInf)} relative to it, engines and flight assist off. Closest approach ${formatDistance(pass.peri - R)} up, ${formatDuration(pass.toPeri)} away; time runs faster to suit. Watch your speed relative to ${theName(parent)}.`, 10);
  };

  /** Keep time paced to the pass: quick far out, slow enough at closest approach to see it. */
  const paceFlyby = (s: Ship, input: { thrust: Vec3 }, dt: number) => {
    if (!flyby) return;
    const done = (text: string) => {
      flyby = undefined;
      clock.rate = 1;
      syncRate();
      hud.say(text, 10);
    };
    if (clock.rate !== flyby.rate) {
      flyby = undefined; // the pilot took the time bar
      return;
    }
    if (input.thrust.some((x) => x !== 0) || s.warp.on) return done('Engines on: back to real time');
    if (s.landed !== undefined) return done(`Down on ${nameOf(s.landed)}`);
    const tdb = clock.tdb;
    const r = length(s.rel), v = length(s.vel);
    const leaving = s.ref !== flyby.id || (dot(s.rel, s.vel) > 0 && r > flyby.start);
    if (leaving) {
      s.rebase(flightWorld, flyby.parent, tdb);
      const after = length(s.vel);
      const gain = after - flyby.before;
      return done(`Flyby of ${theName(flyby.id)} complete: ${formatSpeed(flyby.before)} → ${formatSpeed(after)} relative to ${theName(flyby.parent)} (${gain >= 0 ? '+' : '−'}${formatSpeed(Math.abs(gain))}), all from gravity. Back to real time.`);
    }
    // About six seconds to cover the current distance at the current speed.
    const target = Math.min(3e5, Math.max(1, r / Math.max(v, 1e-3) / 6));
    flyby.logRate += (Math.log(target) - flyby.logRate) * (1 - Math.exp(-dt / 0.6));
    clock.rate = flyby.rate = Math.exp(flyby.logRate);
    syncRate();
    // Keep the body in view, until the pilot turns: far out its middle, close in its
    // edge ahead (the horizon sweeping by, not a wall of cloud).
    if (!controls.turned && !flight.aligning) {
      const toBody = normalize([-s.rel[0], -s.rel[1], -s.rel[2]]);
      const along = dot(s.vel, toBody);
      const side = normalize(sub(s.vel, scale(toBody, along), [0, 0, 0]));
      const a = Math.min(80 * DEG, 1.08 * Math.asin(Math.min(1, surfaceOf(s.ref) / r)));
      s.align(normalize(add(scale(toBody, Math.cos(a)), scale(side, Math.sin(a)))), 1.2, dt);
    }
  };

  /** Is the forecast still the path the ship is on? */
  const onForecast = (f: Forecast, s: Ship, tdb: number) => {
    const p: Vec3 = [0, 0, 0];
    const frame = f.at(tdb, p);
    if (frame === undefined) return false;
    const there = add(sub(flightWorld.position(frame, tdb), flightWorld.position(s.ref, tdb)), p);
    return length(sub(there, s.rel, [0, 0, 0])) <= 0.005 * Math.max(length(s.rel), 1) + 0.01;
  };

  const updateGravityView = (s: Ship | undefined, now: number) => {
    const live = s && !rocket.on && !s.warp.on && s.landed === undefined && s.sources.length > 0;
    if (!s || !live) {
      forecastLine.line.visible = false;
      wellGrid.lines.visible = false;
      for (const m of ['closest', 'encounter', 'impact']) hud.mark(m, 0, 0, false);
      gravityLines = [];
      hud.strain(0);
      if (s) hud.tides(0, 1, '', !rocket.on && !s.warp.on);
      return;
    }
    const tdb = clock.tdb;
    const out: string[] = [];
    const limit = clock.maxTdb;
    // Work the path out a slice per frame (a few milliseconds at most).
    const budget = performance.now() + 4;
    if (!onForecast(forecast, s, tdb)) {
      forecast.start(flightWorld, s, tdb, limit, now);
      nextForecast.done = true;
    }
    if (!forecast.done) {
      while (!forecast.advance(flightWorld, chooseRef, 25) && performance.now() < budget);
    } else {
      // Refresh in the background every few seconds (moons load, the clock moves on).
      if (nextForecast.done && nextForecast.n > 0 && nextForecast.startedAt > forecast.startedAt) {
        [forecast, nextForecast] = [nextForecast, forecast];
        nextForecast.n = 0;
      } else if (nextForecast.done && now - forecast.startedAt > 3) nextForecast.start(flightWorld, s, tdb, limit, now);
      if (!nextForecast.done) while (!nextForecast.advance(flightWorld, chooseRef, 25) && performance.now() < budget);
    }
    const f = forecast;
    const refAt = flightWorld.position(s.ref, tdb);
    /** Where body `id` is now, relative to the camera (the ship). */
    const offsets = new Map<number, Vec3>();
    const offset = (id: number) => {
      let o = offsets.get(id);
      if (!o) {
        o = id === s.ref ? [-s.rel[0], -s.rel[1], -s.rel[2]] : sub(sub(flightWorld.position(id, tdb), refAt, [0, 0, 0]), s.rel, [0, 0, 0]);
        offsets.set(id, o);
      }
      return o;
    };
    if (gravityView.path) forecastLine.update(f, tdb, offset, [0, 0, 0], s.assist);
    else forecastLine.line.visible = false;

    // What lies ahead on the path: closest approach, the next body passed, the ground.
    const pointAt = (i: number) => add(offset(f.frames[i]), f.point(i));
    const first = f.runs[0];
    let shown = { closest: false, encounter: false, impact: false };
    if (first && gravityView.path) {
      const c = first.closest;
      if (c > first.first + 1 && c < first.last && f.t[c] > tdb) {
        const alt = length(f.point(c)) - surfaceOf(first.frame);
        markDir('closest', pointAt(c), `Closest ${formatDistance(Math.max(0, alt))} · ${formatDuration(f.t[c] - tdb)}`, false);
        shown.closest = true;
      }
    }
    const next = f.runs.find((r, k) => k > 0 && r.frame !== parentOf(f.runs[k - 1].frame) && hasParent(r.frame));
    if (next && f.t[next.first] > tdb) {
      const id = next.frame;
      const parent = parentOf(id);
      const t0 = f.t[next.first];
      const relIn = f.point(next.first), velIn = f.velocity(next.first);
      const vBody = relVelocity(id, parent, t0);
      const before = length(add(vBody, velIn));
      const exit = f.runs[f.runs.indexOf(next) + 1];
      let after: number | undefined;
      if (exit) after = length(add(relVelocity(id, parent, f.t[exit.first - 1]), f.velocity(exit.first - 1)));
      else {
        const pass = encounter(relIn, velIn, gmOf(s, id));
        if (pass) after = length(add(vBody, pass.vOut));
      }
      const alt = length(f.point(next.closest)) - surfaceOf(id);
      const hit = f.end === 'impact' && !exit && f.frames[f.n - 1] === id;
      out.push(`Flyby of ${theName(id)} in ${formatDuration(t0 - tdb)}: closest ${formatDistance(Math.max(0, alt))} up${hit ? ' (into the ground!)' : ''}`);
      if (after !== undefined && !hit) out.push(`  Gravity assist: ${formatSpeed(before)} → ${formatSpeed(after)} relative to ${theName(parent)} (${after >= before ? '+' : '−'}${formatSpeed(Math.abs(after - before))})`);
      if (gravityView.path) {
        markDir('encounter', pointAt(next.closest), `${nameOf(id)} · ${formatDuration(f.t[next.closest] - tdb)}`, false);
        shown.encounter = true;
      }
    }
    if (f.end === 'impact' && f.t[f.n - 1] > tdb) {
      const id = f.frames[f.n - 1];
      out.push(`On course to hit ${theName(id)} in ${formatDuration(f.t[f.n - 1] - tdb)}${s.assist ? ' if the engines stop' : ''}`);
      if (gravityView.path) {
        markDir('impact', pointAt(f.n - 1), `Impact · ${formatDuration(f.t[f.n - 1] - tdb)}`, false);
        shown.impact = true;
      }
    }
    if (!shown.closest) hud.mark('closest', 0, 0, false);
    if (!shown.encounter) hud.mark('encounter', 0, 0, false);
    if (!shown.impact) hud.mark('impact', 0, 0, false);

    // On a pass right now: where the swing leaves the ship, relative to the body's parent.
    const gm = gmOf(s, s.ref);
    if (gm && hasParent(s.ref) && f.end !== 'impact') {
      const pass = encounter(s.rel, s.vel, gm);
      if (pass) {
        const parent = parentOf(s.ref);
        const vBody = relVelocity(s.ref, parent, tdb);
        // Far before and far after the pass (deep in the well the speed is borrowed).
        const before = length(add(vBody, pass.vIn));
        const after = length(add(vBody, pass.vOut));
        out.push(`Swinging past ${theName(s.ref)}${pass.toPeri > 0 ? `, closest in ${formatDuration(pass.toPeri)}` : ''}: path bent ${(pass.turn / DEG).toFixed(0)}°`);
        out.push(`  Gravity assist: ${formatSpeed(before)} in → ${formatSpeed(after)} out, relative to ${theName(parent)} (${after >= before ? '+' : '−'}${formatSpeed(Math.abs(after - before))})`);
      }
    }

    // The well: a sheet through what the ship flies by, in the plane of its orbit (a
    // planet's or a moon's), or the ecliptic.
    if (gravityView.well && gm) {
      const r = length(s.rel);
      let n = icrfToScene([0, -Math.sin(OBLIQUITY_J2000), Math.cos(OBLIQUITY_J2000)]);
      if (hasParent(s.ref)) {
        const parent = parentOf(s.ref);
        n = normalize(cross(sub(flightWorld.position(s.ref, tdb), flightWorld.position(parent, tdb), [0, 0, 0]), relVelocity(s.ref, parent, tdb)));
      }
      // Seen from above: "down" is away from the side the ship is on.
      if (dot(n, s.rel) < 0) n = [-n[0], -n[1], -n[2]];
      const R = surfaceOf(s.ref) || flightWorld.radius(s.ref);
      const reach = 3 * Math.max(r, 2 * R);
      const dents: Dent[] = [{ rel: [0, 0, 0], gm, radius: R }];
      for (const src of s.sources) {
        if (src.id === s.ref) continue;
        const rel = sub(flightWorld.position(src.id, tdb), refAt, [0, 0, 0]);
        if (length(rel) < 1.5 * reach) dents.push({ rel, gm: src.gm, radius: Math.max(surfaceOf(src.id), 1) });
      }
      wellGrid.update(offset(s.ref), R, n, reach, r, dents, isHole(s.ref) ? (2 * gm) / (C_KMS * C_KMS) : undefined);
    } else {
      wellGrid.lines.visible = false;
    }

    // What the crew feels: the engines' push (or nothing at all in free fall), and tides.
    const felt = length(s.felt) / G0;
    hud.strain(Math.min(0.85, Math.max(0, (felt - 4) / 25)));
    const tide = stretch(s.tides);
    const body2m = (tide.along * 2) / 9.80665; // g, head to toe
    const level = body2m > 10 ? 3 : body2m > 1 ? 2 : body2m > 0.05 ? 1 : 0;
    const words = ['', ', you feel it', ', painful', ', deadly'][level];
    out.push(`${felt > 1e-3 ? `Feeling ${felt < 0.1 ? felt.toPrecision(2) : felt < 10 ? felt.toFixed(2) : Math.round(felt).toLocaleString('en-US')} g from the engines` : 'Weightless in free fall'} · tides ${formatTiny(body2m)} g head to toe${words}`);
    if (level > tideLevel) {
      const who = nameOf(s.strongest) || 'it';
      hud.say(['', `The tides of ${who} tug at your head and feet differently now`, `The tides of ${who} hurt: ${body2m.toFixed(1)} g more at your feet than your head`, `Spaghettification: the tides of ${who} would tear a person apart here`][level], 8);
    }
    tideLevel = level;
    // The gauge: the stretch as it lies on screen, exaggerated on a log scale.
    camSpace.set(tide.axis[0], tide.axis[1], tide.axis[2]).transformDirection(camera.matrixWorldInverse);
    const onScreen = Math.hypot(camSpace.x, camSpace.y);
    const strength = Math.min(1, Math.max(0, (Math.log10(Math.max(body2m, 1e-14)) + 10) / 11));
    hud.tides(Math.atan2(camSpace.y, camSpace.x), 1 + 0.9 * strength * onScreen, `Tides ${formatTiny(body2m)} g`);
    gravityLines = out;
  };

  const updateRocketHud = (s: Ship, eye: Vec3) => {
    const out: string[] = [];
    const b = length(s.vel) / C_KMS;
    // gamma from the trip's own hyperbolic motion where there is one (exact near c).
    const st = rocket.trip?.trip.at(rocket.trip.tau);
    const g = st ? st.gamma : b > 0 ? gammaOf(Math.min(b, 1 - 1e-16)) : 1;
    hud.mark('nose', innerWidth / 2, innerHeight / 2, true);
    out.push(`Rocket · ${b > 0 ? formatBeta(st ? st.beta : b) : 'at rest'}${g > 1.0005 ? ` · γ ${g < 100 ? g.toFixed(3) : Math.round(g).toLocaleString('en-US')}` : ''} relative to the stars`);
    out.push(`On board ${formatYears(rocket.tau)} since lift-off · on Earth ${formatYears(rocket.earth)} (${earthDate(rocket.now)})`);
    if (g > 1.0005) out.push(`Time on board runs ${g < 100 ? g.toFixed(2) : Math.round(g).toLocaleString('en-US')}× slower than on Earth`);
    if (b > 1e-4) {
      const ahead = doppler(s.vel.map((v) => v / (b * C_KMS)) as Vec3, beta);
      out.push(`Light ahead blueshifted ×${ahead < 100 ? ahead.toFixed(2) : Math.round(ahead).toLocaleString('en-US')}, behind redshifted ×${(1 / ahead).toPrecision(2)}`);
      if (ahead > 300) out.push(`The microwave background ahead glows at ${Math.round(2.7255 * ahead).toLocaleString('en-US')} K`);
      markDir('prograde', s.vel, '', false);
      markDir('retrograde', [-s.vel[0], -s.vel[1], -s.vel[2]], '', false);
    } else {
      hud.mark('prograde', 0, 0, false);
      hud.mark('retrograde', 0, 0, false);
    }
    const r = rocket.trip;
    if (r) {
      const left = r.trip.distance - (st?.x ?? 0);
      const stage = st?.accelerating ? `Accelerating at ${formatG(r.trip.a / G0)}, turnaround in ${formatYears(r.trip.tau / 2 - r.tau)}` : `Decelerating at ${formatG(r.trip.a / G0)}, arriving in ${formatYears(r.trip.tau - r.tau)}`;
      out.push(stage + ' on board');
      out.push(`→ ${nameOf(r.target)}: ${formatLightYearsKm(left)} to go · whole trip ${formatYears(r.trip.tau)} on board, ${formatYears(r.trip.t)} on Earth`);
      markDir('target', sub(flightWorld.position(r.target, clock.tdb), eye), nameOf(r.target));
    } else {
      out.push(`Engines ${formatG(s.power)} · W to thrust, wheel to change${flight.target !== undefined ? ` · X flies to ${nameOf(flight.target)}` : ''}`);
      if (flight.target !== undefined) {
        const d = sub(flightWorld.position(flight.target, clock.tdb), eye);
        out.push(`→ ${nameOf(flight.target)}: ${formatLightYearsKm(length(d))}`);
        markDir('target', d, nameOf(flight.target));
      } else hud.mark('target', 0, 0, false);
    }
    const rate = clock.paused ? 0 : clock.rate;
    out.push(rate === 0 ? 'Time paused' : `Time on board: ${rate < 120 ? `${rate.toFixed(0)} s` : formatDuration(rate)} per second (time bar)`);
    if (rocket.now > clock.maxTdb) out.push(`(The planets are shown as of ${earthDate(clock.maxTdb)}, where their ephemeris ends.)`);
    hud.set(out);
  };
  const updateFlightHud = (s: Ship, eye: Vec3) => {
    if (rocket.on) return updateRocketHud(s, eye);
    const tdb = clock.tdb;
    const out: string[] = [];
    const frameVel = s.frameVelocity(flightWorld, tdb);
    const v: Vec3 = sub(s.vel, frameVel);
    const speed = length(v);
    const refName = nameOf(s.ref);
    const alt = flightWorld.altitude(s.ref, s.rel, tdb);
    hud.mark('nose', innerWidth / 2, innerHeight / 2, true);
    if (s.warp.on) {
      out.push(`Warp ${formatSpeed(s.warp.speed)}`);
      if (s.warp.speed >= s.warpCap * 0.98 && s.warp.speed < s.warp.set && s.warpLimiter >= 0) out.push(`Held back by ${nameOf(s.warpLimiter) || 'something ahead'}`);
      out.push(Number.isFinite(s.warp.set) ? 'W faster, S slower, X to stop' : 'Slows by itself near anything ahead · X to stop');
      hud.mark('prograde', 0, 0, false);
      hud.mark('retrograde', 0, 0, false);
    } else {
      out.push(`${s.landed !== undefined ? 'Landed' : 'Speed ' + formatSpeed(speed)} relative to ${refName}${length(frameVel) > 0 ? '’s ground' : ''}`);
      if (s.landed !== undefined && (surfaces.has(s.landed) || shapes.has(s.landed))) out.push('O to step outside');
      if (speed > 1e-3) {
        markDir('prograde', v, '', false);
        markDir('retrograde', [-v[0], -v[1], -v[2]], '', false);
      } else {
        hud.mark('prograde', 0, 0, false);
        hud.mark('retrograde', 0, 0, false);
      }
      const gamma = 1 / Math.sqrt(1 - Math.min(0.999999, (length(s.vel) / C_KMS) ** 2));
      if (gamma > 1.001) out.push(`On board, time runs ${gamma < 10 ? gamma.toFixed(3) : gamma.toFixed(0)}× slower`);
    }
    if (Number.isFinite(alt)) {
      const r = length(s.rel);
      const climb = (v[0] * s.rel[0] + v[1] * s.rel[1] + v[2] * s.rel[2]) / r;
      out.push(`Altitude ${formatDistance(Math.max(0, alt))}${s.warp.on || s.landed !== undefined ? '' : climb < -1e-3 ? `, falling ${formatSpeed(-climb)}` : climb > 1e-3 ? `, climbing ${formatSpeed(climb)}` : ''}`);
      const gm = GM[s.ref];
      if (gm && !s.warp.on && s.landed === undefined) {
        const radius = r - alt;
        const { peri, apo } = apsides(s.rel, s.vel, gm);
        if (!Number.isFinite(apo)) out.push(`On an escape path from ${refName}`);
        else if (peri > radius) out.push(`In orbit: ${formatDistance(peri - radius)} × ${formatDistance(apo - radius)}`);
        else if (apo - radius > 1) out.push(`Falling back: highest point ${formatDistance(apo - radius)}`);
      }
    } else if (!s.warp.on) out.push(`${formatDistance(length(s.rel))} from ${refName}`);
    if (!s.warp.on) {
      const g = length(s.gravity);
      if (g > 1e-12) {
        const ms2 = g * 1000;
        out.push(`Gravity ${ms2 >= 0.01 ? ms2.toFixed(ms2 < 10 ? 2 : 1) : ms2.toExponential(1)} m/s² (${(g / G0).toPrecision(2)} g), mostly ${nameOf(s.strongest)}`);
      }
      out.push(...gravityLines);
      out.push(`Engines ${s.power < 1 ? s.power.toPrecision(2) : Math.round(s.power).toLocaleString('en-US')} g · flight assist ${s.assist ? 'on' : 'off'}`);
      if (clock.paused) out.push('Time is paused: the engines need it running');
    }
    if (flight.target !== undefined) {
      const d = sub(flightWorld.position(flight.target, tdb), eye);
      const dist = length(d);
      const closing = s.warp.on ? s.warp.speed * Math.max(0, dot(d, s.forward()) / dist) : -dot(v, d) / dist;
      const eta = closing > 0 ? dist / closing : Infinity;
      const surface = findBody(flight.target)?.radius[0] ?? (isStar(flight.target) ? starOf(flight.target).radius * SOLAR_RADIUS : 0);
      out.push(`→ ${nameOf(flight.target)}: ${formatDistance(Math.max(0, dist - surface))}${Number.isFinite(eta) && eta < 3.15e10 ? `, ${formatDuration(eta)} at this speed` : ''}`);
      markDir('target', d, nameOf(flight.target));
    } else hud.mark('target', 0, 0, false);
    hud.set(out);
  };

  // ---- spacecraft missions ---------------------------------------------------
  // Ride along with a spacecraft on its navigated trajectory (core/mission.ts): pick one
  // from the menu or search, follow it through its flybys, and jump between moments.
  const at: BodyPosition = (id, tdb, out) => ephemeris.position(id, tdb, out);
  const missionSelect = document.getElementById('missions') as HTMLSelectElement;
  MISSIONS.forEach((m, k) => {
    const data = MISSION_DATA[m.slug];
    if (!data) return;
    const o = document.createElement('option');
    o.value = String(k);
    const from = new Date(tdbToUtc(data.start)).getUTCFullYear();
    o.textContent = `${m.name} · ${from}`;
    o.title = m.summary;
    missionSelect.append(o);
  });
  let missionIndex = -1;
  let missionPace = true;
  /** Smoothed log of the paced clock rate. */
  let paceLog = 0;
  let craftLabel: HTMLElement | undefined;
  const craftId = () => CRAFT_ID + missionIndex;
  /** Yaw and pitch that look along a scene direction (camera.ts conventions). */
  const lookAlong = (d: Vec3): [number, number] => {
    const l = length(d) || 1;
    const up = d[1] / l;
    return [Math.atan2(d[0] / l, -d[2] / l), -Math.asin(Math.max(-1, Math.min(1, up)))];
  };
  /**
   * Fly the camera to just behind the spacecraft, looking along `dir`: by default at the
   * body it is near, else at its sunlit side.
   */
  const followCraft = (dir?: Vec3, scale = 2.6) => {
    if (!missionView) return;
    const c = localBody(clock.tdb);
    // Near the Sun (Parker), look past the craft at it, a little from the side so the
    // sunlit heat shield shows; elsewhere at the body the craft is passing.
    let side = 0;
    if (!dir && c === 10) {
      const toSun = sub(missionView.bodyAt(10, clock.tdb), missionView.position(clock.tdb), [0, 0, 0]);
      if (Math.hypot(...toSun) < 0.3 * AU) {
        dir = toSun;
        side = 0.35;
      }
    }
    if (!dir && c !== 10 && ephemeris.available(c, clock.tdb)) dir = sub(missionView.bodyAt(c, clock.tdb), missionView.position(clock.tdb), [0, 0, 0]);
    const [yaw, pitch] = dir ? lookAlong(dir) : sunlitView(craftId());
    rig.flyTo(craftId(), (missionView.size / 1000) * scale, performance.now() / 1000, yaw + side, dir ? pitch + 0.12 : 0.25, undefined, 3);
    lookUp = 0;
    fov = 50;
    skyAim = undefined;
    followSun = false;
  };
  /** Speed around the Sun through the mission, for the panel's chart. */
  const speedCurve = (traj: Trajectory) => {
    const n = 600;
    const times = new Float64Array(n), speeds = new Float32Array(n);
    const v: Vec3 = [0, 0, 0], a: Vec3 = [0, 0, 0], b: Vec3 = [0, 0, 0];
    for (let k = 0; k < n; k++) {
      const t = traj.start + ((traj.end - traj.start) * k) / (n - 1);
      traj.velocity(t, at, v);
      at(10, t + 0.5, a);
      at(10, t - 0.5, b);
      times[k] = t;
      speeds[k] = Math.hypot(v[0] - (a[0] - b[0]), v[1] - (a[1] - b[1]), v[2] - (a[2] - b[2]));
    }
    return { times, speeds };
  };
  const endMission = () => {
    if (missionView) scene.remove(missionView.group);
    missionView = undefined;
    missionIndex = -1;
    missionPanel.close();
    if (craftLabel) craftLabel.style.display = 'none';
  };
  const panelActions = {
    jump: (m: Moment) => {
      if (!missionView) return;
      // Early enough to watch the approach: a few times the distance at the passing speed.
      const lead = m.body !== undefined && m.distance && m.speed ? Math.min(20 * 86400, Math.max(900, (5 * m.distance) / m.speed)) : 600;
      const t = Math.max(missionView.traj.start, m.tdb - lead);
      clock.setUtc(tdbToUtc(t));
      clock.paused = false;
      setPace(true);
      system.update(clock.tdb);
      if (m.body !== undefined) {
        prepare(m.body);
        const d = sub(system.position(m.body), missionView.position(clock.tdb), [0, 0, 0]);
        followCraft(d);
      } else followCraft();
      hud.say(m.body !== undefined ? `${m.title}: closest ${formatDistance(m.altitude ?? 0)} above ${bodyById(m.body).name} at ${formatSpeed(m.speed ?? 0)}` : m.title, 6);
    },
    seek: (tdb: number) => {
      clock.setUtc(tdbToUtc(tdb));
      followCraft();
    },
    pace: (on: boolean) => setPace(on),
    follow: () => followCraft(),
    close: () => endMission(),
  };
  const missionPanel = new MissionPanel(document.getElementById('mission')!, panelActions);
  const setPace = (on: boolean) => {
    missionPace = on;
    missionPanel.setPace(on);
  };
  // Choosing a rate by hand turns pacing off.
  rateButtons.forEach((b) => b.addEventListener('click', () => setPace(false)));
  const startMission = async (k: number, startTdb?: number, view?: { dist?: number; yaw?: number; pitch?: number }, keepView = false) => {
    const m = MISSIONS[k];
    const data = MISSION_DATA[m.slug];
    if (!m || !data) return;
    setFlight(false);
    setWalking(undefined);
    tours.stop();
    hud.say(`Loading ${m.name}…`, 3);
    const buffer = await fetch(`${BASE}data/missions/${m.slug}.bin`).then((r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      return r.arrayBuffer();
    }).catch(() => undefined);
    if (!buffer) {
      hud.say(`Couldn't load ${m.name}'s trajectory`);
      return;
    }
    const traj = new Trajectory(buffer);
    // The planets it passes, with their moons, so they sit where the spacecraft met them;
    // the small bodies it visits, whose positions the trajectory is relative to there.
    for (const [id] of m.encounters) if (id !== 10) prepare(id);
    for (const id of m.visits ?? []) prepare(id);
    const centres = [...new Set(traj.centres)].filter((c) => c !== 10);
    await waitFor(() => centres.every((c) => ephemeris.available(c)), 30000);
    if (missionView) scene.remove(missionView.group);
    missionView = new MissionView(m, traj, at);
    missionIndex = k;
    scene.add(missionView.group);
    targets.get(CRAFT_ID + k)!.radius = missionView.size / 2000;
    if (!craftLabel) craftLabel = makeLabel(-7, '', 'label spacecraft');
    craftLabel.textContent = m.name;
    craftLabel.onclick = () => followCraft();
    const t = Math.min(traj.end, Math.max(traj.start, startTdb ?? traj.start + 600));
    clock.setUtc(tdbToUtc(t));
    clock.paused = false;
    setPace(startTdb === undefined || !params.has('rate'));
    missionPanel.open(m, data, speedCurve(traj));
    system.update(clock.tdb);
    if (!keepView) followCraft();
    if (view?.dist !== undefined) {
      // A URL view: straight there.
      rig.flyTo(craftId(), view.dist, performance.now() / 1000, view.yaw ?? rig.yaw, view.pitch ?? rig.pitch, undefined, 0.01);
    }
    hud.say(m.summary, 8);
  };
  missionSelect.addEventListener('change', () => {
    const k = Number(missionSelect.value);
    missionSelect.value = '';
    missionSelect.blur();
    if (MISSIONS[k]) startMission(k);
  });

  // ---- live cosmic events (cosmic.ts) -----------------------------------------
  // The supernovae run on the main clock (the date the light reaches Earth); the cloud's
  // collapse and the merger have clocks of their own, millions of years and milliseconds.
  let cosmicPace = true;
  const SN_DAYS: [number, number] = [-1.3, Math.log10(40 * 365.25)];
  const BIRTH_YEARS: [number, number] = [3, 8];
  const Z1 = 1.09;
  /** Merger timeline: log of the time left from 1 s to 1 ms, then the ringing to 0.1 s after. */
  const mergerU = (t: number) => (t < -0.001 ? (0.85 * -Math.log10(-t)) / 3 : t < 0 ? 0.85 : 0.85 + 0.15 * Math.min(1, t / 0.1));
  const mergerT = (u: number) => (u < 0.85 ? -(10 ** ((-3 * u) / 0.85)) : ((u - 0.85) / 0.15) * 0.1);
  const isSupernova = (key: CosmicKey | undefined): key is 'sn1987a' | 'betelgeuse' => key === 'sn1987a' || key === 'betelgeuse';
  const cosmicCharts = new Map<CosmicKey, CosmicChart>();
  const logTicks = (lo: number, hi: number, label: (v: number) => string): Array<[number, string]> => {
    const out: Array<[number, string]> = [];
    for (let v = Math.ceil(lo); v <= hi; v++) out.push([v, label(v)]);
    return out;
  };
  const dayLabel = (v: number) => (v < 0 ? `${(10 ** v * 24).toFixed(0)} h` : v < 2.5 ? `${10 ** v} d` : `${(10 ** v / 365.25).toPrecision(2)} yr`);
  const cosmicChart = (key: CosmicKey): CosmicChart => {
    const cached = cosmicCharts.get(key);
    if (cached) return cached;
    let chart: CosmicChart;
    if (isSupernova(key)) {
      const s = cosmic.sn[key];
      const model: Array<[number, number]> = [];
      for (let x = SN_DAYS[0]; x <= SN_DAYS[1]; x += 0.01) model.push([x, Math.log10(s.curve.luminosity(10 ** x))]);
      const pts = cosmicData.sn1987a?.points ?? [];
      chart = {
        x: SN_DAYS, y: [35.5, 42.6], xLabel: 'time since first light', yLabel: 'log luminosity, erg/s',
        lines: [{ points: model, color: '#ffb35c', label: key === 'sn1987a' ? 'model (computed)' : 'computed' }],
        dots: key === 'sn1987a' ? [
          { points: pts.filter((p) => p[2] === 'S91').map((p) => [Math.log10(p[0]), p[1]]), color: '#e8eefc', label: 'measured: Suntzeff 1991' },
          { points: pts.filter((p) => p[2] === 'B91').map((p) => [Math.log10(p[0]), p[1]]), color: '#7fb2ff', label: 'Bouchet 1991' },
        ] : [],
        ticks: logTicks(SN_DAYS[0], SN_DAYS[1], dayLabel),
      };
    } else if (key === 'b68') {
      const lum: Array<[number, number]> = [], acc: Array<[number, number]> = [], mass: Array<[number, number]> = [];
      for (let x = BIRTH_YEARS[0]; x <= BIRTH_YEARS[1]; x += 0.02) {
        const st = cosmic.birth!.state(10 ** x);
        if (st.star > 0) lum.push([x, Math.log10(Math.max(st.luminosity, 1e-3))]);
        if (st.accretion > 1e-9) acc.push([x, Math.log10(st.accretion / 1e-6)]);
        mass.push([x, Math.log10(Math.max(st.star, 1e-3) / 0.1)]);
      }
      chart = {
        x: BIRTH_YEARS, y: [-2, 2.5], xLabel: 'years since the collapse began', yLabel: 'log scale',
        lines: [
          { points: lum, color: '#ffd27a', label: 'light (Suns)' },
          { points: acc, color: '#7fb2ff', label: 'accretion (1e-6 Suns/yr)' },
          { points: mass, color: '#e8eefc', label: 'star mass (0.1 Suns)' },
        ],
        ticks: logTicks(BIRTH_YEARS[0], BIRTH_YEARS[1], (v) => (v < 6 ? `${10 ** (v - 3)}k` : `${10 ** (v - 6)}M`)),
      };
    } else {
      // What LIGO's Hanford detector recorded (band-passed 35-350 Hz), and the model filtered alike and fitted in amplitude and phase.
      const gw = cosmicData.gw;
      const lines: CosmicChart['lines'] = [];
      if (gw) {
        const t0 = gw.t0 - GW_PEAK;
        const obs: Array<[number, number]> = [];
        gw.observedH.forEach((v, k) => obs.push([t0 + k * gw.dt, v]));
        const fit = matchModel(cosmic.binary, gw.observedH, t0, gw.dt, [35, 350], [-0.003, 0.003, 0.0005]);
        const model: Array<[number, number]> = [];
        fit.series.forEach((v, k) => model.push([t0 + k * gw.dt, v]));
        lines.push({ points: obs, color: 'rgba(232,238,252,0.55)', label: 'LIGO Hanford, measured' }, { points: model, color: '#5cd0ff', label: `model (overlap ${fit.overlap.toFixed(2)})` });
      }
      chart = {
        x: [-0.22, 0.06], y: [-1.4, 1.4], xLabel: 'seconds at Earth from the peak', yLabel: 'strain ×1e-21',
        lines, ticks: [[-0.2, '-0.2 s'], [-0.15, '-0.15'], [-0.1, '-0.1'], [-0.05, '-0.05'], [0, '0'], [0.05, '+0.05']],
      };
    }
    cosmicCharts.set(key, chart);
    return chart;
  };
  /** The chirp as sound: the computed strain at LIGO's own frequencies, from 1.2 s before the peak. */
  let audio: AudioContext | undefined;
  const playChirp = () => {
    audio ??= new AudioContext();
    const rate = audio.sampleRate;
    const start = -1.2, end = 0.08;
    const n = Math.floor((end - start) * rate);
    const buffer = audio.createBuffer(1, n, rate);
    const data = buffer.getChannelData(0);
    let peak = 0;
    for (let k = 0; k < n; k++) {
      data[k] = cosmic.binary.strainAtEarth(start + k / rate);
      peak = Math.max(peak, Math.abs(data[k]));
    }
    const filtered = bandpass(data, 1 / rate, 30, 400);
    for (let k = 0; k < n; k++) data[k] = (0.9 * filtered[k]) / peak * Math.min(1, k / (0.2 * rate));
    const src = audio.createBufferSource();
    src.buffer = buffer;
    src.connect(audio.destination);
    src.start();
    hud.say('The chirp at its real pitch, 35 to 250 Hz: headphones help', 4);
  };
  const cosmicKey = () => cosmicPanel.key as CosmicKey | undefined;
  const seekCosmic = (u: number) => {
    const key = cosmicKey();
    if (!key) return;
    if (isSupernova(key)) {
      const c = cosmic.sn[key].collapse;
      if (c !== undefined) clock.setUtc(c + 10 ** (SN_DAYS[0] + u * (SN_DAYS[1] - SN_DAYS[0])) * DAY_S * 1000);
    } else if (key === 'b68') cosmic.birthYears = u < 0.005 ? 0 : 10 ** (BIRTH_YEARS[0] + u * (BIRTH_YEARS[1] - BIRTH_YEARS[0]));
    else cosmic.mergerTime = mergerT(u);
  };
  const cosmicPanel = new CosmicPanel(document.getElementById('cosmic')!, {
    seek: seekCosmic,
    play: (on) => {
      if (isSupernova(cosmicKey())) clock.paused = !on;
      else cosmic.playing = on;
    },
    pace: (on) => {
      cosmicPace = on;
      cosmic.paced = on;
    },
    listen: playChirp,
    close: () => cosmicPanel.close(),
  });
  const SUMMARIES: Record<CosmicKey, string> = {
    sn1987a: 'A blue supergiant in the Large Magellanic Cloud collapses. Watch the fireball expand and cool, the ejecta turn see-through, and the flash and then the blast wave light up its rings.',
    betelgeuse: 'If Betelgeuse exploded now: computed for its size and mass. For three months it would outshine the half Moon in our sky.',
    b68: 'Barnard 68 is a cold cloud on the edge of collapse. Follow it into a star with a disc and jets, then a young star settling onto the main sequence.',
    gw150914: 'Two black holes of 36 and 31 Suns in their last orbits, as LIGO heard them: their light bending, the waves spreading out, one hole ringing down.',
  };
  /** Start an event: its clock at `at` (days, years or seconds; default its start), the panel, and the view. */
  const startCosmic = (key: CosmicKey, at?: number, view?: { dist?: number; yaw?: number; pitch?: number }, keepView = false) => {
    setFlight(false);
    setWalking(undefined);
    tours.stop();
    endMission();
    const id = cosmic.idOf(key);
    if (key === 'betelgeuse') {
      if (at === undefined) cosmic.detonate(clock.utc);
      else cosmic.sn.betelgeuse.collapse = clock.utc - at * DAY_S * 1000;
    }
    if (key === 'sn1987a') clock.setUtc(SN1987A.collapse! + (at ?? -0.1) * DAY_S * 1000);
    if (isSupernova(key)) {
      clock.paused = false;
      clock.rate = CosmicEvents.pace(cosmic.day(key, clock.utc) ?? 0);
    }
    if (key === 'b68') cosmic.birthYears = at ?? 0;
    if (key === 'gw150914') cosmic.mergerTime = at ?? -0.6;
    cosmic.playing = true;
    cosmic.paced = cosmicPace = true;
    const v = cosmic.viewFor(id);
    if (!keepView) {
      lookUp = 0;
      skyAim = undefined;
      followSun = false;
      fov = 50;
    }
    if (keepView) { /* watching from where the camera is (?cosmic= with ?focus=) */ } else if (view) rig.flyTo(id, view.dist ?? v.distance, performance.now() / 1000, view.yaw ?? v.yaw, view.pitch ?? v.pitch, undefined, 0.01);
    else rig.flyTo(id, v.distance, performance.now() / 1000, v.yaw, v.pitch);
    cosmicPanel.open(key, targets.get(id)!.name, SUMMARIES[key], cosmicChart(key), key === 'gw150914');
    hud.say(SUMMARIES[key], 8);
  };
  /** Panel and pacing, every frame. */
  const updateCosmic = (dt: number) => {
    const key = cosmicKey();
    if (!key) return;
    cosmic.tick(dt, key);
    if (isSupernova(key)) {
      const day = cosmic.day(key, clock.utc) ?? 0;
      if (cosmicPace && !clock.paused) clock.rate = CosmicEvents.pace(day);
      cosmicPanel.setPlaying(!clock.paused);
      const x = Math.log10(Math.max(day, 10 ** SN_DAYS[0]));
      const when = new Date(clock.utc).toISOString().slice(0, 10);
      cosmicPanel.update(x, (x - SN_DAYS[0]) / (SN_DAYS[1] - SN_DAYS[0]), day < 0 ? `${(-day * 24).toFixed(1)} hours before the first light · ${when}` : `Day ${day < 100 ? day.toFixed(1) : Math.round(day).toLocaleString('en-US')} · Earth sees this on ${when}`);
    } else if (key === 'b68') {
      cosmicPanel.setPlaying(cosmic.playing);
      const y = cosmic.birthYears;
      const st = cosmic.protostar;
      cosmicPanel.update(Math.log10(Math.max(y, 1000)), y <= 0 ? 0 : (Math.log10(Math.max(y, 1000)) - BIRTH_YEARS[0]) / (BIRTH_YEARS[1] - BIRTH_YEARS[0]),
        y <= 0 ? 'Barnard 68 today' : `${formatYearCount(y)} · ${st && st.star > 0 ? `class ${st.stage}, ${st.star.toFixed(2)} Suns` : 'collapsing, no star yet'}`);
    } else {
      cosmicPanel.setPlaying(cosmic.playing);
      const t = cosmic.mergerTime;
      cosmicPanel.update(t * Z1, mergerU(t), t < 0 ? `${(-t * 1000).toFixed(t > -0.1 ? 1 : 0)} ms to the merger · ${cosmic.binary.frequency(t).detector.toFixed(0)} Hz at Earth` : `${(t * 1000).toFixed(1)} ms after the merger`);
    }
  };
  // In the Events menu, after the sky's own events.
  const cosmicGroup = document.createElement('optgroup');
  cosmicGroup.label = 'Cosmic events';
  const COSMIC_TITLES: Record<CosmicKey, string> = {
    sn1987a: 'Supernova 1987A explodes · 23 Feb 1987',
    betelgeuse: 'Betelgeuse explodes (computed) · now',
    b68: 'A star is born in Barnard 68 (computed)',
    gw150914: 'Black holes merge: GW150914 · 14 Sep 2015',
  };
  for (const key of COSMIC_KEYS) {
    const o = document.createElement('option');
    o.value = `cosmic:${key}`;
    o.textContent = COSMIC_TITLES[key];
    cosmicGroup.append(o);
  }
  eventSelect.append(cosmicGroup);
  eventSelect.addEventListener('change', () => {
    const v = eventSelect.value;
    if (!v.startsWith('cosmic:')) return;
    eventSelect.value = '';
    eventSelect.blur();
    startCosmic(v.slice(7) as CosmicKey);
  });
  /** Bodies near the spacecraft worth pacing and pulling for: the Sun and its encounters. */
  const craftBodies = () => (missionView ? [10, ...missionView.mission.encounters.map(([id]) => id), ...(missionView.mission.visits ?? [])].filter((id, i, all) => all.indexOf(id) === i && ephemeris.available(id, clock.tdb)) : []);
  const formatAccel = (kms2: number) => {
    const ms2 = kms2 * 1000;
    if (ms2 >= 0.1) return `${ms2.toPrecision(3)} m/s²`;
    if (ms2 >= 1e-4) return `${(ms2 * 1000).toPrecision(3)} mm/s²`;
    return `${(ms2 * 1e6).toPrecision(3)} µm/s²`;
  };
  /**
   * The body whose sphere of influence the spacecraft is in (the Moon's inside Earth's),
   * else the Sun: from the positions themselves, as the table switches centre only on
   * its daily grid and can miss a short pass.
   */
  const localBody = (tdb: number): number => {
    if (!missionView || !missionView.traj.covers(tdb)) return 10;
    const p = missionView.position(tdb);
    let best = 10;
    for (const key of Object.keys(SOI)) {
      const id = Number(key);
      if (!ephemeris.available(id, tdb)) continue;
      const b = missionView.bodyAt(id, tdb);
      if (Math.hypot(p[0] - b[0], p[1] - b[1], p[2] - b[2]) < SOI[id] && (best === 10 || id === 301)) best = id;
    }
    return best;
  };
  const describeCraft = (eye: Vec3): string[] => {
    if (!missionView) return ['Loading trajectory…'];
    const v = missionView;
    const m = v.mission;
    const tdb = clock.tdb;
    const out: string[] = [];
    if (!v.traj.covers(tdb)) {
      out.push(tdb < v.traj.start ? `Not launched yet: the trajectory starts ${new Date(tdbToUtc(v.traj.start)).toISOString().slice(0, 10)}` : 'The trajectory ends here');
      return out;
    }
    const p = v.position(tdb), vel = v.velocity(tdb);
    const rel = (id: number) => {
      const b = v.bodyAt(id, tdb), b1 = v.bodyAt(id, tdb + 1);
      return { d: Math.hypot(p[0] - b[0], p[1] - b[1], p[2] - b[2]), s: Math.hypot(vel[0] - (b1[0] - b[0]), vel[1] - (b1[1] - b[1]), vel[2] - (b1[2] - b[2])) };
    };
    const sun = rel(10);
    out.push(`Spacecraft · ${formatDuration(tdb - v.traj.start)} into the mission`);
    out.push(`${formatSpeed(sun.s)} around the Sun`);
    const c = localBody(tdb);
    if (c !== 10) {
      const r = rel(c);
      // Over a shape model, the height above the ground below (its largest radius would put
      // a craft low over Eros's waist underground).
      const b = v.bodyAt(c, tdb);
      const up = shapes.get(c)?.ready ? flightWorld.altitude(c, [p[0] - b[0], p[1] - b[1], p[2] - b[2]], tdb) : r.d - bodyById(c).radius[0];
      out.push(`${formatSpeed(r.s)} relative to ${bodyById(c).name}, ${formatDistance(up)} above it`);
    } else {
      const escape = Math.sqrt((2 * GM[10]) / sun.d);
      out.push(`Escape speed from the Sun here ${formatSpeed(escape)}${sun.s > escape ? ': leaving the Solar System for good' : ''}`);
    }
    // What gravity is doing to it: the strongest pulls, GM/r².
    const pulls = craftBodies().filter((id) => GM[id]).map((id) => {
      const b = v.bodyAt(id, tdb);
      const r2 = (p[0] - b[0]) ** 2 + (p[1] - b[1]) ** 2 + (p[2] - b[2]) ** 2;
      return { id, a: GM[id] / r2 };
    }).sort((x, y) => y.a - x.a).slice(0, 2);
    out.push(`Gravity: ${pulls.map((g) => `${bodyById(g.id).name} ${formatAccel(g.a)}`).join(' · ')} (weightless on board: it all falls together)`);
    const next = MISSION_DATA[m.slug].moments.find((x) => x.tdb > tdb);
    if (next) out.push(`Next: ${next.title} in ${formatDuration(next.tdb - tdb)}${next.altitude !== undefined ? `, ${formatDistance(next.altitude)} up` : ''}`);
    const earth = rel(399);
    out.push(`Earth ${formatDistance(earth.d)} away: radio takes ${formatLightTime(earth.d)}`);
    const predicted = m.predictedAfter && tdbToUtc(tdb) > Date.parse(m.predictedAfter);
    out.push(predicted ? 'Path: the team’s planned trajectory (a prediction), JPL Horizons' : 'Path: as flown, reconstructed by its navigation team (JPL Horizons)');
    void eye;
    return out;
  };
  /** Each frame: draw the spacecraft and its path, pace the clock, label it. */
  const updateMission = (eye: Vec3, ppr: number, dt: number) => {
    if (!missionView) return;
    const v = missionView;
    const tdb = clock.tdb;
    const p = v.position(tdb);
    // The trail in the frame of the body the spacecraft is near, while the camera is too.
    const c = localBody(tdb);
    let frame = 10;
    if (c !== 10 && ephemeris.available(c, tdb)) {
      const b = v.bodyAt(c, tdb);
      if (Math.hypot(eye[0] - b[0], eye[1] - b[1], eye[2] - b[2]) < 0.5 * (SOI[c] ?? 0)) frame = c;
    }
    v.update(tdb, eye, frame, system.position(10), system.position(399), system.exposure, ppr, true);
    // Pacing: time runs so the spacecraft covers its own distance from the nearest body
    // (or from the camera, zoomed out) in about six seconds; slow near planets, fast in
    // cruise.
    if (missionPace && !clock.paused && v.traj.covers(tdb)) {
      let best = Infinity;
      const vel = v.velocity(tdb);
      for (const id of craftBodies()) {
        const b = v.bodyAt(id, tdb), b1 = v.bodyAt(id, tdb + 1);
        const alt = Math.max(1, Math.hypot(p[0] - b[0], p[1] - b[1], p[2] - b[2]) - (findBody(id)?.radius[0] ?? 0));
        const speed = Math.max(0.01, Math.hypot(vel[0] - (b1[0] - b[0]), vel[1] - (b1[1] - b[1]), vel[2] - (b1[2] - b[2])));
        best = Math.min(best, alt / speed);
      }
      const camera = rig.focus === craftId() ? rig.distance / Math.max(0.01, length(vel)) : 0;
      const target = Math.log(Math.min(3e6, Math.max(1, Math.max(best, camera) / 6)));
      paceLog = Number.isFinite(paceLog) && paceLog > 0 ? paceLog + (target - paceLog) * (1 - Math.exp(-3 * dt)) : target;
      clock.rate = Math.round(Math.exp(paceLog));
    }
    if (tdb >= v.traj.end && clock.rate > 0 && !clock.paused) {
      clock.paused = true;
      syncRate();
      hud.say(`${v.mission.name}: the trajectory ends here`, 6);
    }
    const from = tdbToUtc(v.traj.start);
    missionPanel.update(tdb, missionPace ? `Auto pace: ${formatRate(clock.rate)} · launched ${new Date(from).toISOString().slice(0, 10)}` : `Launched ${new Date(from).toISOString().slice(0, 10)}`);
  };
  const formatRate = (r: number) => (r < 90 ? `${r}× real time` : r < 5400 ? `${Math.round(r / 60)} min a second` : r < 172800 ? `${(r / 3600).toFixed(1)} h a second` : `${(r / 86400).toFixed(0)} days a second`);
  // Events and tours leave the spacecraft.
  eventSelect.addEventListener('change', () => endMission(), { capture: true });
  tourSelect.addEventListener('change', () => endMission(), { capture: true });

  /** The HUD for a small body drawn from its shape model. */
  const describeShape = (id: number, eye: Vec3): string[] => {
    const view = shapes.get(id)!;
    const ix = view.index!;
    const b = axesOf(id);
    const p = toBodyAxes(b, sub(eye, system.position(id), [0, 0, 0]));
    const r = length(p);
    const out: string[] = [];
    const ground = shapeRadius(id, [p[0] / r, p[1] / r, p[2] / r]);
    out.push(`Altitude ${formatDistance(Math.max(0, r - ground))} above the ground`);
    const e = bodyById(id).radii;
    const size = (km: number) => (km < 2 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);
    out.push(`${size(2 * e[0])} × ${size(2 * e[1])} × ${size(2 * e[2])} · density ${Math.round(ix.density)} kg/m³${ix.gmMeasured ? '' : ' (assumed)'}`);
    const surface = GM[id] / (ix.meanRadius * ix.meanRadius);
    out.push(`Gravity about ${formatAccel(surface)} at the surface · escape speed about ${formatSpeed(Math.sqrt((2 * GM[id]) / ix.meanRadius))}`);
    const w = flightWorld.spin(id, clock.tdb);
    if (w) out.push(`Turns once every ${formatDuration((2 * Math.PI) / length(w))}`);
    out.push(`Shape model: ${ix.faces.toLocaleString('en-US')} triangles (${ix.kept.toLocaleString('en-US')} drawn), ${ix.resolution * 1000 < 10 ? (ix.resolution * 1000).toFixed(1) : Math.round(ix.resolution * 1000)} m detail; smaller boulders computed`);
    return out;
  };

  // ---- frame loop -----------------------------------------------------------
  const nameEl = document.getElementById('focus-name')!;
  const detailEl = document.getElementById('focus-detail')!;
  const utcEl = document.getElementById('utc')!;
  const projected = new THREE.Vector3();
  const rel: Vec3 = [0, 0, 0];
  const sunScene: Vec3 = [0, 0, 0];
  let last = performance.now() / 1000;
  let frameNumber = 0;
  /** The camera under Venus's clouds or Titan's haze, this frame. */
  let underAir: { air: ThickAirParams; h: number; mu0: number; veil: number; albedo: number } | undefined;
  let walkPending = params.get('walk') === '1';
  let lastPending = -1;
  const startedAt = performance.now() / 1000;
  let exposureLog = 0;
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();

  const frame = () => {
    const now = performance.now() / 1000;
    const dt = Math.min(0.25, now - last);
    const tdbBefore = clock.tdb;
    // The rocket keeps the time itself (time on board at the time bar's rate).
    if (!(ship && rocket.on)) clock.tick(dt);
    last = now;
    frameNumber++;
    syncRate();

    system.update(clock.tdb);
    updateOrientation();
    hud.tick(now);
    // Take the controls: on request (?fly=1), or when an instant trip from the ship lands.
    // ?walk=1 starts on foot at the look point (with lat/lon or site), facing `heading`.
    // (Once the ground there has loaded, so the walker doesn't start on coarse terrain.)
    if (walkPending && frameNumber > 2 && rig.anchor && (lastPending === 0 || now - startedAt > 20)) {
      walkPending = false;
      setWalking(rig.focus, rig.anchor.lon, rig.anchor.lat, rig.yaw);
      const w = walker ?? shapeWalker;
      if (params.has('look') && w) w.pitch = Number(params.get('look')) * DEG;
      lookUp = 0;
    }
    // ?event=apophis plays the first event whose title has those words (t and rate still apply).
    if (frameNumber === 2 && params.has('event')) {
      const words = params.get('event')!.toLowerCase().split(/\s+/);
      const ev = eventList.find((e) => words.every((w) => e.title.toLowerCase().includes(w)));
      if (ev) playEvent(ev, params.has('t') ? startTime : undefined, params.has('rate') ? Number(params.get('rate')) : undefined);
    }
    // ?cosmic=sn1987a&at=100 starts a cosmic event at a moment of its own: days for the
    // supernovae, years for b68, seconds from the peak for gw150914 (dist, yaw, pitch apply).
    if (frameNumber === 2 && params.has('cosmic')) {
      const key = params.get('cosmic') as CosmicKey;
      if (COSMIC_KEYS.includes(key)) {
        startCosmic(key, params.has('at') ? Number(params.get('at')) : undefined, params.has('dist') && !params.has('focus') ? { dist: Number(params.get('dist')), yaw: params.has('yaw') ? Number(params.get('yaw')) : undefined, pitch: params.has('pitch') ? Number(params.get('pitch')) : undefined } : undefined, params.has('focus'));
        if (params.has('rate')) {
          cosmicPace = cosmic.paced = false;
          clock.rate = Number(params.get('rate')) || 1;
          clock.paused = Number(params.get('rate')) === 0;
          cosmic.playing = Number(params.get('rate')) !== 0;
        }
      }
    }
    // ?mission=voyager-2 rides along (t, dist, heading and tilt apply).
    if (frameNumber === 2 && params.has('mission')) {
      const k = MISSIONS.findIndex((m) => m.slug === params.get('mission'));
      if (k >= 0) {
        startMission(k, params.has('t') ? clock.tdb : undefined, params.has('dist') && !params.has('focus') ? {
          dist: Number(params.get('dist')),
          yaw: params.has('heading') ? Number(params.get('heading')) * DEG : undefined,
          pitch: params.has('tilt') ? Number(params.get('tilt')) * DEG : undefined,
        } : undefined, params.has('focus'));
      }
    }
    if (frameNumber === 2 && params.get('fly') === '1') {
      setFlight(true);
      if (params.has('target')) flyTo(byName.get(params.get('target')!.toLowerCase()) ?? -1);
      // ?drive=rocket&trip=0.4: already on the way, this far through the trip (time on board).
      if (ship && rocket.on && params.has('trip') && flight.target !== undefined) {
        const d = sub(flightWorld.position(flight.target, clock.tdb), ship.position(flightWorld, clock.tdb));
        const l = length(d);
        ship.look([d[0] / l, d[1] / l, d[2] / l], icrfToScene([0, 0, 1]));
        startTrip(flight.target);
        if (rocket.trip) {
          const r = rocket.trip;
          const tau = Number(params.get('trip')) * r.trip.tau;
          const passed = stepRocket(ship, tau, { thrust: [0, 0, 0], boost: false });
          rocket.earth += passed;
          rocket.now += passed;
          clock.hold(rocket.now);
        }
        if (params.has('rate')) {
          clock.rate = Number(params.get('rate')) || 1;
          clock.paused = Number(params.get('rate')) === 0;
          syncRate();
        }
        if (params.has('look')) ship.rotateBody([0, Number(params.get('look')) * DEG, 0]);
        if (params.has('fov')) fov = Number(params.get('fov'));
      }
    }
    if (flight.jumping === 'start' && rig.flying) flight.jumping = 'flying';
    if (flight.jumping === 'flying' && !rig.flying) {
      flight.jumping = undefined;
      flight.target = undefined;
      setFlight(true);
    }
    let eye: Vec3 = [0, 0, 0], target: Vec3 = [0, 0, 0], up: Vec3 = [0, 1, 0];
    /** In the ship, the direction the camera faces (else it looks at `target`). */
    let lookDir: Vec3 | undefined;
    // Near a black hole the camera is placed from the hole itself: its scene position
    // (hundreds of parsecs out) is far too coarse for a horizon tens of km across.
    let holeRel: Vec3 | undefined;
    // So too the merger's binary, 404 Mpc out (cosmic.ts).
    let cosmicRel: Vec3 | undefined;
    if (ship) {
      const view = flyShip(ship, tdbBefore, dt);
      ({ eye, up } = view);
      lookDir = view.dir;
      rig.focus = ship.ref;
      rig.anchor = undefined;
      rig.distance = length(ship.rel);
      if (isHole(ship.ref)) holeRel = [...ship.rel];
    } else if (shapeWalker) {
      const view = walkShape(shapeWalker, clock.paused ? 0 : clock.tdb - tdbBefore, dt);
      ({ eye, up } = view);
      lookDir = view.dir;
      rig.focus = walkBody;
      rig.anchor = undefined;
      rig.distance = length(sub(eye, system.position(walkBody), [0, 0, 0]));
    } else if (walker) {
      const view = walk(walker, dt);
      ({ eye, up } = view);
      lookDir = view.dir;
      rig.focus = walkBody;
      rig.anchor = undefined;
      rig.distance = length(sub(eye, system.position(walkBody), [0, 0, 0]));
    }
    const focus = targets.get(rig.focus)!;
    rig.minDistance = rig.anchor ? 0.0015 : isDeep(focus.id) ? focus.radius * 0.02 : isHole(focus.id) ? bhs.minDistance(focus.id) : isCosmic(focus.id) ? cosmic.minDistance(focus.id, clock.utc) : focus.radius * 1.0002;
    tours.update(now, rig.flying);
    adaptResolution(dt);
    if (!ship && !onFoot()) {
      const solved = rig.solve(frameOf, now);
      ({ eye, target, up } = solved);
      const offset = solved.offset;
      if (isHole(rig.focus)) {
        const c = bhs.position(rig.focus);
        holeRel = [offset[0] + (target[0] - c[0]), offset[1] + (target[1] - c[1]), offset[2] + (target[2] - c[2])];
      }
      if (isCosmic(rig.focus)) {
        const c = cosmic.position(rig.focus);
        cosmicRel = [offset[0] + (target[0] - c[0]), offset[1] + (target[1] - c[1]), offset[2] + (target[2] - c[2])];
      }
    }

    // Keep the camera above the ground on bodies with terrain.
    for (const [id, s] of surfaces) {
      const local = bodyVector(s, sub(eye, system.position(id), rel));
      const [lon, lat, h] = bodyToGeodetic(s.shape, local);
      if (h > 50) continue;
      // Above both the drawn terrain and any finer tile about to replace it.
      const ground = Math.max(s.globe.heightAt(lon, lat), s.globe.heightAt(lon, lat, true)) + 0.0015;
      if (h < ground) {
        const lifted = sceneVector(s, geodeticToBody(s.shape, lon, lat, ground));
        for (let k = 0; k < 3; k++) eye[k] = system.position(id)[k] + lifted[k];
      }
    }

    // ... and above the shape models' ground (not under an overhang: from outside, along
    // the line to the centre).
    for (const [id, view] of shapes) {
      if (!view.ready || !system.available(id) || shapeWalker) continue;
      const c = system.position(id);
      const b = axesOf(id);
      const p = toBodyAxes(b, sub(eye, c, rel));
      const r = length(p);
      if (r > view.index!.radius * 1.2) continue;
      const ground = shapeRadius(id, [p[0] / r, p[1] / r, p[2] / r], true) + 0.0015;
      if (r < ground) {
        const lifted = toSceneAxes(b, [(p[0] * ground) / r, (p[1] * ground) / r, (p[2] * ground) / r]);
        for (let k = 0; k < 3; k++) eye[k] = c[k] + lifted[k];
      }
    }

    // Moons load when the camera nears their planet.
    for (const [name, planet] of Object.entries(SYSTEMS)) {
      if (planet === 10 || systemRequested.has(name)) continue;
      const p = system.position(planet);
      if (Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]) < bodyById(planet).radius[0] * 3000) prepare(planet);
    }

    // How much of the Sun the camera sees: every globe's disc against the Sun's.
    const sunPos = system.position(10);
    const toSun = sub(sunPos, eye, [0, 0, 0]);
    const dSun = length(toSun);
    const sunAngle = Math.asin(Math.min(1, SUN_RADIUS / dSun));
    let sunVisible = 1;
    let sunVisibleOthers = 1; // not counting the focus body (its own night side)
    for (const body of BODIES) {
      if (body.emissive || !system.available(body.id)) continue;
      const toBody = sub(system.position(body.id), eye, rel);
      const d = length(toBody);
      if (d > dSun) continue;
      const r = surfaces.has(body.id) ? Math.min(body.radii[0], body.radii[2]) : (body.radii[0] + body.radii[1] + body.radii[2]) / 3;
      const sep = Math.atan2(length(cross(toBody, toSun)), dot(toBody, toSun));
      // On the ground of a body with terrain the eye can be inside its reference sphere
      // (Tranquility Base is 1.9 km below it): then the body hides what is below the horizon.
      const rr = surfaces.has(body.id) ? Math.min(r, d - 0.01) : r;
      const cover = d <= rr ? 1 : discOverlap(sunAngle, Math.asin(rr / d), sep);
      sunVisible *= 1 - cover;
      if (body.id !== rig.focus) sunVisibleOthers *= 1 - cover;
    }

    // Floating origin: the camera sits at the three.js origin; the world moves around it.
    if (lookDir) [rel[0], rel[1], rel[2]] = lookDir;
    // Out at the merger the scene's coordinates are far too coarse: aim from the offset.
    else if (cosmicRel && cosmic.precise(rig.focus) && !rig.flying) [rel[0], rel[1], rel[2]] = [-cosmicRel[0], -cosmicRel[1], -cosmicRel[2]];
    else sub(target, eye, rel);
    let viewUp: Vec3 = up;
    if (lookUp !== 0) {
      // Tilt the line of sight up about the camera's right axis (from the ground, to the sky).
      const d = length(rel);
      const fwd: Vec3 = [rel[0] / d, rel[1] / d, rel[2] / d];
      const c = Math.cos(lookUp), sn = Math.sin(lookUp);
      const u0 = up;
      for (let k = 0; k < 3; k++) rel[k] = fwd[k] * c + u0[k] * sn;
      viewUp = [u0[0] * c - fwd[0] * sn, u0[1] * c - fwd[1] * sn, u0[2] * c - fwd[2] * sn];
    }
    if (followSun && !rig.flying && !ship && !onFoot()) {
      // The Sun in the middle, the local vertical up (as a camera on a tracking mount).
      const d = length(toSun);
      for (let k = 0; k < 3; k++) rel[k] = toSun[k] / d;
      const along = dot(up, rel);
      viewUp = [up[0] - along * rel[0], up[1] - along * rel[1], up[2] - along * rel[2]];
    }
    if (skyAim && !rig.flying) {
      rel[0] = skyAim[0]; rel[1] = skyAim[1]; rel[2] = skyAim[2];
      const pole = icrfToScene([0, 0, 1]);
      const along = dot(pole, skyAim);
      viewUp = Math.abs(along) > 0.999 ? icrfToScene([1, 0, 0]) : [pole[0] - along * skyAim[0], pole[1] - along * skyAim[1], pole[2] - along * skyAim[2]];
    }
    camera.fov = fov;
    camera.position.set(0, 0, 0);
    camera.up.set(viewUp[0], viewUp[1], viewUp[2]);
    camera.lookAt(rel[0], rel[1], rel[2]);
    const relLen = length(rel);
    lastView.eye = [...eye];
    lastView.dir = [rel[0] / relLen, rel[1] / relLen, rel[2] / relLen];
    lastView.up = [...viewUp];
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    updateGravityView(ship, now);
    // The ship's velocity, for the relativistic sky (stars, galaxies, glow, background).
    beta[0] = beta[1] = beta[2] = 0;
    if (ship && !ship.warp.on) for (let k = 0; k < 3; k++) beta[k] = ship.vel[k] / C_KMS;
    setRelativity(beta, camera);
    frustum.setFromProjectionMatrix(projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const ppr = pixelsPerRadian();
    let daylight = 0;
    underAir = undefined;
    for (const [id, s] of surfaces) {
      const centre = system.position(id);
      const centerRel = sub(centre, eye, [0, 0, 0]);
      // The other worlds draw as terrain only once they are big enough on screen to
      // need it; until then their plain globe (planets.ts) stands in and no tiles load.
      // Venus and Titan show their ground only from under their clouds and haze.
      if (!hidden.has(id) || WORLD_IDS.has(id)) {
        const big = system.available(id) && (s.shape.a / length(centerRel)) * ppr > TERRAIN_PIXELS / 2 && (!s.air || belowDeck(s.air, bodyVector(s, [-centerRel[0], -centerRel[1], -centerRel[2]])));
        s.globe.group.visible = big;
        if (s.air && s.sky) s.sky.group.visible = big;
        if (big) hidden.add(id);
        else {
          hidden.delete(id);
          continue;
        }
      }
      const eyeBody = bodyVector(s, [-centerRel[0], -centerRel[1], -centerRel[2]]);
      sub(sunPos, centre, sunScene);
      const sunBody = bodyVector(s, sunScene);
      const len = length(sunBody);
      // Eclipses: the Moon's shadow on Earth, Earth's on the Moon, Phobos's on Mars, a
      // planet's on its moons, Pluto's and Charon's on each other.
      const other = eclipser(id);
      const u = s.globe.uniforms;
      u.uEclSun.value.set(sunBody[0], sunBody[1], sunBody[2]);
      u.uEclSunRadius.value = SUN_RADIUS;
      const occ = other < 0 ? [0, 0, 0] : bodyVector(s, sub(system.position(other), centre, [0, 0, 0]));
      const occRadius = other < 0 || !system.available(other) ? 0 : other === 301 ? 1737.4 : other === 399 ? 6371.0 : other === 401 ? 11.08 : meanRadius(other);
      u.uEclOcc.value.set(occ[0], occ[1], occ[2], occRadius);
      u.uSunIntensity.value = system.intensity(id);
      const f: GlobeFrame = { eyeBody, centerRel, bodyToScene: s.bodyToScene, sunBody: [sunBody[0] / len, sunBody[1] / len, sunBody[2] / len], pixelsPerRadian: ppr, frame: frameNumber, frustum };
      s.globe.update(f);
      s.sky?.update(f);
      if (s.air) {
        // Under the deck the sky is the cloud's or haze's own glow: no stars, and the
        // Sun's disc is only as bright as the direct beam that gets through.
        const r = length(eyeBody);
        const h = r - s.air.radius;
        const mu0 = (eyeBody[0] * f.sunBody[0] + eyeBody[1] * f.sunBody[1] + eyeBody[2] * f.sunBody[2]) / r;
        const v = veil(s.air, h);
        daylight = Math.max(daylight, v);
        underAir = { air: s.air, h, mu0, veil: v, albedo: s.albedo ?? 0.1 };
      } else if (s.sky) {
        // In the daytime sky the eye adapts to the bright sky and the stars disappear;
        // in totality the sky goes dark and they come out.
        const altitude = bodyToGeodetic(s.shape, eyeBody)[2];
        const sunUp = (eyeBody[0] * f.sunBody[0] + eyeBody[1] * f.sunBody[1] + eyeBody[2] * f.sunBody[2]) / length(eyeBody);
        const day = smoothstep(-0.2, 0.05, sunUp) * (1 - smoothstep(20, 80, altitude));
        daylight = Math.max(daylight, day * Math.min(1, sunVisible * 30));
      }
    }
    // Small bodies from their shape models: loaded when near, drawn (with their shadows)
    // once a few pixels across; until then the plain globe stands in.
    for (const [id, view] of shapes) {
      if (!system.available(id)) continue;
      const centre = system.position(id);
      const centerRel = sub(centre, eye, [0, 0, 0]);
      const d = length(centerRel);
      const R = bodyById(id).radii[0];
      if (d < R * 3e4) requestShape(id);
      if (!view.ready || (R / d) * ppr < 3) {
        view.hide();
        hidden.delete(id);
        continue;
      }
      hidden.add(id);
      const b = axesOf(id);
      const sunBody = toBodyAxes(b, sub(sunPos, centre, [0, 0, 0]));
      const ls = length(sunBody);
      const intensity = system.intensity(id);
      const f: ShapeFrame = {
        eyeBody: toBodyAxes(b, [-centerRel[0], -centerRel[1], -centerRel[2]]),
        centerRel, bodyToScene: b, sunBody: [sunBody[0] / ls, sunBody[1] / ls, sunBody[2] / ls],
        pixelsPerRadian: ppr, intensity, ambient: intensity * 0.0015,
      };
      const r = length(f.eyeBody);
      if (r < view.index!.radius * 1.5) f.altitude = r - shapeRadius(id, [f.eyeBody[0] / r, f.eyeBody[1] / r, f.eyeBody[2] / r]);
      view.update(f);
      view.renderShadows(renderer, f);
    }
    // ---- stars: the octree loads what can be seen from here, to the current limit.
    const years = yearsSinceEpoch(clock.tdb);
    const camPc = sceneToIcrf(eye, [0, 0, 0]);
    for (let k = 0; k < 3; k++) camPc[k] /= PC_KM;
    const limit = Math.min(14, magnitudeBase + 5 * Math.log10(50 / fov));
    const su = stars.uniforms;
    // A star of magnitude `limit` peaks at 1/400 of full brightness (9/255 on screen);
    // fainter ones fade out over the next 1.5 magnitudes.
    // From a ship near light speed the sky ahead blazes (a blackbody's light goes up with
    // its Doppler-shifted temperature): the eye adapts, partly (the square root of the
    // Milky Way's gain straight ahead), which dims every layer below alike.
    const gammaNow = relativityUniforms.uGamma.value;
    const adapt = gammaNow > 1.001 ? Math.min(12, 1.25 * Math.log10(surfaceGain(gammaNow * (1 + Math.sqrt(1 - 1 / (gammaNow * gammaNow))), 5500))) : 0;
    su.uMsat.value = limit - 6.5 - adapt;
    su.uPixelsPerRadian.value = ppr;
    su.uBrightness.value = 1 - 0.98 * daylight;
    stars.loadLimit = limit + (quality === 'low' ? 0.6 : 1.6);
    stars.update(camPc, years);
    // Diffuse light (the Milky Way's glow, galaxies, nebulae): surface brightness mu
    // (V mag/arcsec^2) shows as 10^(-0.4 (mu - muRef)). A star of the saturation
    // magnitude spread over the star's blur gives muRef, made DIFFUSE_GAIN deeper, as
    // the dark-adapted eye pools faint light over areas far larger than a pixel.
    const pixelArcsec = 206264.806 / ppr;
    const muRef = su.uMsat.value + 2.5 * Math.log10(2 * Math.PI * su.uSigma.value ** 2 * pixelArcsec ** 2) + DIFFUSE_GAIN;
    // Out among the galaxies the exposure lengthens with the scale of the view (as a
    // telescope's would), so the faint galaxies of the cosmic web show.
    const boost = Math.min(8, Math.max(0, 2 * Math.log10(rig.distance / (0.1 * MPC_KM))));
    glow.update(renderer, camera, icrsPcToGalactocentric(camPc), limit, (1 - 0.98 * daylight) * 10 ** (-0.4 * (26.402 - muRef - boost)));
    const camMpc: Vec3 = [camPc[0] * 1e-6, camPc[1] * 1e-6, camPc[2] * 1e-6];
    const galaxyMsat = su.uMsat.value + DIFFUSE_GAIN + boost;
    deep.update(camMpc, galaxyMsat, ppr, 1 - 0.98 * daylight, rig.distance);
    // The microwave background: on when asked for, and on its own from far enough out
    // that the galaxies thin to a web in front of it.
    const fromSunMpc = Math.hypot(camMpc[0], camMpc[1], camMpc[2]);
    const cmbOpacity = (layers.cmb ? 0.8 : 0.8 * smoothstep(1500, 6000, fromSunMpc)) * (1 - 0.98 * daylight);
    // The background's own light, blueshifted into view ahead of a fast enough ship: in
    // the diffuse units above, the Sun's surface is V = -10.61 mag/arcsec^2.
    const surfaceLight = (1 - 0.98 * daylight) * 10 ** (-0.4 * (-10.61 - muRef));
    // Faster still, that patch is smaller than a pixel: drawn as a point with all its light.
    let cmbPoint: { peak: number; sigma: number; ppr: number } | undefined;
    const g = relativityUniforms.uGamma.value;
    if (g > 100 && (Math.sqrt(Math.max(0, (2 * g * 2.7255) / 600 - 1)) / g) * ppr < 1) {
      const m = SUN_V - 2.5 * Math.log10(forwardBackgroundFlux(g));
      const flux = 10 ** (-0.4 * (m - su.uMsat.value)) * (1 - 0.98 * daylight);
      const sigma = su.uSigma.value * pixelRatio * Math.min(Math.pow(Math.max(flux * 33, 1), 0.3), 8);
      cmbPoint = { peak: Math.min(flux, 1), sigma, ppr: ppr * pixelRatio };
    }
    cmb?.update(camera, camMpc, cmbOpacity, surfaceLight, cmbPoint);
    // The Sun is drawn as a star once its disc is a point (beyond 2,000 AU).
    const sunFar = length(sub(sunPos, eye, rel)) > 2000 * AU;
    system.sun.group.visible = !sunFar;
    sunStar.visible = sunFar;
    if (sunFar) {
      const sunPc = sceneToIcrf(sunPos, [0, 0, 0]);
      const attr = sunStar.geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.setXYZ(0, sunPc[0] / PC_KM, sunPc[1] / PC_KM, sunPc[2] / PC_KM);
      attr.needsUpdate = true;
    }
    if (constellations) constellations.opacity = layers.constellations ? 0.6 * (1 - 0.9 * daylight) : 0;
    // Star systems (binaries, planets) draw their own members; other stars up close get a globe.
    const sysHide = sys.update(eye, rig.focus, clock.tdb, system.exposure, ppr, teffCode);
    if (isStar(rig.focus) && sys.active < 0 && rig.distance < focus.radius * 2e5) {
      const p = positionOf(rig.focus);
      starGlobe.update(sub(p, eye, [0, 0, 0]), sys.starLook(rig.focus), system.exposure, clock.tdb, sys.starSpin(rig.focus, clock.tdb));
    } else starGlobe.hide();
    // Up close the globe is the star: drop its point (and anything as near) from the star field.
    stars.hideWithin = Math.max(sysHide, isStar(rig.focus) && rig.distance < focus.radius * 200 ? (1.5 * rig.distance + CATALOGUE_PRECISION * Math.hypot(...positionOf(rig.focus))) / PC_KM : 0);
    bhs.radio = layers.radio;
    stars.hideWithin = Math.max(stars.hideWithin, bhs.update(eye, rig.focus, holeRel, clock.tdb));
    cosmic.update({ eye, focus: rig.focus, rel: cosmicRel, utc: clock.utc, tdb: clock.tdb, dt, ppr, pixelRatio: renderer.getPixelRatio(), surfaceLight });

    // Exposure follows the eye: sunlit ground at the focus body's distance from the Sun
    // looks the same everywhere, the Sun's own surface is shown at a readable level up
    // close, and the eye opens up in the dark of totality.
    // In the ship, the light where the ship is; the Sun's surface only from close by.
    const fromSun = length(sub(ship ? eye : positionOf(rig.focus), sunPos, [0, 0, 0]));
    const sunUpClose = rig.focus === 10 && (!ship || rig.distance < 30 * SUN_RADIUS);
    let exposureTarget = sunUpClose ? 0.6 / (7 * 46200) : Math.min(2500, Math.max(0.15, (fromSun / AU) ** 2));
    // Another star's surface, shown like the Sun's; in its system, the light of its stars
    // where the eye is (or on the planet in view).
    const sysFocus = sys.systemOf(rig.focus);
    const near30 = rig.distance < 30 * focus.radius;
    if ((isStar(rig.focus) || (isSys(rig.focus) && !sys.isPlanet(rig.focus))) && near30) {
      exposureTarget = 0.6 / (7 * SUN_SURFACE_BRIGHTNESS * sys.starLook(rig.focus).surface);
    } else if (sysFocus >= 0 && sys.active >= 0) {
      const onPlanet = sys.isPlanet(rig.focus) && near30;
      exposureTarget = Math.min(2500, Math.max(1e-5, 1 / sys.fluxAt(sysFocus, onPlanet ? positionOf(rig.focus) : eye, clock.tdb)));
      if (onPlanet) exposureTarget *= Math.min(2, Math.max(0.12, 0.09 / sys.planet(rig.focus).albedo));
    }
    // Like the eye, adapt to the body in view: bright clouds and ice get less exposure,
    // dark rock more (Earth and the Moon keep the exposure their maps were made for).
    const focusBody = findBody(rig.focus);
    if (focusBody && (!surfaces.has(focusBody.id) || WORLD_IDS.has(focusBody.id)) && focusBody.id !== 10 && (!ship || rig.distance < 30 * focusBody.radius[0])) {
      // Shape models have no map to keep its contrast: a little less, so relief reads.
      exposureTarget *= Math.min(2, Math.max(0.2, (shapes.has(focusBody.id) ? 0.075 : 0.11) / focusBody.albedo));
    }
    // A spacecraft's white dish and foil reflect about half the light.
    if (isCraft(rig.focus)) exposureTarget *= 0.25;
    // Under Venus's clouds or Titan's haze the eye adapts to the dim light there, and to
    // the ground's own albedo rather than the clouds'.
    if (underAir && (!ship || rig.distance < 30 * (focusBody?.radius[0] ?? Infinity))) {
      const light = Math.max(1e-4, diffuseLight(underAir.air, underAir.h, Math.max(underAir.mu0, 0.05)));
      const own = focusBody ? Math.min(2, Math.max(0.2, 0.11 / focusBody.albedo)) : 1;
      const under = (Math.min(2, Math.max(0.2, 0.11 / underAir.albedo)) / own) * (0.06 / light);
      exposureTarget *= Math.exp(underAir.veil * Math.log(under));
    }
    // In another body's shadow (totality, a lunar eclipse) the eye adapts to the dark.
    exposureTarget *= 1 + 12 * (1 - Math.min(1, sunVisibleOthers * 30));
    // A close-up of the Sun (a transit, the partial phases of an eclipse) is seen through a
    // solar filter: the exposure of the Sun's own surface, so the sky goes black. In
    // totality the filter comes off.
    const sunOffAxis = Math.acos(Math.min(1, dot(lastView.dir, toSun) / dSun));
    if (!sunUpClose && sunAngle > 0.03 * fov * DEG && sunOffAxis < fov * DEG && sunVisible > 0.002) exposureTarget = 0.6 / (7 * 46200);
    const k = 1 - Math.exp(-dt * 2.5);
    exposureLog += (Math.log(exposureTarget) - exposureLog) * (frameNumber === 1 ? 1 : k);
    system.exposure = Math.exp(exposureLog);

    // Satellites: shown near Earth only (further out they crowd onto its disc).
    const earthRel = sub(system.position(399), eye, [0, 0, 0]);
    satellites.group.visible = length(earthRel) < 150000;
    if (satellites.group.visible) {
      const sunDir = sub(sunPos, system.position(399), [0, 0, 0]);
      const d = length(sunDir);
      satellites.update(clock.utc, earthRel, [sunDir[0] / d, sunDir[1] / d, sunDir[2] / d]);
    }

    // An asteroid or comet passing Earth (from an event).
    visitor?.update(earthRel, clock.tdb);
    updateMission(eye, ppr, dt);
    updateCosmic(dt);

    // Orbit lines are a map of the system: they fade out close to a surface.
    let altitude = Infinity;
    for (const [id, sf] of surfaces) altitude = Math.min(altitude, bodyToGeodetic(sf.shape, bodyVector(sf, sub(eye, system.position(id), rel)))[2]);
    for (const [id, view] of shapes) if (view.ready && system.available(id)) altitude = Math.min(altitude, length(sub(eye, system.position(id), rel)) - view.index!.radius);
    system.orbitOpacity = skyAim ? 0 : smoothstep(100, 3000, altitude);
    // A planet's orbit line cuts across the view close up: fade it under 300 radii.
    sys.orbitOpacity = sys.isPlanet(rig.focus) ? smoothstep(30, 300, rig.distance / focus.radius) : 1;
    // Under thick air the Sun's disc is only as bright as the direct beam that gets through.
    let sunDisc = sunVisible;
    if (underAir) {
      const tau = tauAbove(underAir.air, underAir.h);
      sunDisc *= Math.exp(-(0.2126 * tau[0] + 0.7152 * tau[1] + 0.0722 * tau[2]) / Math.max(underAir.mu0, 0.03));
    }
    system.placeRelativeTo(eye, hidden, sunDisc, daylight);
    // Asteroids and comets: a map layer, shown when the view is wide enough to see orbits.
    smallBodies?.update(clock.tdb / 86400, sunPos, eye, Math.max(smoothstep(2e6, 2e7, rig.distance), rig.focus >= ASTEROID_ID && rig.focus < STAR_ID ? 1 : 0));

    if (holeRel && bhs.active(rig.focus, length(holeRel), ppr)) {
      // Lensing: the scene drawn into a view texture and a cube map around the camera,
      // then each pixel's ray traced back through the hole's spacetime.
      const galCam = icrsPcToGalactocentric(camPc);
      const glowScale = (1 - 0.98 * daylight) * 10 ** (-0.4 * (26.402 - muRef - boost));
      const setup = (cam: THREE.PerspectiveCamera, p: number, size?: number) => {
        setRelativity(beta, cam);
        su.uPixelsPerRadian.value = p;
        glow.update(renderer, cam, galCam, limit, glowScale, size);
        deep.update(camMpc, galaxyMsat, p, 1 - 0.98 * daylight, rig.distance);
        cmb?.update(cam, camMpc, cmbOpacity, surfaceLight, cmbPoint);
      };
      bhs.draw(renderer, scene, camera, rig.focus, eye, holeRel, clock.tdb, frameNumber, ppr, (face, size) => setup(face, size / 2, size), () => setup(camera, ppr));
      setRelativity(beta, camera);
    } else if (cosmicRel && cosmic.lensing(rig.focus, cosmicRel, ppr)) {
      // The merging holes bend the light of everything behind them.
      const galCam = icrsPcToGalactocentric(camPc);
      const glowScale = (1 - 0.98 * daylight) * 10 ** (-0.4 * (26.402 - muRef - boost));
      const setup = (cam: THREE.PerspectiveCamera, p: number, size?: number) => {
        su.uPixelsPerRadian.value = p;
        glow.update(renderer, cam, galCam, limit, glowScale, size);
        deep.update(camMpc, galaxyMsat, p, 1 - 0.98 * daylight, rig.distance);
        cmb?.update(cam, camMpc, cmbOpacity, surfaceLight, cmbPoint);
      };
      cosmic.draw(renderer, scene, camera, eye, cosmicRel, frameNumber, (face, size) => setup(face, size / 2, size), () => setup(camera, ppr));
    } else renderer.render(scene, camera);

    // Labels: projected from camera-relative float64 positions. Placed in order of
    // importance; one that would overlap a label already placed is hidden.
    const placed: Array<[number, number]> = [];
    const moving = relativityUniforms.uGamma.value > 1;
    const place = (id: number, label: HTMLElement, p: Vec3, near: boolean) => {
      sub(p, eye, rel);
      // Where its light appears from the moving ship (aberration), as the shaders draw it.
      if (moving) {
        const r = length(rel);
        aberrate([rel[0] / r, rel[1] / r, rel[2] / r], beta, rel);
        for (let k = 0; k < 3; k++) rel[k] *= r;
      }
      // Only the direction matters: a point far beyond the far plane (another galaxy)
      // is labelled where it appears.
      const k = 1e6 / Math.max(length(rel), 1e-9);
      projected.set(rel[0] * k, rel[1] * k, rel[2] * k).project(camera);
      const visible = !near && projected.z < 1 && Math.abs(projected.x) < 1.05 && Math.abs(projected.y) < 1.05;
      const x = (projected.x * 0.5 + 0.5) * innerWidth;
      const y = (-projected.y * 0.5 + 0.5) * innerHeight;
      const show = visible && (id === rig.focus || !placed.some(([px, py]) => Math.abs(px - x) < 60 && Math.abs(py - y) < 14));
      label.style.display = show ? '' : 'none';
      if (show) {
        label.style.left = `${x}px`;
        label.style.top = `${y}px`;
        placed.push([x, y]);
      }
      label.classList.toggle('focus', id === rig.focus);
    };
    /** True if a nearer globe hides the point (camera-relative). */
    // Standing on a world with terrain, its ground hides what is below the horizon: the
    // sphere through the ground underfoot (on Ceres or Vesta the smallest radius is tens
    // of km below it).
    const focusSurface = surfaces.get(rig.focus);
    let groundRadius = 0;
    if (focusSurface && hidden.has(rig.focus)) {
      const local = bodyVector(focusSurface, sub(eye, system.position(rig.focus), [0, 0, 0]));
      const [lon, lat, h] = bodyToGeodetic(focusSurface.shape, local);
      const ground = focusSurface.globe.heightAt(lon, lat);
      if (h - ground < 20) groundRadius = length(local) - (h - ground) - 0.001;
    }
    const hiddenBehind = (id: number, p: Vec3) => {
      const dp = length(p);
      for (const b of BODIES) {
        if (b.id === id || !system.available(b.id)) continue;
        const c = sub(system.position(b.id), eye, rel);
        const along = dot(c, p) / dp;
        if (along <= 0 || along >= dp) continue;
        const r = b.id === rig.focus && groundRadius > 0 ? groundRadius : Math.min(b.radii[0], b.radii[2]);
        if (dot(c, c) - along * along < r * r) return true;
      }
      return false;
    };
    // Sky labels go with the sky: under the ground or in a daylit sky they are hidden.
    const skyDir: Vec3 = [0, 0, 0];
    // A star or exoplanet in view hides what is behind it, like the solar system's globes.
    const focusCentre = isStar(rig.focus) || isSys(rig.focus) ? sub(positionOf(rig.focus), eye, [0, 0, 0]) : undefined;
    const behindFocus = (d: Vec3) => {
      if (!focusCentre) return false;
      const along = dot(focusCentre, d) / length(d);
      return along > 0 && along < length(d) && dot(focusCentre, focusCentre) - along * along < focus.radius ** 2;
    };
    // On the ground, hills and mountains hide the sky behind them too: step out along
    // the line of sight and see whether it passes under the terrain.
    const marchStep: Vec3 = [0, 0, 0];
    const behindTerrain = (d: Vec3) => {
      if (groundRadius <= 0 || !focusSurface) return false;
      const centre = system.position(rig.focus);
      const len = length(d);
      for (let km = 0.25; km < 0.2 * focusSurface.shape.a; km *= 2) {
        for (let k = 0; k < 3; k++) marchStep[k] = eye[k] + (d[k] / len) * km - centre[k];
        const [lon, lat, h] = bodyToGeodetic(focusSurface.shape, bodyVector(focusSurface, marchStep));
        if (h < focusSurface.globe.heightAt(lon, lat)) return true;
      }
      return false;
    };
    const skyHidden = (p: Vec3) => daylight > 0.6 || hiddenBehind(-1, sub(p, eye, skyDir)) || behindFocus(skyDir) || behindTerrain(skyDir);
    const smallFocus = rig.focus >= ASTEROID_ID && !isHole(rig.focus) && !isCraft(rig.focus);
    focusLabel.textContent = smallFocus ? focus.name : '';
    if (smallFocus) place(rig.focus, focusLabel, positionOf(rig.focus), false);
    else focusLabel.style.display = 'none';
    for (const body of LABEL_ORDER) {
      const label = labels.get(body.id)!;
      // Beyond 2,000 AU the planets are lost in the Sun's glare: only the Sun is labelled.
      if (!system.available(body.id) || (sunFar && body.id !== 10)) {
        label.style.display = 'none';
        continue;
      }
      const toLabel = sub(system.position(body.id), eye, [0, 0, 0]);
      const near = length(toLabel) < body.radius[0] * 2.5;
      place(body.id, label, system.position(body.id), near || hiddenBehind(body.id, toLabel));
    }
    for (const [id, button] of buttons) button.classList.toggle('focus', id === rig.focus);

    // Star names: the brightest named stars in view (as seen from the camera), and with
    // the exoplanet layer on, every star with known planets that is bright enough to see.
    // A point a million km away in a direction (labels are placed by projecting points).
    const skyPoint = (dirIcrf: Vec3, out: Vec3) => {
      const d = icrfToScene(dirIcrf, out);
      const scale = 1e6 / length(d);
      for (let k = 0; k < 3; k++) out[k] = eye[k] + d[k] * scale;
      return out;
    };
    const starCandidates: Array<[number, number]> = [];
    if (layers.names || layers.planets) {
      namedStars.forEach((star, k) => {
        if (STAR_ID + k === rig.focus) return;
        // The system in view labels its own stars where their orbits put them.
        if (sys.active >= 0 && sys.systemOf(STAR_ID + k) === sys.active) return;
        namedStarPosition(star, years, starPc);
        const d = Math.hypot(starPc[0] - camPc[0], starPc[1] - camPc[1], starPc[2] - camPc[2]);
        const m = apparentMagnitude(star.M, d, star.av);
        const host = layers.planets && star.planets !== undefined;
        if ((layers.names && m < limit - 4.5 && !star.name.startsWith('HD ')) || (host && m < limit + 1)) starCandidates.push([k, m - (host ? 5 : 0)]);
      });
      starCandidates.sort((a, b) => a[1] - b[1]);
    }
    const shownStars = new Set<number>();
    const labelPoint: Vec3 = [0, 0, 0];
    for (const [k] of starCandidates.slice(0, 60)) {
      const star = namedStars[k];
      namedStarPosition(star, years, starPc);
      const dir: Vec3 = [starPc[0] - camPc[0], starPc[1] - camPc[1], starPc[2] - camPc[2]];
      let label = starLabels.get(k);
      if (!label) {
        label = makeStarLabel(k);
        starLabels.set(k, label);
      }
      label.classList.toggle('host', layers.planets && star.planets !== undefined);
      place(STAR_ID + k, label, skyPoint(dir, labelPoint), skyHidden(labelPoint));
      shownStars.add(k);
    }
    for (const [k, label] of starLabels) if (!shownStars.has(k)) label.style.display = 'none';
    // The stars and planets of the system in view.
    const shownSys = new Set<number>();
    if (layers.names) {
      for (const m of sys.shown) {
        if (m.id === rig.focus) continue;
        let label = sysLabels.get(m.id);
        if (!label) {
          label = document.createElement('div');
          label.className = sys.isPlanet(m.id) ? 'label planet' : 'label skystar';
          label.textContent = m.name;
          const id = m.id;
          label.addEventListener('click', () => flyTo(id));
          labelLayer.append(label);
          sysLabels.set(m.id, label);
        }
        const toLabel = sub(m.pos, eye, [0, 0, 0]);
        place(m.id, label, m.pos, length(toLabel) < targets.get(m.id)!.radius * 2.5 || behindFocus(toLabel));
        shownSys.add(m.id);
      }
    }
    for (const [id, label] of sysLabels) if (!shownSys.has(id)) label.style.display = 'none';
    // Galaxies: the brightest named ones in view, and clusters seen from outside.
    const shownDeep = new Set<number>();
    const deepLabel = (id: number, className: string) => {
      let label = deepLabels.get(id);
      if (!label) {
        label = document.createElement('div');
        label.className = className;
        label.textContent = targets.get(id)!.name;
        label.addEventListener('click', () => flyTo(id));
        labelLayer.append(label);
        deepLabels.set(id, label);
      }
      return label;
    };
    if (layers.names) {
      for (const t of deep.targets) {
        if (t.kind !== 'galaxy cluster' || t.id === rig.focus) continue;
        const p = positionOf(t.id, labelPoint);
        if (length(sub(p, eye, rel)) < t.radius * 1.5) continue;
        place(t.id, deepLabel(t.id, 'label cluster'), p, skyHidden(p));
        shownDeep.add(t.id);
      }
      for (const [id] of deep.labelCandidates(camMpc, galaxyMsat + 4).slice(0, 30)) {
        if (id === rig.focus) continue;
        place(id, deepLabel(id, 'label galaxy'), positionOf(id, labelPoint), skyHidden(labelPoint));
        shownDeep.add(id);
      }
    }
    for (const [id, label] of deepLabels) if (!shownDeep.has(id)) label.style.display = 'none';
    // Stars around a black hole: the S-stars of Sgr A*, a companion.
    const shownBh = new Set<number>();
    if (layers.names && isHole(rig.focus)) {
      for (const [k, name, p] of bhs.labels(rig.focus)) {
        let label = bhLabels.get(k);
        if (!label) {
          label = document.createElement('div');
          label.className = 'label skystar';
          label.textContent = name;
          labelLayer.append(label);
          bhLabels.set(k, label);
        }
        place(-4, label, p, false);
        shownBh.add(k);
      }
    }
    for (const [k, label] of bhLabels) if (!shownBh.has(k)) label.style.display = 'none';
    const constellationCentres = layers.constellations && constellations ? constellations.centres(camPc, years) : [];
    constellationLabels.forEach((label, k) => {
      if (!layers.constellations) {
        label.style.display = 'none';
        return;
      }
      place(-2, label, skyPoint(constellationCentres[k].dir, labelPoint), skyHidden(labelPoint));
    });

    const earthRelLabel = sub(system.position(399), eye, [0, 0, 0]);
    for (const [id, label] of satelliteLabels) {
      const p = satellites.group.visible ? satellites.relativePosition(id) : null;
      let show = false;
      if (p) {
        for (let k = 0; k < 3; k++) rel[k] = earthRelLabel[k] + p[k];
        projected.set(rel[0], rel[1], rel[2]).project(camera);
        // Hidden behind Earth: the line of sight passes through the globe first.
        const along = -(rel[0] * earthRelLabel[0] + rel[1] * earthRelLabel[1] + rel[2] * earthRelLabel[2]) / length(rel);
        const toSat = length(rel);
        const closest = Math.sqrt(Math.max(0, length(earthRelLabel) ** 2 - along * along));
        const blocked = closest < 6360 && along > 0 && along < toSat;
        show = !blocked && projected.z < 1 && Math.abs(projected.x) < 1.05 && Math.abs(projected.y) < 1.05;
        if (show) {
          label.style.left = `${(projected.x * 0.5 + 0.5) * innerWidth}px`;
          label.style.top = `${(-projected.y * 0.5 + 0.5) * innerHeight}px`;
        }
      }
      label.style.display = show ? '' : 'none';
    }

    if (visitorLabel) {
      const p = visitor?.position(clock.tdb);
      if (p) place(-6, visitorLabel, add(system.position(399), p), hiddenBehind(-6, sub(add(system.position(399), p), eye, [0, 0, 0])));
      else visitorLabel.style.display = 'none';
    }
    if (craftLabel) {
      const covered = missionView?.traj.covers(clock.tdb);
      if (missionView && covered) {
        const p = missionView.position(clock.tdb);
        // Close up, the model speaks for itself.
        const near = rig.focus === craftId() && rig.distance < (30 * missionView.size) / 1000;
        place(craftId(), craftLabel, p, near || hiddenBehind(-7, sub(p, eye, [0, 0, 0])));
      } else craftLabel.style.display = 'none';
    }
    if (ship) updateFlightHud(ship, eye);
    if (walker) updateWalkHud(walker);
    if (shapeWalker) updateShapeWalkHud(shapeWalker);
    drawLanders(eye);
    // "Walk here" once the view is down near the ground of a body with terrain.
    const nearShape = shapes.get(rig.focus)?.ready && rig.distance < Math.max(0.1, 0.3 * focus.radius);
    const nearGround = !ship && !rig.flying && ((surfaces.has(rig.focus) && (rig.anchor ? rig.distance < 40 : altitude < 40)) || nearShape);
    walkButton.hidden = !onFoot() && !nearGround;
    const lines: string[] = [];
    const s = surfaces.get(rig.focus);
    if (s) {
      const local = bodyVector(s, sub(eye, system.position(rig.focus), rel));
      const [lon, lat, h] = bodyToGeodetic(s.shape, local);
      const ground = s.globe.heightAt(lon, lat);
      lines.push(`Altitude ${formatDistance(h - ground)} above the ground`);
      lines.push(`${Math.abs(lat / DEG).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon / DEG).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`);
      if (sunVisible < 0.999) lines.push(sunVisible < 1e-6 ? 'Total solar eclipse' : `Sun ${(100 * (1 - sunVisible)).toFixed(1)}% covered`);
    } else if (shapes.get(rig.focus)?.ready && !shapeWalker) {
      lines.push(...describeShape(rig.focus, eye));
    } else if (isDeep(rig.focus)) {
      lines.push(...deep.describe(rig.focus, camMpc, rig.distance));
    } else if (holeRel) {
      lines.push(...bhs.describe(rig.focus, holeRel, clock.tdb));
    } else if (isCosmic(rig.focus)) {
      lines.push(...cosmic.describe(rig.focus, cosmicRel ?? sub(eye, positionOf(rig.focus), [0, 0, 0]), clock.utc));
    } else if (isSys(rig.focus)) {
      lines.push(...sys.describe(rig.focus, eye, clock.tdb));
    } else if (isStar(rig.focus)) {
      const star = starOf(rig.focus);
      const p = namedStarPosition(star, years, [0, 0, 0]);
      const fromSunPc = Math.hypot(p[0], p[1], p[2]);
      const fromEye = Math.hypot(p[0] - camPc[0], p[1] - camPc[1], p[2] - camPc[2]);
      if (star.desig || star.host) lines.push([star.desig, star.host].filter(Boolean).join(' · '));
      lines.push(`${formatLightYears(fromSunPc)} from the Sun (${fromSunPc < 100 ? fromSunPc.toFixed(2) : fromSunPc.toFixed(0)} pc)`);
      lines.push(`Magnitude ${star.V.toFixed(2)} from Earth, ${apparentMagnitude(star.M, fromEye, star.av).toFixed(1)} from here`);
      lines.push(`${star.teff.toLocaleString('en-US')} K, ${star.radius < 10 ? star.radius.toFixed(2) : star.radius.toFixed(0)} × the Sun's radius`);
      lines.push(`Camera ${formatDistance(rig.distance)} from its centre`);
      const binary = sys.binaryLine(rig.focus - STAR_ID, clock.tdb);
      if (binary) lines.push(binary);
      if (star.teff < 7400 && rig.distance < 30 * focus.radius) lines.push('Surface: granulation sized from its temperature and gravity; spots typical, not observed');
      if (star.planets) {
        lines.push(`${star.planets.length} known planet${star.planets.length > 1 ? 's' : ''}:`);
        for (const pl of star.planets.slice(0, 8)) lines.push(`  ${pl.name}: ${describePlanet(pl)}`);
        if (star.planets.length > 8) lines.push(`  and ${star.planets.length - 8} more`);
      }
      lines.push(star.gaia ? `Gaia DR3 ${star.gaia}` : `HIP ${star.hip} (Hipparcos)`);
    } else if (isCraft(rig.focus)) {
      lines.push(...describeCraft(eye));
    } else if (smallFocus) {
      lines.push(focus.kind === 'comet' ? 'Comet' : focus.kind);
      lines.push(`Camera ${formatDistance(rig.distance)} away`);
    } else if (!shapeWalker) {
      lines.push(`Camera altitude ${formatDistance(rig.distance - focus.radius)}`);
    }
    if (focus.id !== 10 && !isStar(focus.id) && !isDeep(focus.id) && !isHole(focus.id) && !isSys(focus.id) && !isCosmic(focus.id)) {
      lines.push(`${(fromSun / AU).toFixed(4)} AU from the Sun`);
      lines.push(`Sunlight takes ${formatLightTime(fromSun)} to arrive`);
    }
    if (rig.focus !== 10 && rig.focus < ASTEROID_ID && !system.available(rig.focus)) lines.push('Loading orbit…');
    if (cmb && cmbOpacity > 0.05) {
      lines.push('Microwave background (Planck, false colour): blue 500 µK colder, red 500 µK hotter than 2.7255 K');
    }
    radioButton.style.display = isHole(rig.focus) && bhs.hole(rig.focus).flow === 'hot' ? '' : 'none';
    ehtPanel.show(isHole(rig.focus) && !rig.flying ? bhs.ehtTarget(rig.focus) : undefined);
    nameEl.textContent = focus.name;
    detailEl.textContent = lines.join('\n');
    utcEl.textContent = formatUtc(clock.utc);
    if (document.activeElement !== dateInput && frameNumber % 15 === 0) dateInput.value = new Date(clock.utc).toISOString().slice(0, 16);
    const pending = [...surfaces.values()].reduce((n, x) => n + x.globe.pending, 0) + [...shapes.values()].reduce((n, x) => n + x.pending, 0) + loading + stars.pending;
    lastPending = pending;
    document.body.dataset.ready = 'true';
    document.body.dataset.tiles = pending === 0 && !rig.flying ? 'idle' : 'loading';
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Stars' masses from their size and temperature (main-sequence mass-luminosity, M ~ L^(1/3.5)). */
function starMass(star: NamedStar): number {
  return Math.min(60, Math.max(0.08, Math.pow(star.radius ** 2 * (star.teff / 5772) ** 4, 1 / 3.5)));
}

/** Label priority: the Sun and planets first, then dwarf planets, moons, asteroids. */
const KIND_ORDER: Record<Body['kind'], number> = { star: 0, planet: 1, dwarf: 2, moon: 3, asteroid: 4, comet: 4, kbo: 4 };
const LABEL_ORDER = [...BODIES].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id === 301 ? -1 : b.id === 301 ? 1 : 0));

/** A world's relief map (pipeline/build_worlds.py relief_map) as raw RGBA bytes. */
async function loadReliefMap(url: string): Promise<ReliefMap> {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  return { width: bitmap.width, height: bitmap.height, data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data };
}

function prepareMap(texture: THREE.Texture, renderer: THREE.WebGLRenderer): THREE.Texture {
  texture.colorSpace = THREE.NoColorSpace; // shaders linearise
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const check = () => (condition() || performance.now() - start > timeoutMs ? resolve() : setTimeout(check, 50));
    check();
  });
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** A small or large number, readably: 0.012, 3.4e-7, 1,200. */
function formatTiny(x: number): string {
  if (x === 0) return '0';
  if (x >= 1000) return Math.round(x).toLocaleString('en-US');
  if (x >= 0.01) return x.toPrecision(2);
  return x.toExponential(1).replace('e-', '×10⁻').replace(/⁻(\d+)/, (_, d: string) => '⁻' + [...d].map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(c)]).join(''));
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function formatLightYears(pc: number): string {
  const ly = pc * 3.261563777;
  return `${ly < 10 ? ly.toFixed(2) : ly < 1000 ? ly.toFixed(1) : Math.round(ly).toLocaleString('en-US')} light years`;
}

function describePlanet(p: Exoplanet): string {
  const parts: string[] = [];
  if (p.radius) parts.push(`${p.radius.toFixed(p.radius < 10 ? 2 : 1)} Earth radii`);
  else if (p.mass) parts.push(`${p.mass.toFixed(p.mass < 10 ? 2 : 0)} Earth masses`);
  if (p.period) parts.push(p.period < 2 ? `${(p.period * 24).toFixed(1)} h orbit` : p.period < 1000 ? `${p.period.toFixed(1)} day orbit` : `${(p.period / 365.25).toFixed(1)} year orbit`);
  if (p.a) parts.push(`${p.a.toFixed(p.a < 1 ? 3 : 2)} AU`);
  if (p.year) parts.push(`found ${p.year}`);
  return parts.join(', ');
}

/** The 3D dust grid (pipeline/build_dust.py): a JSON header and a uint8 volume. */
async function loadDust(base: string): Promise<DustGrid> {
  const [meta, buffer] = await Promise.all([
    fetch(`${base}.json`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))),
    fetch(`${base}.bin`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`)))),
  ]);
  const [nx, ny, nz] = meta.shape as [number, number, number];
  const texture = new THREE.Data3DTexture(new Uint8Array(buffer), nx, ny, nz);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  // lo and hi are cell centres; the texture spans the cells' outer edges.
  const n = [nx, ny, nz];
  const cell = n.map((k, a) => (meta.hi[a] - meta.lo[a]) / (k - 1));
  const lo = n.map((_, a) => meta.lo[a] - cell[a] / 2) as Vec3;
  const size = n.map((k, a) => cell[a] * k) as Vec3;
  return { texture, lo, size, scale: meta.scale };
}

const LIGHT_YEAR_KM = 9460730472580.8;
function formatSpeed(kms: number): string {
  if (kms < 1) return `${(kms * 1000).toFixed(kms < 0.01 ? 2 : kms < 0.1 ? 1 : 0)} m/s`;
  if (kms < 0.05 * 299792.458) return `${kms.toLocaleString('en-US', { maximumFractionDigits: kms < 10 ? 2 : 0 })} km/s`;
  const c = kms / 299792.458;
  if (c < 3e5) return `${c < 10 ? c.toFixed(2) : Math.round(c).toLocaleString('en-US')} × light speed`;
  const ly = kms / LIGHT_YEAR_KM;
  return `${ly < 1e6 ? ly.toPrecision(3) : ly.toExponential(2)} light years a second`;
}

function formatLightYearsKm(km: number): string {
  const ly = km / LIGHT_YEAR_KM;
  if (ly < 0.01) return formatDistance(km);
  return `${ly < 100 ? ly.toFixed(2) : Math.round(ly).toLocaleString('en-US')} light years`;
}

/** A time span in years, for trips at near light speed. */
function formatYears(s: number): string {
  const y = s / (365.25 * 86400);
  if (y < 1) return `${(y * 365.25).toFixed(0)} days`;
  if (y < 100) return `${y.toFixed(y < 10 ? 2 : 1)} years`;
  return `${Math.round(y).toLocaleString('en-US')} years`;
}

/** A speed as a fraction of light, with enough nines to show it. */
function formatBeta(b: number): string {
  if (b < 0.001) return `${(b * C_KMS).toFixed(0)} km/s`;
  if (b < 0.99) return `${b.toFixed(3)} c`;
  // 0.99999 c: as many nines as 1 - beta needs (from gamma, exactly).
  const nines = Math.min(15, Math.floor(-Math.log10(1 - b)) + 2);
  return `${b.toFixed(nines)} c`;
}

function formatG(g: number): string {
  return `${g < 1 ? g.toPrecision(2) : Math.round(g).toLocaleString('en-US')} g`;
}

function formatDuration(s: number): string {
  if (s < 90) return `${s.toFixed(0)} s`;
  if (s < 5400) return `${(s / 60).toFixed(0)} min`;
  if (s < 2 * 86400) return `${(s / 3600).toFixed(1)} h`;
  if (s < 2 * 365.25 * 86400) return `${(s / 86400).toFixed(0)} days`;
  return `${(s / (365.25 * 86400)).toPrecision(3)} years`;
}

function formatLightTime(km: number): string {
  const seconds = km / 299792.458;
  if (seconds < 120) return `${seconds.toFixed(1)} s`;
  if (seconds < 7200) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(2)} h`;
}

main().catch((err) => {
  document.getElementById('focus-name')!.textContent = 'Failed to load';
  document.getElementById('focus-detail')!.textContent = String(err);
  console.error(err);
});
