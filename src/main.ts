import * as THREE from 'three';
import { Ephemeris } from './core/ephemeris';
import { BODIES, bodyById } from './core/bodies';
import { Clock } from './core/time';
import { length, sub } from './core/frames';
import type { Vec3 } from './core/ephemeris';
import { SolarSystem } from './render/world';
import { CameraRig } from './render/camera';
import { createStarField } from './render/stars';
import { formatDistance, formatUtc } from './ui/format';

const AU = 149597870.7;
const BASE = import.meta.env.BASE_URL;

async function main() {
  const [ephemeris, starData] = await Promise.all([
    Ephemeris.load(`${BASE}data/de440.bin`),
    fetch(`${BASE}data/stars.bin`).then((r) => r.arrayBuffer()),
  ]);

  // URL parameters make any view reproducible: ?focus=Saturn&t=2026-10-05T00:00Z&dist=400000&yaw=0.5&pitch=0.2
  const params = new URLSearchParams(location.search);
  const startTime = params.has('t') ? Date.parse(params.get('t')!) : Date.now();
  const clock = new Clock(startTime, ephemeris.start, ephemeris.end);
  if (params.has('rate')) clock.rate = Number(params.get('rate'));
  const focusName = (params.get('focus') ?? 'Earth').toLowerCase();
  const focusBody = BODIES.find((b) => b.name.toLowerCase() === focusName) ?? bodyById(399);

  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: params.has('capture') });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 1e-3, 1e13);
  const stars = createStarField(starData);
  (stars.material as THREE.ShaderMaterial).uniforms.pixelRatio.value = renderer.getPixelRatio();
  scene.add(stars);
  scene.add(new THREE.AmbientLight(0xffffff, 0.015)); // a hint of fill so night sides are not pure black
  const system = new SolarSystem(ephemeris);
  scene.add(system.group);

  system.update(clock.tdb);
  /** A view angle on the sunlit side of a body: 35 degrees off the Sun direction, slightly above. */
  const sunlitView = (id: number): [number, number] => {
    if (id === 10) return [0.3, 0.9];
    const d = sub(system.position(10), system.position(id), [0, 0, 0]);
    return [Math.atan2(d[0], d[2]) + 0.6, 0.2];
  };
  const rig = new CameraRig(focusBody.id, Number(params.get('dist') ?? focusBody.radius[0] * 4));
  [rig.yaw, rig.pitch] = sunlitView(focusBody.id);
  if (params.has('yaw')) rig.yaw = Number(params.get('yaw'));
  if (params.has('pitch')) rig.pitch = Number(params.get('pitch'));

  // ---- labels and body list -------------------------------------------------
  const labelLayer = document.getElementById('labels')!;
  const list = document.getElementById('bodies')!;
  const labels = new Map<number, HTMLElement>();
  const buttons = new Map<number, HTMLButtonElement>();
  const flyTo = (id: number) => rig.flyTo(id, bodyById(id).radius[0] * (id === 6 ? 7 : 4), performance.now() / 1000, ...sunlitView(id));
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

  // ---- input ----------------------------------------------------------------
  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointermove', (e) => { if (dragging) rig.orbit(e.movementX, e.movementY); });
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

  // ---- frame loop -----------------------------------------------------------
  const nameEl = document.getElementById('focus-name')!;
  const detailEl = document.getElementById('focus-detail')!;
  const utcEl = document.getElementById('utc')!;
  const projected = new THREE.Vector3();
  const rel: Vec3 = [0, 0, 0];
  let last = performance.now() / 1000;

  const frame = () => {
    const now = performance.now() / 1000;
    clock.tick(Math.min(0.25, now - last));
    last = now;
    syncRate();

    system.update(clock.tdb);
    const focus = bodyById(rig.focus);
    rig.minDistance = focus.radius[0] * 1.0002;
    const { eye, target } = rig.solve((id) => system.position(id), now);

    // Floating origin: the camera sits at the three.js origin; the world moves around it.
    system.placeRelativeTo(eye);
    sub(target, eye, rel);
    camera.position.set(0, 0, 0);
    camera.up.set(0, 1, 0);
    camera.lookAt(rel[0], rel[1], rel[2]);
    camera.near = Math.max(1e-3, (rig.distance - focus.radius[0]) * 0.5);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);

    // Labels: projected from camera-relative float64 positions; the Moon's label hides
    // when it would sit on top of Earth's.
    const screen = new Map<number, [number, number]>();
    for (const body of BODIES) {
      const label = labels.get(body.id)!;
      sub(system.position(body.id), eye, rel);
      projected.set(rel[0], rel[1], rel[2]).project(camera);
      const visible = projected.z < 1 && Math.abs(projected.x) < 1.05 && Math.abs(projected.y) < 1.05;
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

    const altitude = rig.distance - focus.radius[0];
    const fromSun = length(sub(system.position(rig.focus), system.position(10), rel));
    nameEl.textContent = focus.name;
    detailEl.textContent = [
      `Camera altitude ${formatDistance(altitude)}`,
      focus.id === 10 ? '' : `${(fromSun / AU).toFixed(4)} AU from the Sun`,
      focus.id === 10 ? '' : `Sunlight takes ${formatLightTime(fromSun)} to arrive`,
    ].filter(Boolean).join('\n');
    utcEl.textContent = formatUtc(clock.utc);
    document.body.dataset.ready = 'true';
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
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
