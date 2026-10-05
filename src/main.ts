import * as THREE from 'three';
import { Ephemeris } from './core/ephemeris';
import { Orientation } from './core/orientation';
import { BODIES, bodyById } from './core/bodies';
import { Clock, utcToTdb } from './core/time';
import { parseSatellites, type SatelliteSnapshot } from './core/satellites';
import { length, sub } from './core/frames';
import type { Vec3 } from './core/ephemeris';
import { bodyToGeodetic, enu, geodeticToBody, MOON_SPHERE, WGS84, type Shape } from './core/geodesy';
import { TileStore, type Manifest } from './core/tilestore';
import { SolarSystem } from './render/world';
import { CameraRig, SCENE_BASIS, type Anchor, type Frame } from './render/camera';
import { Globe, type GlobeFrame } from './render/globe';
import { EarthSky } from './render/sky';
import { createStarField } from './render/stars';
import { NAMED_SATELLITES, SatelliteLayer } from './render/satellites';
import { formatDistance, formatUtc } from './ui/format';
import manifest from './generated/tiles.json';
import cloudsMeta from './generated/clouds.json';

const AU = 149597870.7;
const DEG = Math.PI / 180;
const BASE = import.meta.env.BASE_URL;

interface Surface {
  globe: Globe;
  shape: Shape;
  /** Body-fixed to scene rotation for the current frame. */
  bodyToScene: Float64Array;
  sky?: EarthSky;
}

async function main() {
  const [ephemeris, orientation, starData, cloudTexture, satelliteSnapshot] = await Promise.all([
    Ephemeris.load(`${BASE}data/de440.bin`),
    Orientation.load(`${BASE}data/orientation.bin`),
    fetch(`${BASE}data/stars.bin`).then((r) => r.arrayBuffer()),
    new THREE.TextureLoader().loadAsync(`${BASE}data/clouds.png`).catch(() => undefined),
    fetch(`${BASE}data/satellites.json`).then((r) => r.json() as Promise<SatelliteSnapshot>).catch(() => undefined),
  ]);

  // URL parameters make any view reproducible:
  //   ?focus=Earth&lat=36.06&lon=-112.14&dist=3&heading=20&tilt=12&t=2026-10-05T16:00Z
  //   ?focus=Saturn&t=2017-06-15T00:00Z&dist=420000&yaw=0.9&pitch=0.45&rate=86400
  const params = new URLSearchParams(location.search);
  const startTime = params.has('t') ? Date.parse(params.get('t')!) : Date.now();
  const clock = new Clock(startTime, Math.max(ephemeris.start, orientation.start), Math.min(ephemeris.end, orientation.end));
  if (params.has('rate')) clock.rate = Number(params.get('rate'));
  const focusName = (params.get('focus') ?? 'Earth').toLowerCase();
  const focusBody = BODIES.find((b) => b.name.toLowerCase() === focusName) ?? bodyById(399);

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
  scene.add(new THREE.AmbientLight(0xffffff, 0.015)); // a hint of fill so night sides are not pure black
  const system = new SolarSystem(ephemeris);
  scene.add(system.group);

  // ---- Earth and Moon surfaces --------------------------------------------------
  const store = new TileStore(manifest as unknown as Manifest, `${BASE}data/tiles/`);
  const surfaces = new Map<number, Surface>();
  for (const [id, shape, atmosphere] of [[399, WGS84, true], [301, MOON_SPHERE, false]] as const) {
    if (!store.hasBody(id) || !orientation.has(id)) continue;
    const globe = new Globe(id, shape, store, atmosphere);
    const surface: Surface = { globe, shape, bodyToScene: new Float64Array(9) };
    if (atmosphere) {
      surface.sky = new EarthSky(globe, cloudTexture);
      scene.add(surface.sky.group);
    }
    scene.add(globe.group);
    system.views.get(id)!.object.visible = false; // the plain sphere gives way to terrain
    surfaces.set(id, surface);
  }

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
    const centre = system.position(id);
    const s = surfaces.get(id);
    if (!s || !anchor) return { origin: [...centre] as Vec3, ...SCENE_BASIS };
    const target = s.globe.heightAt(anchor.lon, anchor.lat);
    const prev = anchorHeights.get(id) ?? target;
    const h = prev + (target - prev) * 0.15;
    anchorHeights.set(id, h);
    const local = enu(anchor.lon, anchor.lat);
    const origin = sceneVector(s, geodeticToBody(s.shape, anchor.lon, anchor.lat, h));
    for (let k = 0; k < 3; k++) origin[k] += centre[k];
    return { origin, east: sceneVector(s, local.east), north: sceneVector(s, local.north), up: sceneVector(s, local.up) };
  };

  system.update(clock.tdb);
  updateOrientation();

  /** A look point on the sunlit side: the subsolar point, moved 35 degrees west. */
  const sunlitAnchor = (id: number): Anchor => {
    const s = surfaces.get(id)!;
    const toSun = sub(system.position(10), system.position(id));
    const d = bodyVector(s, toSun);
    return { lon: Math.atan2(d[1], d[0]) - 35 * DEG, lat: Math.max(-1.2, Math.min(1.2, Math.asin(d[2] / length(d)))) };
  };
  /** For bodies without terrain: an orbit angle 35 degrees off the Sun direction, slightly above. */
  const sunlitView = (id: number): [number, number] => {
    if (id === 10) return [-0.3, 0.9];
    const d = sub(system.position(10), system.position(id), [0, 0, 0]);
    return [-(Math.atan2(d[0], d[2]) + 0.6), 0.2];
  };
  const viewFor = (id: number) => {
    const body = bodyById(id);
    if (surfaces.has(id)) return { distance: body.radius[0] * 3, yaw: 0, pitch: 1.25, anchor: sunlitAnchor(id) };
    const [yaw, pitch] = sunlitView(id);
    return { distance: body.radius[0] * (id === 6 ? 7 : 4), yaw, pitch, anchor: undefined };
  };

  const initial = viewFor(focusBody.id);
  let anchor = initial.anchor;
  if (surfaces.has(focusBody.id) && params.has('lat') && params.has('lon')) {
    anchor = { lat: Number(params.get('lat')) * DEG, lon: Number(params.get('lon')) * DEG };
  }
  const rig = new CameraRig(focusBody.id, Number(params.get('dist') ?? initial.distance), anchor);
  rig.yaw = initial.yaw;
  rig.pitch = initial.pitch;
  if (params.has('yaw')) rig.yaw = Number(params.get('yaw'));
  if (params.has('pitch')) rig.pitch = Number(params.get('pitch'));
  if (params.has('heading')) rig.yaw = Number(params.get('heading')) * DEG;
  if (params.has('tilt')) rig.pitch = Number(params.get('tilt')) * DEG;

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

  // ---- labels and body list -------------------------------------------------
  const labelLayer = document.getElementById('labels')!;
  const list = document.getElementById('bodies')!;
  const labels = new Map<number, HTMLElement>();
  const buttons = new Map<number, HTMLButtonElement>();
  const flyTo = (id: number) => {
    const v = viewFor(id);
    rig.flyTo(id, v.distance, performance.now() / 1000, v.yaw, v.pitch, v.anchor);
  };
  for (const body of BODIES) {
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = body.name;
    label.addEventListener('click', () => flyTo(body.id));
    labelLayer.append(label);
    labels.set(body.id, label);
    const button = document.createElement('button');
    button.textContent = body.name;
    button.addEventListener('click', () => flyTo(body.id));
    list.append(button);
    buttons.set(body.id, button);
  }

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
    if (rig.anchor && drag.button === 0 && !drag.shift) rig.pan(e.movementX, e.movementY, pixelsPerRadian(), bodyById(rig.focus).radius[0]);
    else rig.orbit(e.movementX, e.movementY);
  });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); rig.zoom(e.deltaY); }, { passive: false });

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

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  function updateCredits() {
    document.getElementById('credit')!.textContent = [
      'Positions: JPL DE440',
      'Earth: NASA Blue Marble, Black Marble, NOAA ETOPO 2022; Grand Canyon: Copernicus Sentinel-2 and DEM GLO-30',
      `Clouds: NOAA GMGSI ${cloudsMeta.time.replace('T', ' ')}`,
      'Moon: LRO LROC and LOLA',
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
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();

  const frame = () => {
    const now = performance.now() / 1000;
    clock.tick(Math.min(0.25, now - last));
    last = now;
    frameNumber++;
    syncRate();

    system.update(clock.tdb);
    updateOrientation();
    const focus = bodyById(rig.focus);
    rig.minDistance = rig.anchor ? 0.0015 : focus.radius[0] * 1.0002;
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

    // Floating origin: the camera sits at the three.js origin; the world moves around it.
    system.placeRelativeTo(eye);
    sub(target, eye, rel);
    camera.position.set(0, 0, 0);
    camera.up.set(up[0], up[1], up[2]);
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
      sub(system.position(10), centre, sunScene);
      const sunBody = bodyVector(s, sunScene);
      const len = length(sunBody);
      const f: GlobeFrame = { eyeBody, centerRel, bodyToScene: s.bodyToScene, sunBody: [sunBody[0] / len, sunBody[1] / len, sunBody[2] / len], pixelsPerRadian: ppr, frame: frameNumber, frustum };
      s.globe.update(f);
      s.sky?.update(f);
      if (s.sky) {
        // In the daytime sky the eye adapts to the bright sky and the stars disappear.
        const altitude = bodyToGeodetic(s.shape, eyeBody)[2];
        const sunUp = (eyeBody[0] * f.sunBody[0] + eyeBody[1] * f.sunBody[1] + eyeBody[2] * f.sunBody[2]) / length(eyeBody);
        daylight = Math.max(daylight, smoothstep(-0.2, 0.05, sunUp) * (1 - smoothstep(20, 80, altitude)));
      }
    }
    (stars.material as THREE.ShaderMaterial).uniforms.brightness.value = 1 - 0.98 * daylight;

    // Satellites: shown near Earth only (further out they crowd onto its disc).
    const earthRel = sub(system.position(399), eye, [0, 0, 0]);
    satellites.group.visible = length(earthRel) < 150000;
    if (satellites.group.visible) {
      const sunDir = sub(system.position(10), system.position(399), [0, 0, 0]);
      const d = length(sunDir);
      satellites.update(clock.utc, earthRel, [sunDir[0] / d, sunDir[1] / d, sunDir[2] / d]);
    }

    renderer.render(scene, camera);

    const earthRelLabel = sub(system.position(399), eye, [0, 0, 0]);
    // Labels: projected from camera-relative float64 positions; the Moon's label hides
    // when it would sit on top of Earth's, and a body's own label hides near its surface.
    const screen = new Map<number, [number, number]>();
    for (const body of BODIES) {
      const label = labels.get(body.id)!;
      sub(system.position(body.id), eye, rel);
      projected.set(rel[0], rel[1], rel[2]).project(camera);
      const near = length(rel) < body.radius[0] * 2.5;
      const visible = !near && projected.z < 1 && Math.abs(projected.x) < 1.05 && Math.abs(projected.y) < 1.05;
      const x = (projected.x * 0.5 + 0.5) * innerWidth;
      const y = (-projected.y * 0.5 + 0.5) * innerHeight;
      let show = visible;
      const parent = body.orbit && body.orbit.around !== 10 ? screen.get(body.orbit.around) : undefined;
      if (show && parent && Math.hypot(parent[0] - x, parent[1] - y) < 24) show = false;
      label.style.display = show ? '' : 'none';
      if (show) {
        label.style.left = `${x}px`;
        label.style.top = `${y}px`;
        screen.set(body.id, [x, y]);
      }
      label.classList.toggle('focus', body.id === rig.focus);
      buttons.get(body.id)!.classList.toggle('focus', body.id === rig.focus);
    }

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

    const fromSun = length(sub(system.position(rig.focus), system.position(10), rel));
    const lines: string[] = [];
    const s = surfaces.get(rig.focus);
    if (s) {
      const local = bodyVector(s, sub(eye, system.position(rig.focus), rel));
      const [lon, lat, h] = bodyToGeodetic(s.shape, local);
      const ground = s.globe.heightAt(lon, lat);
      lines.push(`Altitude ${formatDistance(h - ground)} above the ground`);
      lines.push(`${Math.abs(lat / DEG).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon / DEG).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`);
    } else {
      lines.push(`Camera altitude ${formatDistance(rig.distance - focus.radius[0])}`);
    }
    if (focus.id !== 10) {
      lines.push(`${(fromSun / AU).toFixed(4)} AU from the Sun`);
      lines.push(`Sunlight takes ${formatLightTime(fromSun)} to arrive`);
    }
    nameEl.textContent = focus.name;
    detailEl.textContent = lines.join('\n');
    utcEl.textContent = formatUtc(clock.utc);
    const pending = [...surfaces.values()].reduce((n, x) => n + x.globe.pending, 0);
    document.body.dataset.ready = 'true';
    document.body.dataset.tiles = pending === 0 ? 'idle' : 'loading';
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

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
