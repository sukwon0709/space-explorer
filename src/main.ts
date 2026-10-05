import * as THREE from 'three';
import { Ephemeris } from './core/ephemeris';
import { Orientation } from './core/orientation';
import { BODIES, RINGS, SYSTEMS, bodyById, findBody, type Body } from './core/bodies';
import { Clock, utcToTdb } from './core/time';
import { parseSatellites, type SatelliteSnapshot } from './core/satellites';
import { icrfToScene, length, raDecToIcrf, sceneToIcrf, sub } from './core/frames';
import type { Vec3 } from './core/ephemeris';
import { bodyToGeodetic, enu, geodeticToBody, MOON_SPHERE, WGS84, type Shape } from './core/geodesy';
import { TileStore, type Manifest } from './core/tilestore';
import { asteroidOrbit, cometOrbit, orbitPosition, parseAsteroids, type AsteroidSet, type Comet, type Orbit } from './core/smallbodies';
import { AU, SUN_RADIUS, SolarSystem } from './render/world';
import { CameraRig, SCENE_BASIS, type Anchor, type Frame } from './render/camera';
import { Globe, type GlobeFrame } from './render/globe';
import { EarthSky } from './render/sky';
import { discOverlap } from './render/shadow';
import { SmallBodies } from './render/smallbodies';
import { StarField, makeSingleStar, type DustGrid } from './render/stars';
import { Constellations, type ConstellationData } from './render/constellations';
import { StarGlobe } from './render/starglobe';
import { MilkyWayGlow } from './render/milkyway';
import { icrsPcToGalactocentric } from './core/milkyway';
import { DeepSky, GALAXY_ID } from './deepsky';
import { BlackHoles, type SStar } from './blackholes';
import { EhtPanel, type EhtMeta } from './ui/ehtpanel';
import { MPC_KM, type GalaxyIndex } from './core/galaxies';
import type { SkyImage } from './render/images';
import { CmbLayer } from './render/cmb';
import { PC_KM, apparentMagnitude, namedStarPosition, parseStarIndex, yearsSinceEpoch, type Exoplanet, type NamedStar } from './core/stars';
import { NAMED_SATELLITES, SatelliteLayer } from './render/satellites';
import { formatDistance, formatUtc } from './ui/format';
import { EVENTS } from './ui/events';
import { TOURS, TourPlayer, type TourStep } from './ui/tours';
import { FlightControls, FlightHud } from './ui/flight';
import { Ship, apsides, type FlightWorld, type Source, type WarpLimiter } from './core/flight';
import { C_KMS, G0, GM, SolarGravity } from './core/gravity';
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
const SOLAR_RADIUS = 695700;
/** How much deeper (magnitudes) diffuse light is shown than point sources. */
const DIFFUSE_GAIN = 3;

interface Surface {
  globe: Globe;
  shape: Shape;
  /** Body-fixed to scene rotation for the current frame. */
  bodyToScene: Float64Array;
  sky?: EarthSky;
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

async function main() {
  const [ephemeris, orientation, starIndexRaw, namedStars, constellationData, dust, cloudTexture, satelliteSnapshot, smallBuffer, asteroidsBuffer, cometData, asteroidNames, saturnRings, galaxyIndex, galaxyBuffer, skyImages, sstarData, ehtMeta] = await Promise.all([
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
  ]);
  if (smallBuffer) ephemeris.add(smallBuffer);
  const asteroids: AsteroidSet | undefined = asteroidsBuffer ? parseAsteroids(asteroidsBuffer) : undefined;
  // Defunct comets (D/, such as the fragments of Shoemaker-Levy 9) and sungrazers that
  // did not survive perihelion would be drawn on orbits nothing follows any more.
  const comets = cometData.comets.filter((c) => !c.name.startsWith('D/') && c.q > 0.02);

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
  const glow = new MilkyWayGlow(dust);
  scene.add(glow.composite);
  const deep = new DeepSky(
    galaxyIndex, galaxyBuffer, skyImages, renderer.getPixelRatio(), Math.min(8, renderer.capabilities.getMaxAnisotropy()),
    `${BASE}data/galaxies/deep.bin`, `${BASE}data/images/`,
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

  const textureLoader = new THREE.TextureLoader();
  const sunMap = await textureLoader.loadAsync(`${BASE}data/maps/sun.jpg`).catch(() => undefined);
  if (sunMap) prepareMap(sunMap, renderer);
  const system = new SolarSystem(ephemeris, orientation, { sunMap, sunScale: sunMeta.scale, saturnRings });
  scene.add(system.group);

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
  /** Load what a body needs to be drawn properly: its system's moons and the maps there. */
  const prepare = (id: number) => {
    const body = findBody(id);
    if (!body) return;
    const planet = body.orbit && body.orbit.around !== 10 ? body.orbit.around : body.id;
    for (const [name, planetId] of Object.entries(SYSTEMS)) if (planetId === planet) requestSystem(name);
    if (body.file) requestSystem(body.file);
    for (const b of BODIES) if (b.id === planet || b.orbit?.around === planet) requestMap(b.map);
  };

  // ---- Earth and Moon surfaces --------------------------------------------------
  const store = new TileStore(manifest as unknown as Manifest, `${BASE}data/tiles/`);
  const surfaces = new Map<number, Surface>();
  for (const [id, shape, atmosphere] of [[399, WGS84, true], [301, MOON_SPHERE, false]] as const) {
    if (!store.hasBody(id) || !orientation.has(id)) continue;
    const globe = new Globe(id, shape, store, atmosphere);
    if (id === 301) globe.uniforms.uEclTint.value.set(0.02, 0.006, 0.002);
    const surface: Surface = { globe, shape, bodyToScene: new Float64Array(9) };
    if (atmosphere) {
      surface.sky = new EarthSky(globe, cloudTexture);
      scene.add(surface.sky.group);
    }
    scene.add(globe.group);
    surfaces.set(id, surface);
  }
  const hidden = new Set(surfaces.keys()); // drawn by terrain instead of a plain globe

  // ---- asteroids and comets -----------------------------------------------------
  const smallBodies = asteroids ? new SmallBodies(asteroids, comets, renderer.getPixelRatio()) : undefined;
  if (smallBodies) scene.add(smallBodies.group);
  const smallOrbits = new Map<number, Orbit>();
  const targets = new Map<number, Target>();
  for (const body of BODIES) targets.set(body.id, { id: body.id, name: body.name, kind: body.kind, radius: body.radius[0] });
  if (asteroids) {
    for (const a of asteroidNames) {
      if (BODIES.some((b) => b.name === a.name)) continue;
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
  const isHole = (id: number) => bhs.has(id);
  const isStar = (id: number) => id >= STAR_ID && id < GALAXY_ID;
  const isDeep = (id: number) => deep.has(id);
  const starOf = (id: number) => namedStars[id - STAR_ID];
  const helio: Vec3 = [0, 0, 0];
  const starPc: Vec3 = [0, 0, 0];
  const positionOf = (id: number, out: Vec3 = [0, 0, 0]): Vec3 => {
    if (isDeep(id)) return deep.position(id, out);
    if (isHole(id)) return bhs.position(id, out);
    if (isStar(id)) {
      namedStarPosition(starOf(id), yearsSinceEpoch(clock.tdb), starPc);
      for (let k = 0; k < 3; k++) starPc[k] *= PC_KM;
      return icrfToScene(starPc, out);
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
    for (const [id, s] of surfaces) orientation.bodyToScene(id, clock.tdb, s.bodyToScene);
  };

  /** Height of the look point, smoothed so it settles gently as finer terrain loads. */
  const anchorHeights = new Map<number, number>();
  const frameOf = (id: number, anchor?: Anchor): Frame => {
    const centre = positionOf(id);
    const s = surfaces.get(id);
    if (isDeep(id)) return deep.frame(id, centre) ?? { origin: centre, ...SCENE_BASIS };
    if (isHole(id)) return bhs.frame(id, centre);
    if (!s || !anchor) return { origin: centre, ...SCENE_BASIS };
    const target = s.globe.heightAt(anchor.lon, anchor.lat);
    const prev = anchorHeights.get(id) ?? target;
    const h = prev + (target - prev) * 0.15;
    anchorHeights.set(id, h);
    const local = enu(anchor.lon, anchor.lat);
    const origin = sceneVector(s, geodeticToBody(s.shape, anchor.lon, anchor.lat, h));
    for (let k = 0; k < 3; k++) origin[k] += centre[k];
    return { origin, east: sceneVector(s, local.east), north: sceneVector(s, local.north), up: sceneVector(s, local.up) };
  };

  // The focus body's moons (and so its exact position) load first.
  const focusName = (params.get('focus') ?? 'Earth').toLowerCase();
  const focusTarget = [...targets.values()].find((t) => t.name.toLowerCase() === focusName) ?? targets.get(399)!;
  prepare(focusTarget.id);
  await waitFor(() => loading === 0, 20000);

  system.update(clock.tdb);
  updateOrientation();

  /** A look point on the sunlit side: the subsolar point, moved 35 degrees west. */
  const sunlitAnchor = (id: number): Anchor => {
    const s = surfaces.get(id)!;
    const toSun = sub(system.position(10), system.position(id));
    const d = bodyVector(s, toSun);
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
    if (id === 10 || isStar(id)) return [-0.3, 0.9];
    const d = sub(system.position(10), positionOf(id), [0, 0, 0]);
    return [-(Math.atan2(d[0], d[2]) + 0.6), 0.2];
  };
  const viewFor = (id: number) => {
    const target = targets.get(id)!;
    if (surfaces.has(id)) return { distance: target.radius * 3, yaw: 0, pitch: 1.25, anchor: sunlitAnchor(id) };
    if (isDeep(id)) return { ...deep.view(id, target.radius), anchor: undefined };
    if (isHole(id)) return { ...bhs.viewFor(id), anchor: undefined };
    const [yaw, pitch] = sunlitView(id);
    const body = findBody(id);
    const distance = isStar(id) ? target.radius * 6 : !body ? 3e6 : RINGS[id] && id === 699 ? target.radius * 7 : target.radius * 4;
    return { distance, yaw, pitch, anchor: undefined };
  };

  const initial = viewFor(focusTarget.id);
  let anchor = initial.anchor;
  if (surfaces.has(focusTarget.id) && params.has('lat') && params.has('lon')) {
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
    prepare(id);
    if (pick?.(id)) return;
    waitFor(() => id >= ASTEROID_ID || system.available(id), 30000).then(() => {
      const v = viewFor(id);
      rig.flyTo(id, v.distance, performance.now() / 1000, v.yaw, v.pitch, v.anchor);
      lookUp = 0;
      fov = 50;
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
  namedStars.forEach((star, k) => {
    for (const alias of [star.desig, star.host, ...(star.aka ?? [])]) if (alias && !byName.has(alias.toLowerCase())) byName.set(alias.toLowerCase(), STAR_ID + k);
  });
  for (const t of deep.targets) for (const alias of t.aliases) if (!byName.has(alias.toLowerCase())) byName.set(alias.toLowerCase(), t.id);
  for (const t of bhs.targets) for (const alias of t.aliases) if (!byName.has(alias.toLowerCase())) byName.set(alias.toLowerCase(), t.id);
  const deepById = new Map(deep.targets.map((t) => [t.id, t]));
  options.append(...[...targets.values()].map((t) => {
    const o = document.createElement('option');
    o.value = t.name;
    if (isDeep(t.id)) o.label = [...(deepById.get(t.id)?.aliases.slice(0, 2) ?? []), t.kind].join(' · ');
    else if (isHole(t.id)) o.label = 'black hole';
    else if (isStar(t.id)) {
      const star = starOf(t.id);
      o.label = [star.desig, star.host, star.planets ? `${star.planets.length} planet${star.planets.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') || 'star';
    } else if (t.id >= ASTEROID_ID) o.label = t.id >= COMET_ID ? 'comet' : t.kind;
    return o;
  }));
  const go = () => {
    const q = search.value.trim().toLowerCase();
    if (!q) return;
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
    if (pinchState && pointers.size === 2) {
      const now = pinch();
      if (now.d > 0 && pinchState.d > 0) rig.zoom(Math.log(pinchState.d / now.d) / 0.0015);
      rig.orbit(now.x - pinchState.x, now.y - pinchState.y);
      pinchState = now;
      return;
    }
    if (!drag) return;
    if (rig.anchor && drag.button === 0 && !drag.shift) rig.pan(dx, dy, pixelsPerRadian(), targets.get(rig.focus)!.radius);
    else rig.orbit(dx, dy);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (controls.active) controls.scroll(e.deltaY);
    else rig.zoom(e.deltaY);
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
  const eventSelect = document.getElementById('events') as HTMLSelectElement;
  EVENTS.forEach((ev, k) => {
    const o = document.createElement('option');
    o.value = String(k);
    o.textContent = ev.title;
    eventSelect.append(o);
  });
  eventSelect.addEventListener('change', () => {
    const ev = EVENTS[Number(eventSelect.value)];
    eventSelect.value = '';
    if (!ev) return;
    clock.setUtc(Date.parse(ev.utc));
    clock.paused = false;
    clock.rate = ev.rate;
    syncRate();
    const id = byName.get(ev.focus.toLowerCase())!;
    prepare(id);
    const anchor = ev.lat !== undefined && ev.lon !== undefined ? { lat: ev.lat * DEG, lon: ev.lon * DEG } : undefined;
    waitFor(() => system.available(id), 30000).then(() => {
      const v = viewFor(id);
      let yaw = ev.heading !== undefined ? ev.heading * DEG : v.yaw;
      const pitch = ev.tilt !== undefined ? ev.tilt * DEG : v.pitch;
      lookUp = 0;
      system.update(clock.tdb);
      updateOrientation();
      if (ev.aimSun && anchor) {
        // Face the Sun as it will be when the flight lands.
        const [az, alt] = sunAzAlt(id, anchor);
        yaw = az;
        lookUp = alt + pitch;
      }
      rig.flyTo(id, ev.dist, performance.now() / 1000, yaw, pitch, anchor ?? v.anchor);
      fov = ev.fov ?? 50;
    });
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
    });
  };
  const tours = new TourPlayer(document.getElementById('tour')!, tourStep);
  tourSelect.addEventListener('change', () => {
    const tour = TOURS[Number(tourSelect.value)];
    tourSelect.value = '';
    if (tour) tours.start(tour);
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
  /** Stars' masses from their size and temperature (main-sequence mass-luminosity, M ~ L^(1/3.5)). */
  const starMass = (star: NamedStar) => Math.min(60, Math.max(0.08, Math.pow(star.radius ** 2 * (star.teff / 5772) ** 4, 1 / 3.5)));
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
  const rotationAt = (id: number, tdb: number, out: Float64Array) => {
    if (orientation.has(id)) return orientation.bodyToScene(id, tdb, out);
    if (hasRotation(id)) return iauBodyToScene(id, tdb, out);
    return undefined;
  };
  const m0 = new Float64Array(9), m1 = new Float64Array(9);
  const flightWorld: FlightWorld = {
    position(id, tdb, out = [0, 0, 0]) {
      if (findBody(id)) return solar.position(id, tdb, out);
      if (isStar(id)) {
        namedStarPosition(starOf(id), yearsSinceEpoch(tdb), starPc);
        for (let k = 0; k < 3; k++) starPc[k] *= PC_KM;
        return icrfToScene(starPc, out);
      }
      if (isSmall(id)) return smallAt(id, tdb, out);
      return positionOf(id, out); // galaxies and black holes stay put
    },
    velocity(id, tdb, out = [0, 0, 0]) {
      if (findBody(id)) return solar.velocity(id, tdb, out);
      if (isStar(id)) return icrfToScene(starOf(id).vel, out);
      if (isSmall(id)) {
        const a = smallAt(id, tdb + 30, [0, 0, 0]), b = smallAt(id, tdb - 30, [0, 0, 0]);
        for (let k = 0; k < 3; k++) out[k] = (a[k] - b[k]) / 60;
        return out;
      }
      return zero(out);
    },
    acceleration(id, tdb, out = [0, 0, 0]) {
      return findBody(id) ? solar.acceleration(id, tdb, out) : zero(out);
    },
    sources(abs, tdb) {
      const list: Source[] = solar.sources(abs, tdb).map((id) => ({ id, gm: GM[id] }));
      const years = yearsSinceEpoch(tdb);
      const icrf = sceneToIcrf(abs, [0, 0, 0]);
      namedStars.forEach((star, k) => {
        namedStarPosition(star, years, starPc);
        const d = Math.hypot(starPc[0] * PC_KM - icrf[0], starPc[1] * PC_KM - icrf[1], starPc[2] * PC_KM - icrf[2]);
        if (d < 0.05 * PC_KM) list.push({ id: STAR_ID + k, gm: starMass(star) * GM[10] });
      });
      for (const t of bhs.targets) {
        const p = bhs.position(t.id, scratch);
        if (Math.hypot(p[0] - abs[0], p[1] - abs[1], p[2] - abs[2]) < 10 * PC_KM) {
          list.push({ id: t.id, gm: bhs.hole(t.id).mass * GM[10], horizon: holeHorizon(t.id) });
        }
      }
      return list;
    },
    altitude(id, rel) {
      const s = surfaces.get(id);
      if (s) {
        const [lon, lat, h] = bodyToGeodetic(s.shape, bodyVector(s, rel, scratch));
        return h - Math.max(s.globe.heightAt(lon, lat), s.globe.heightAt(lon, lat, true)) - 0.002;
      }
      const body = findBody(id);
      if (body) return length(rel) - body.radius[0];
      if (isStar(id)) return length(rel) - starOf(id).radius * SOLAR_RADIUS;
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
    namedStars.forEach((star, k) => {
      namedStarPosition(star, years, starPc);
      const d = Math.hypot(starPc[0] * PC_KM - icrf[0], starPc[1] * PC_KM - icrf[1], starPc[2] * PC_KM - icrf[2]);
      const infl = 2e4 * AU * Math.sqrt(starMass(star));
      if (d < infl && infl < bestSize) {
        best = STAR_ID + k;
        bestSize = infl;
      }
    });
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
      namedStarPosition(star, years, starPc);
      for (let c = 0; c < 3; c++) starPc[c] *= PC_KM;
      list.push({ id: STAR_ID + k, pos: icrfToScene(starPc), radius: r, arrive: 10 * r });
    });
    for (const t of bhs.targets) {
      const rg = bhs.hole(t.id).mass * SUN_GM_KM;
      list.push({ id: t.id, pos: bhs.position(t.id), radius: holeHorizon(t.id), arrive: 25 * rg });
    }
    for (const t of deep.targets) if (t.kind === 'galaxy') list.push({ id: t.id, pos: deepAt(t.id), radius: t.radius, arrive: 0, soft: true });
    if (flight.target !== undefined && !findBody(flight.target) && !isStar(flight.target) && !isHole(flight.target)) {
      // Galaxies, nebulae, asteroids and comets: stop at the usual viewing distance.
      const id = flight.target;
      const pos = isSmall(id) ? smallAt(id, tdb, [0, 0, 0]) : isDeep(id) ? deepAt(id) : positionOf(id);
      list.push({ id, pos, radius: 0, arrive: isSmall(id) ? 3000 : viewFor(id).distance });
    }
    return list;
  };

  const controls = new FlightControls({
    warp: () => toggleWarp(),
    assist: () => {
      if (!ship) return;
      ship.assist = !ship.assist;
      hud.say(ship.assist ? 'Flight assist on: the ship holds still when you let go' : 'Flight assist off: nothing stops you but your engines');
    },
    align: () => {
      if (flight.target === undefined) hud.say('Pick a destination first: type a name or click a label');
      else {
        flight.aligning = true;
        controls.turned = false;
      }
    },
    jump: () => {
      if (flight.target === undefined) hud.say('Pick a destination first: type a name or click a label');
      else jump(flight.target);
    },
    exit: () => setFlight(false),
  });
  const hud = new FlightHud();
  const flight = {
    target: undefined as number | undefined,
    aligning: false,
    /** Waiting for an instant trip to finish, to take the controls again. */
    jumping: undefined as 'start' | 'flying' | undefined,
    power: Number(params.get('power') ?? 3),
    assist: params.get('assist') !== '0',
  };
  let ship: Ship | undefined;
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
      fov = 60;
      hud.say(`You have the controls, near ${nameOf(ref)}. W to thrust, drag to turn, X for warp. Controls lists the rest.`, 8);
    } else if (!on && ship) {
      const eye = ship.position(flightWorld, clock.tdb);
      const focus = ship.ref;
      ship = undefined;
      flight.aligning = false;
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
    flight.aligning = false;
    hud.say(`Destination: ${nameOf(id)}. T turns toward it, X warps there, G jumps straight there.`, 6);
    return true;
  };
  const toggleWarp = () => {
    if (!ship) return;
    const tdb = clock.tdb;
    if (ship.warp.on) {
      ship.dropWarp(flightWorld, tdb);
      hud.say('Warp drive off');
      return;
    }
    const blocked = ship.engageWarp(flightWorld, tdb, warpLimiters(tdb), flight.target !== undefined);
    if (blocked) hud.say(`Too close to ${nameOf(blocked.id)} to warp toward it: turn away or fly out first`);
    else hud.say(flight.target !== undefined ? `Warp drive on: it slows by itself near anything ahead, and stops at ${nameOf(flight.target)} if you point at it` : 'Warp drive on: W faster, S slower, X to stop');
  };
  /** Instant travel from the ship: the usual flight there, then the controls back. */
  const jump = (id: number) => {
    setFlight(false);
    flight.jumping = 'start';
    flyTo(id);
  };
  // Events and tours move the camera themselves: they leave the ship.
  eventSelect.addEventListener('change', () => setFlight(false), { capture: true });
  tourSelect.addEventListener('change', () => setFlight(false), { capture: true });

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
    if (controls.turned) flight.aligning = false;
    if (flight.aligning && flight.target !== undefined) {
      const dir = sub(flightWorld.position(flight.target, tdb), s.position(flightWorld, tdb));
      const d = length(dir);
      if (s.align([dir[0] / d, dir[1] / d, dir[2] / d], 1.2, dt) < 1e-4 && !s.warp.on) flight.aligning = false;
    }
    const input = controls.input(s.warp.on);
    const limiters = s.warp.on ? warpLimiters(tdb) : [];
    const events = s.step(flightWorld, tdbBefore, tdb - tdbBefore, dt, input, limiters);
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
  const updateFlightHud = (s: Ship, eye: Vec3) => {
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

  // ---- frame loop -----------------------------------------------------------
  const nameEl = document.getElementById('focus-name')!;
  const detailEl = document.getElementById('focus-detail')!;
  const utcEl = document.getElementById('utc')!;
  const projected = new THREE.Vector3();
  const rel: Vec3 = [0, 0, 0];
  const sunScene: Vec3 = [0, 0, 0];
  let last = performance.now() / 1000;
  let frameNumber = 0;
  let exposureLog = 0;
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();

  const frame = () => {
    const now = performance.now() / 1000;
    const dt = Math.min(0.25, now - last);
    const tdbBefore = clock.tdb;
    clock.tick(dt);
    last = now;
    frameNumber++;
    syncRate();

    system.update(clock.tdb);
    updateOrientation();
    hud.tick(now);
    // Take the controls: on request (?fly=1), or when an instant trip from the ship lands.
    if (frameNumber === 2 && params.get('fly') === '1') {
      setFlight(true);
      if (params.has('target')) flyTo(byName.get(params.get('target')!.toLowerCase()) ?? -1);
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
    if (ship) {
      const view = flyShip(ship, tdbBefore, dt);
      ({ eye, up } = view);
      lookDir = view.dir;
      rig.focus = ship.ref;
      rig.anchor = undefined;
      rig.distance = length(ship.rel);
      if (isHole(ship.ref)) holeRel = [...ship.rel];
    }
    const focus = targets.get(rig.focus)!;
    rig.minDistance = rig.anchor ? 0.0015 : isDeep(focus.id) ? focus.radius * 0.02 : isHole(focus.id) ? bhs.minDistance(focus.id) : focus.radius * 1.0002;
    tours.update(now, rig.flying);
    adaptResolution(dt);
    if (!ship) {
      const solved = rig.solve(frameOf, now);
      ({ eye, target, up } = solved);
      const offset = solved.offset;
      if (isHole(rig.focus)) {
        const c = bhs.position(rig.focus);
        holeRel = [offset[0] + (target[0] - c[0]), offset[1] + (target[1] - c[1]), offset[2] + (target[2] - c[2])];
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
      const cover = d <= r ? 1 : discOverlap(sunAngle, Math.asin(r / d), sep);
      sunVisible *= 1 - cover;
      if (body.id !== rig.focus) sunVisibleOthers *= 1 - cover;
    }

    // Floating origin: the camera sits at the three.js origin; the world moves around it.
    if (lookDir) [rel[0], rel[1], rel[2]] = lookDir;
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
    frustum.setFromProjectionMatrix(projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const ppr = pixelsPerRadian();
    let daylight = 0;
    for (const [id, s] of surfaces) {
      const centre = system.position(id);
      const centerRel = sub(centre, eye, [0, 0, 0]);
      const eyeBody = bodyVector(s, [-centerRel[0], -centerRel[1], -centerRel[2]]);
      sub(sunPos, centre, sunScene);
      const sunBody = bodyVector(s, sunScene);
      const len = length(sunBody);
      // Eclipses: the Moon's shadow on Earth, Earth's on the Moon.
      const other = id === 399 ? 301 : 399;
      const u = s.globe.uniforms;
      u.uEclSun.value.set(sunBody[0], sunBody[1], sunBody[2]);
      u.uEclSunRadius.value = SUN_RADIUS;
      const occ = bodyVector(s, sub(system.position(other), centre, [0, 0, 0]));
      const occRadius = other === 301 ? 1737.4 : 6371.0;
      u.uEclOcc.value.set(occ[0], occ[1], occ[2], occRadius);
      u.uSunIntensity.value = system.intensity(id);
      const f: GlobeFrame = { eyeBody, centerRel, bodyToScene: s.bodyToScene, sunBody: [sunBody[0] / len, sunBody[1] / len, sunBody[2] / len], pixelsPerRadian: ppr, frame: frameNumber, frustum };
      s.globe.update(f);
      s.sky?.update(f);
      if (s.sky) {
        // In the daytime sky the eye adapts to the bright sky and the stars disappear;
        // in totality the sky goes dark and they come out.
        const altitude = bodyToGeodetic(s.shape, eyeBody)[2];
        const sunUp = (eyeBody[0] * f.sunBody[0] + eyeBody[1] * f.sunBody[1] + eyeBody[2] * f.sunBody[2]) / length(eyeBody);
        const day = smoothstep(-0.2, 0.05, sunUp) * (1 - smoothstep(20, 80, altitude));
        daylight = Math.max(daylight, day * Math.min(1, sunVisible * 30));
      }
    }
    // ---- stars: the octree loads what can be seen from here, to the current limit.
    const years = yearsSinceEpoch(clock.tdb);
    const camPc = sceneToIcrf(eye, [0, 0, 0]);
    for (let k = 0; k < 3; k++) camPc[k] /= PC_KM;
    const limit = Math.min(14, magnitudeBase + 5 * Math.log10(50 / fov));
    const su = stars.uniforms;
    // A star of magnitude `limit` peaks at 1/400 of full brightness (9/255 on screen);
    // fainter ones fade out over the next 1.5 magnitudes.
    su.uMsat.value = limit - 6.5;
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
    cmb?.update(camera, camMpc, cmbOpacity);
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
    if (isStar(rig.focus) && rig.distance < focus.radius * 2e5) {
      const p = positionOf(rig.focus);
      const fromEarth = sub(p, system.position(399), [0, 0, 0]);
      const star = starOf(rig.focus);
      starGlobe.update(star.name, sub(p, eye, [0, 0, 0]), focus.radius, star.teff, star.planets, fromEarth);
    } else starGlobe.hide();
    // Up close the globe is the star: drop its point (and anything as near) from the star field.
    stars.hideWithin = isStar(rig.focus) && rig.distance < focus.radius * 200 ? (1.5 * rig.distance) / PC_KM : 0;
    bhs.radio = layers.radio;
    stars.hideWithin = Math.max(stars.hideWithin, bhs.update(eye, rig.focus, holeRel, clock.tdb));

    // Exposure follows the eye: sunlit ground at the focus body's distance from the Sun
    // looks the same everywhere, the Sun's own surface is shown at a readable level up
    // close, and the eye opens up in the dark of totality.
    // In the ship, the light where the ship is; the Sun's surface only from close by.
    const fromSun = length(sub(ship ? eye : positionOf(rig.focus), sunPos, [0, 0, 0]));
    const sunUpClose = rig.focus === 10 && (!ship || rig.distance < 30 * SUN_RADIUS);
    let exposureTarget = sunUpClose ? 0.6 / (7 * 46200) : Math.min(2500, Math.max(0.15, (fromSun / AU) ** 2));
    // Like the eye, adapt to the body in view: bright clouds and ice get less exposure,
    // dark rock more (Earth and the Moon keep the exposure their maps were made for).
    const focusBody = findBody(rig.focus);
    if (focusBody && !surfaces.has(focusBody.id) && focusBody.id !== 10 && (!ship || rig.distance < 30 * focusBody.radius[0])) {
      exposureTarget *= Math.min(2, Math.max(0.2, 0.11 / focusBody.albedo));
    }
    // In another body's shadow (totality, a lunar eclipse) the eye adapts to the dark.
    exposureTarget *= 1 + 12 * (1 - Math.min(1, sunVisibleOthers * 30));
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

    // Orbit lines are a map of the system: they fade out close to a surface.
    let altitude = Infinity;
    for (const [id, sf] of surfaces) altitude = Math.min(altitude, bodyToGeodetic(sf.shape, bodyVector(sf, sub(eye, system.position(id), rel)))[2]);
    system.orbitOpacity = skyAim ? 0 : smoothstep(100, 3000, altitude);
    system.placeRelativeTo(eye, hidden, sunVisible, daylight);
    // Asteroids and comets: a map layer, shown when the view is wide enough to see orbits.
    smallBodies?.update(clock.tdb / 86400, sunPos, eye, Math.max(smoothstep(2e6, 2e7, rig.distance), rig.focus >= ASTEROID_ID && rig.focus < STAR_ID ? 1 : 0));

    if (holeRel && bhs.active(rig.focus, length(holeRel), ppr)) {
      // Lensing: the scene drawn into a view texture and a cube map around the camera,
      // then each pixel's ray traced back through the hole's spacetime.
      const galCam = icrsPcToGalactocentric(camPc);
      const glowScale = (1 - 0.98 * daylight) * 10 ** (-0.4 * (26.402 - muRef - boost));
      const setup = (cam: THREE.PerspectiveCamera, p: number, size?: number) => {
        su.uPixelsPerRadian.value = p;
        glow.update(renderer, cam, galCam, limit, glowScale, size);
        deep.update(camMpc, galaxyMsat, p, 1 - 0.98 * daylight, rig.distance);
        cmb?.update(cam, camMpc, cmbOpacity);
      };
      bhs.draw(renderer, scene, camera, rig.focus, eye, holeRel, clock.tdb, frameNumber, ppr, (face, size) => setup(face, size / 2, size), () => setup(camera, ppr));
    } else renderer.render(scene, camera);

    // Labels: projected from camera-relative float64 positions. Placed in order of
    // importance; one that would overlap a label already placed is hidden.
    const placed: Array<[number, number]> = [];
    const place = (id: number, label: HTMLElement, p: Vec3, near: boolean) => {
      sub(p, eye, rel);
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
    const hiddenBehind = (id: number, p: Vec3) => {
      const dp = length(p);
      for (const b of BODIES) {
        if (b.id === id || !system.available(b.id)) continue;
        const c = sub(system.position(b.id), eye, rel);
        const along = dot(c, p) / dp;
        if (along <= 0 || along >= dp) continue;
        const r = Math.min(b.radii[0], b.radii[2]);
        if (dot(c, c) - along * along < r * r) return true;
      }
      return false;
    };
    const smallFocus = rig.focus >= ASTEROID_ID && !isHole(rig.focus);
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
      place(STAR_ID + k, label, skyPoint(dir, labelPoint), false);
      shownStars.add(k);
    }
    for (const [k, label] of starLabels) if (!shownStars.has(k)) label.style.display = 'none';
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
        place(t.id, deepLabel(t.id, 'label cluster'), p, false);
        shownDeep.add(t.id);
      }
      for (const [id] of deep.labelCandidates(camMpc, galaxyMsat + 4).slice(0, 30)) {
        if (id === rig.focus) continue;
        place(id, deepLabel(id, 'label galaxy'), positionOf(id, labelPoint), false);
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
      place(-2, label, skyPoint(constellationCentres[k].dir, labelPoint), false);
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

    if (ship) updateFlightHud(ship, eye);
    const lines: string[] = [];
    const s = surfaces.get(rig.focus);
    if (s) {
      const local = bodyVector(s, sub(eye, system.position(rig.focus), rel));
      const [lon, lat, h] = bodyToGeodetic(s.shape, local);
      const ground = s.globe.heightAt(lon, lat);
      lines.push(`Altitude ${formatDistance(h - ground)} above the ground`);
      lines.push(`${Math.abs(lat / DEG).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon / DEG).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`);
      if (sunVisible < 0.999) lines.push(sunVisible < 1e-6 ? 'Total solar eclipse' : `Sun ${(100 * (1 - sunVisible)).toFixed(1)}% covered`);
    } else if (isDeep(rig.focus)) {
      lines.push(...deep.describe(rig.focus, camMpc, rig.distance));
    } else if (holeRel) {
      lines.push(...bhs.describe(rig.focus, holeRel, clock.tdb));
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
      if (star.planets) {
        lines.push(`${star.planets.length} known planet${star.planets.length > 1 ? 's' : ''}:`);
        for (const pl of star.planets.slice(0, 8)) lines.push(`  ${pl.name}: ${describePlanet(pl)}`);
        if (star.planets.length > 8) lines.push(`  and ${star.planets.length - 8} more`);
      }
      lines.push(star.gaia ? `Gaia DR3 ${star.gaia}` : `HIP ${star.hip} (Hipparcos)`);
    } else if (smallFocus) {
      lines.push(focus.kind === 'comet' ? 'Comet' : focus.kind);
      lines.push(`Camera ${formatDistance(rig.distance)} away`);
    } else {
      lines.push(`Camera altitude ${formatDistance(rig.distance - focus.radius)}`);
    }
    if (focus.id !== 10 && !isStar(focus.id) && !isDeep(focus.id) && !isHole(focus.id)) {
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
    const pending = [...surfaces.values()].reduce((n, x) => n + x.globe.pending, 0) + loading + stars.pending;
    document.body.dataset.ready = 'true';
    document.body.dataset.tiles = pending === 0 && !rig.flying ? 'idle' : 'loading';
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Label priority: the Sun and planets first, then dwarf planets, moons, asteroids. */
const KIND_ORDER: Record<Body['kind'], number> = { star: 0, planet: 1, dwarf: 2, moon: 3, asteroid: 4 };
const LABEL_ORDER = [...BODIES].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id === 301 ? -1 : b.id === 301 ? 1 : 0));

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
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

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
