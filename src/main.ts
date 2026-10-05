import * as THREE from 'three';
import { Ephemeris } from './core/ephemeris';
import { Orientation } from './core/orientation';
import { BODIES, RINGS, SYSTEMS, bodyById, findBody, type Body } from './core/bodies';
import { Clock, utcToTdb } from './core/time';
import { parseSatellites, type SatelliteSnapshot } from './core/satellites';
import { length, sub } from './core/frames';
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
import { createStarField } from './render/stars';
import { NAMED_SATELLITES, SatelliteLayer } from './render/satellites';
import { formatDistance, formatUtc } from './ui/format';
import { EVENTS } from './ui/events';
import manifest from './generated/tiles.json';
import cloudsMeta from './generated/clouds.json';
import mapsMeta from './generated/maps.json';
import sunMeta from './generated/sun.json';

const DEG = Math.PI / 180;
const BASE = import.meta.env.BASE_URL;
/** Search targets that are not globes get ids above these: asteroid or comet index added. */
const ASTEROID_ID = 30_000_000;
const COMET_ID = 40_000_000;

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
  const [ephemeris, orientation, starData, cloudTexture, satelliteSnapshot, smallBuffer, asteroidsBuffer, cometData, asteroidNames, saturnRings] = await Promise.all([
    Ephemeris.load(`${BASE}data/de440.bin`),
    Orientation.load(`${BASE}data/orientation.bin`),
    fetch(`${BASE}data/stars.bin`).then((r) => r.arrayBuffer()),
    new THREE.TextureLoader().loadAsync(`${BASE}data/clouds.png`).catch(() => undefined),
    fetch(`${BASE}data/satellites.json`).then((r) => r.json() as Promise<SatelliteSnapshot>).catch(() => undefined),
    Ephemeris.fetch(`${BASE}data/moons-asteroids.bin`).catch(() => undefined),
    fetch(`${BASE}data/asteroids.bin`).then((r) => r.arrayBuffer()).catch(() => undefined),
    fetch(`${BASE}data/comets.json`).then((r) => r.json() as Promise<{ comets: Comet[] }>).catch(() => ({ comets: [] as Comet[] })),
    fetch(`${BASE}data/asteroid-names.json`).then((r) => r.json() as Promise<Array<{ name: string; designation: string; index: number }>>).catch(() => []),
    fetch(`${BASE}data/saturn-rings.json`).then((r) => r.json()).catch(() => undefined),
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
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 1e-5, 1e13);
  const stars = createStarField(starData);
  (stars.material as THREE.ShaderMaterial).uniforms.pixelRatio.value = renderer.getPixelRatio();
  scene.add(stars);

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
  const helio: Vec3 = [0, 0, 0];
  const positionOf = (id: number, out: Vec3 = [0, 0, 0]): Vec3 => {
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
    if (id === 10) return [-0.3, 0.9];
    const d = sub(system.position(10), positionOf(id), [0, 0, 0]);
    return [-(Math.atan2(d[0], d[2]) + 0.6), 0.2];
  };
  const viewFor = (id: number) => {
    const target = targets.get(id)!;
    if (surfaces.has(id)) return { distance: target.radius * 3, yaw: 0, pitch: 1.25, anchor: sunlitAnchor(id) };
    const [yaw, pitch] = sunlitView(id);
    const body = findBody(id);
    const distance = !body ? 3e6 : RINGS[id] && id === 699 ? target.radius * 7 : target.radius * 4;
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
  const flyTo = (id: number) => {
    prepare(id);
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
  options.append(...[...targets.values()].map((t) => {
    const o = document.createElement('option');
    o.value = t.name;
    if (t.id >= ASTEROID_ID) o.label = t.id >= COMET_ID ? 'comet' : t.kind;
    return o;
  }));
  const go = () => {
    const q = search.value.trim().toLowerCase();
    if (!q) return;
    const id = byName.get(q) ?? [...targets.values()].find((t) => t.name.toLowerCase().includes(q))?.id;
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
  // right-drag or shift-drag turns and tilts the view.
  let drag: { button: number; shift: boolean } | undefined;
  const pixelsPerRadian = () => innerHeight / (2 * Math.tan((camera.fov * DEG) / 2));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => { drag = { button: e.button, shift: e.shiftKey }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { drag = undefined; });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (rig.anchor && drag.button === 0 && !drag.shift) rig.pan(e.movementX, e.movementY, pixelsPerRadian(), targets.get(rig.focus)!.radius);
    else rig.orbit(e.movementX, e.movementY);
  });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); rig.zoom(e.deltaY); }, { passive: false });

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
      'Stars: Hipparcos (XHIP)',
    ].filter(Boolean).join(' · ');
  }
  updateCredits();

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
    clock.tick(dt);
    last = now;
    frameNumber++;
    syncRate();

    system.update(clock.tdb);
    updateOrientation();
    const focus = targets.get(rig.focus)!;
    rig.minDistance = rig.anchor ? 0.0015 : focus.radius * 1.0002;
    const { eye, target, up } = rig.solve(frameOf, now);

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
    sub(target, eye, rel);
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
    camera.fov = fov;
    camera.position.set(0, 0, 0);
    camera.up.set(viewUp[0], viewUp[1], viewUp[2]);
    camera.lookAt(rel[0], rel[1], rel[2]);
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
    (stars.material as THREE.ShaderMaterial).uniforms.brightness.value = 1 - 0.98 * daylight;

    // Exposure follows the eye: sunlit ground at the focus body's distance from the Sun
    // looks the same everywhere, the Sun's own surface is shown at a readable level up
    // close, and the eye opens up in the dark of totality.
    const fromSun = length(sub(positionOf(rig.focus), sunPos, [0, 0, 0]));
    let exposureTarget = rig.focus === 10 ? 0.6 / (7 * 46200) : Math.min(2500, Math.max(0.15, (fromSun / AU) ** 2));
    // Like the eye, adapt to the body in view: bright clouds and ice get less exposure,
    // dark rock more (Earth and the Moon keep the exposure their maps were made for).
    const focusBody = findBody(rig.focus);
    if (focusBody && !surfaces.has(focusBody.id) && focusBody.id !== 10) exposureTarget *= Math.min(2, Math.max(0.2, 0.11 / focusBody.albedo));
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
    system.orbitOpacity = smoothstep(100, 3000, altitude);
    system.placeRelativeTo(eye, hidden, sunVisible, daylight);
    // Asteroids and comets: a map layer, shown when the view is wide enough to see orbits.
    smallBodies?.update(clock.tdb / 86400, sunPos, eye, Math.max(smoothstep(2e6, 2e7, rig.distance), rig.focus >= ASTEROID_ID ? 1 : 0));

    renderer.render(scene, camera);

    // Labels: projected from camera-relative float64 positions. Placed in order of
    // importance; one that would overlap a label already placed is hidden.
    const placed: Array<[number, number]> = [];
    const place = (id: number, label: HTMLElement, p: Vec3, near: boolean) => {
      sub(p, eye, rel);
      projected.set(rel[0], rel[1], rel[2]).project(camera);
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
    const smallFocus = rig.focus >= ASTEROID_ID;
    focusLabel.textContent = smallFocus ? focus.name : '';
    if (smallFocus) place(rig.focus, focusLabel, positionOf(rig.focus), false);
    else focusLabel.style.display = 'none';
    for (const body of LABEL_ORDER) {
      const label = labels.get(body.id)!;
      if (!system.available(body.id)) {
        label.style.display = 'none';
        continue;
      }
      const toLabel = sub(system.position(body.id), eye, [0, 0, 0]);
      const near = length(toLabel) < body.radius[0] * 2.5;
      place(body.id, label, system.position(body.id), near || hiddenBehind(body.id, toLabel));
    }
    for (const [id, button] of buttons) button.classList.toggle('focus', id === rig.focus);

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

    const lines: string[] = [];
    const s = surfaces.get(rig.focus);
    if (s) {
      const local = bodyVector(s, sub(eye, system.position(rig.focus), rel));
      const [lon, lat, h] = bodyToGeodetic(s.shape, local);
      const ground = s.globe.heightAt(lon, lat);
      lines.push(`Altitude ${formatDistance(h - ground)} above the ground`);
      lines.push(`${Math.abs(lat / DEG).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon / DEG).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`);
      if (sunVisible < 0.999) lines.push(sunVisible < 1e-6 ? 'Total solar eclipse' : `Sun ${(100 * (1 - sunVisible)).toFixed(1)}% covered`);
    } else if (smallFocus) {
      lines.push(focus.kind === 'comet' ? 'Comet' : focus.kind);
      lines.push(`Camera ${formatDistance(rig.distance)} away`);
    } else {
      lines.push(`Camera altitude ${formatDistance(rig.distance - focus.radius)}`);
    }
    if (focus.id !== 10) {
      lines.push(`${(fromSun / AU).toFixed(4)} AU from the Sun`);
      lines.push(`Sunlight takes ${formatLightTime(fromSun)} to arrive`);
    }
    if (rig.focus !== 10 && rig.focus < ASTEROID_ID && !system.available(rig.focus)) lines.push('Loading orbit…');
    nameEl.textContent = focus.name;
    detailEl.textContent = lines.join('\n');
    utcEl.textContent = formatUtc(clock.utc);
    if (document.activeElement !== dateInput && frameNumber % 15 === 0) dateInput.value = new Date(clock.utc).toISOString().slice(0, 16);
    const pending = [...surfaces.values()].reduce((n, x) => n + x.globe.pending, 0) + loading;
    document.body.dataset.ready = 'true';
    document.body.dataset.tiles = pending === 0 ? 'idle' : 'loading';
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
