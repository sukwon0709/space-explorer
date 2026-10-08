import * as THREE from 'three';
import type { Vec3 } from './core/ephemeris';
import { icrfToScene, sceneToIcrf } from './core/frames';
import { skyBasis } from './core/blackholes';
import { PC_KM } from './core/stars';
import { MPC_KM } from './core/galaxies';
import {
  BETELGEUSE_SN, DAY, LSUN_ERG, LightCurve, SN1987A, decimalYear, ejectaRadius, flashLight, hotSpotLight, hotSpots, ringDelays,
  type SupernovaSpec,
} from './core/supernova';
import { BARNARD_68, StarBirth, type PmsTrack, type Protostar } from './core/starbirth';
import { Binary, C_SI, GW150914, R_SUN_KM, chirpMass } from './core/merger';
import { horizon } from './core/kerr';
import { SupernovaView } from './render/supernova';
import { CloudView, vShare } from './render/starbirth';
import { BinaryLens, WaveSheet } from './render/merger';
import { ExtraStars } from './render/extrastars';
import { StarGlobe } from './render/starglobe';
import { SUN_SURFACE_BRIGHTNESS } from './render/sun';
import type { Frame } from './render/camera';
import { formatDistance, formatYears } from './ui/format';

export const COSMIC_ID = 82_000_000;
export type CosmicKey = 'sn1987a' | 'betelgeuse' | 'b68' | 'gw150914';
export const COSMIC_KEYS: CosmicKey[] = ['sn1987a', 'betelgeuse', 'b68', 'gw150914'];

/** public/data/cosmic/*.json (pipeline/fetch_cosmic.py). */
export interface GwData {
  t0: number;
  dt: number;
  observedH: number[];
  observedL: number[];
  nrH: number[];
  nrT0: number;
  unfilteredT0: number;
  unfilteredDt: number;
  unfilteredH: number[];
  sky: { ra: number; dec: number };
  params: Record<string, [number, number | null, number | null]>;
}
export interface CosmicData {
  sn1987a?: { points: Array<[number, number, string]> };
  gw?: GwData;
  pms?: { tracks: Record<string, PmsTrack> };
}

/** Seconds after 09:50:45 UTC of the peak at Hanford (figure 2 of the detection paper). */
export const GW_PEAK = 0.4231;
const RSUN_KM = 695700;
const C_KMS = C_SI / 1000;
const LY_PER_PC = 3.261563777;
/** Comoving distance of z = 0.09 (Planck 2018 cosmology): 404 Mpc. */
const GW_COMOVING_MPC = 404;

/** The young star's track: Baraffe et al.'s for 0.7 and 0.8 solar masses, interpolated to the mass the collapse ends with. */
function blendTracks(tracks: Record<string, PmsTrack>, mass: number): PmsTrack {
  const a = tracks['0.700'], b = tracks['0.800'];
  if (!a || !b) return a ?? b ?? [[5, 4000, 0, 2], [10, 4500, -0.8, 0.66]];
  const f = Math.min(1, Math.max(0, (mass - 0.7) / 0.1));
  return a.map((row) => {
    // Same ages are not guaranteed: interpolate b at a's age.
    const t = row[0];
    let j = 1;
    while (j < b.length - 1 && b[j][0] < t) j++;
    const g = Math.min(1, Math.max(0, (t - b[j - 1][0]) / (b[j][0] - b[j - 1][0] || 1)));
    const other = b[j - 1].map((v, c) => v * (1 - g) + b[j][c] * g);
    return [t, row[1] * (1 - f) + other[1] * f, row[2] * (1 - f) + other[2] * f, row[3] * (1 - f) + other[3] * f] as [number, number, number, number];
  });
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
}

function along(dir: Vec3, km: number): Vec3 {
  return [dir[0] * km, dir[1] * km, dir[2] * km];
}

interface SnState {
  spec: SupernovaSpec;
  curve: LightCurve;
  view: SupernovaView;
  pos: Vec3;
  /** Collapse as Earth saw it (UTC ms); for Betelgeuse, set when it is made to explode. */
  collapse?: number;
  /** The rings' echo delays seen from Earth (days), and the hot spots. */
  earthDelays?: [number, number];
  spots?: ReturnType<typeof hotSpots>;
}

export interface FrameInput {
  eye: Vec3;
  focus: number;
  /** Camera minus the focus event's centre, precise (scene km), when the focus is an event. */
  rel?: Vec3;
  utc: number;
  tdb: number;
  /** Wall-clock seconds since the last frame. */
  dt: number;
  ppr: number;
  pixelRatio: number;
  /** The diffuse layers' display level of the Sun's surface (main.ts surfaceLight). */
  surfaceLight: number;
}

/**
 * The live cosmic events: SN 1987A as it happened (and Betelgeuse if it went off now),
 * a star being born from Barnard 68, and GW150914's black holes merging. Search
 * targets, camera frames, their clocks, what each draws and the HUD's lines.
 */
export class CosmicEvents {
  readonly group = new THREE.Group();
  readonly targets: Array<{ id: number; name: string; kind: string; radius: number; aliases: string[]; key: CosmicKey }> = [];
  readonly sn: Record<'sn1987a' | 'betelgeuse', SnState>;
  readonly birth?: StarBirth;
  readonly cloud?: CloudView;
  readonly binary: Binary;
  readonly lens = new BinaryLens();
  readonly sheet = new WaveSheet();
  /** Point stars: the two supernovae far off; the young star; the merger's neighbourhood. */
  readonly snStars: ExtraStars;
  readonly birthStar: ExtraStars;
  readonly hostStars: ExtraStars;
  private readonly globe = new StarGlobe();
  private readonly teffCode: (t: number) => number;
  private readonly starUniforms: Record<string, THREE.IUniform>;
  private readonly betelgeuse: () => Vec3 | undefined;
  private readonly pos: Record<'b68' | 'gw150914', Vec3>;
  /** Star-birth clock: years since the collapse began. Merger clock: seconds from the peak (source frame). */
  birthYears = 0;
  mergerTime = -0.6;
  /** The event clocks run (B68, the merger); pacing slows or speeds them with what is happening. */
  playing = true;
  paced = true;
  /** Merger: the orbital frame (scene axes) and the matrix to the remnant's frame (rows). */
  private readonly orbit: { x: Vec3; y: Vec3; z: Vec3 };
  private readonly sceneToBH = new THREE.Matrix3();
  /** Host stars: offsets from the binary (pc, ICRS). */
  private readonly hostOffsets: Float64Array;
  private readonly hostRel: Float64Array;
  private readonly hostDim: Float64Array;
  private readonly exposureLog = new Map<number, number>();
  private lastProtostar?: Protostar;
  private peakAmp = 1;

  constructor(starMaterial: THREE.ShaderMaterial, teffCode: (t: number) => number, data: CosmicData, betelgeuse: () => Vec3 | undefined) {
    this.teffCode = teffCode;
    this.starUniforms = starMaterial.uniforms;
    this.betelgeuse = betelgeuse;
    const snState = (spec: SupernovaSpec): SnState => {
      const curve = new LightCurve(spec.light);
      const view = new SupernovaView(spec, curve);
      this.group.add(view.group);
      const n = skyBasis(spec.ra, spec.dec).n;
      const g = view.geometry;
      return {
        spec, curve, view, pos: icrfToScene(along(n, spec.distancePc * PC_KM)), collapse: spec.collapse,
        earthDelays: g && ringDelays(g, [-n[0], -n[1], -n[2]]), spots: g && hotSpots(g, spec),
      };
    };
    this.sn = { sn1987a: snState(SN1987A), betelgeuse: snState(BETELGEUSE_SN) };

    // Barnard 68, its spin axis 60 degrees from our line of sight (unknown: chosen).
    const b68 = skyBasis(BARNARD_68.ra, BARNARD_68.dec);
    const b68Pos = icrfToScene(along(b68.n, BARNARD_68.distancePc * PC_KM));
    if (data.pms) {
      const probe = new StarBirth(BARNARD_68, data.pms.tracks['0.700'] ?? []);
      const mass = probe.state(5e6).star;
      this.birth = new StarBirth(BARNARD_68, blendTracks(data.pms.tracks, mass));
      const zAxis = normalize([0, 1, 2].map((k) => -0.5 * b68.n[k] + 0.866 * b68.north[k]) as Vec3);
      const yAxis = b68.east;
      const xAxis = cross(yAxis, zAxis);
      this.cloud = new CloudView(this.birth, { x: icrfToScene(xAxis), y: icrfToScene(yAxis), z: icrfToScene(zAxis) });
      this.group.add(this.cloud.group);
    }
    this.group.add(this.globe.group);

    // GW150914, at the most probable point of LIGO's sky map. The orbit's axis points
    // 150 degrees from us (the inclination LIGO measured, theta_JN about 2.7 rad); its
    // position angle on the sky is not known (north chosen).
    this.binary = new Binary(GW150914);
    const gw = data.gw;
    if (gw) this.binary.useNumericalRelativity(gw.unfilteredH, gw.unfilteredT0 - GW_PEAK, gw.unfilteredDt);
    let peak = 0;
    for (let t = -0.05; t < 0.02; t += 0.0002) peak = Math.max(peak, this.binary.amplitudeAt(t));
    this.peakAmp = peak || 1;
    const sky = skyBasis(gw?.sky.ra ?? 113.6968, gw?.sky.dec ?? -72.7573);
    const gwPos = icrfToScene(along(sky.n, GW_COMOVING_MPC * MPC_KM));
    const inc = (150 * Math.PI) / 180;
    const z = normalize([0, 1, 2].map((k) => Math.cos(inc) * -sky.n[k] + Math.sin(inc) * sky.north[k]) as Vec3);
    const x = normalize(cross(sky.east, z));
    const y = cross(z, x);
    this.orbit = { x: icrfToScene(x), y: icrfToScene(y), z: icrfToScene(z) };
    const o = this.orbit;
    this.sceneToBH.set(o.x[0], o.x[1], o.x[2], o.y[0], o.y[1], o.y[2], o.z[0], o.z[1], o.z[2]);
    this.sheet.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...o.x), new THREE.Vector3(...o.y), new THREE.Vector3(...o.z)));
    this.group.add(this.sheet.mesh);
    this.pos = { b68: b68Pos, gw150914: gwPos };

    // Point stars.
    this.snStars = new ExtraStars(starMaterial, [
      { absMag: 30, teffCode: teffCode(16000) },
      { absMag: 30, teffCode: teffCode(6000) },
    ]);
    this.birthStar = new ExtraStars(starMaterial, [{ absMag: 30, teffCode: teffCode(4000) }]);
    // Drawn after the cloud has dimmed what is behind it: the star is inside, not behind.
    this.birthStar.points.renderOrder = 12;
    // The merger's neighbourhood: its host galaxy is not known. Stars brighter than the
    // Sun within 100 pc, as many as around the Sun (about 0.005 per cubic parsec), with
    // a luminosity function like the solar neighbourhood's bright end; a computed sky.
    const hostCount = 20000;
    const hostStars: Array<{ absMag: number; teffCode: number }> = [];
    this.hostOffsets = new Float64Array(hostCount * 3);
    let seed = 4242;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < hostCount; k++) {
      const r = 100 * Math.cbrt(rand()) + 0.3;
      const zz = 2 * rand() - 1, ph = 2 * Math.PI * rand(), s = Math.sqrt(1 - zz * zz);
      this.hostOffsets.set([r * s * Math.cos(ph), r * s * Math.sin(ph), r * zz], k * 3);
      // dN/dM_V rising as 10^(0.3 M_V) up to M_V = 4.
      const M = 4 + Math.log10(rand() * (1 - 10 ** -3) + 10 ** -3) / 0.3;
      const giant = M < 1.5 && rand() < 0.35;
      const teff = giant ? 3600 + 1200 * rand() : M > 3.5 ? 6000 : M > 2 ? 7200 : M > 0.5 ? 9500 : M > -1.5 ? 14000 : 22000;
      hostStars.push({ absMag: M, teffCode: teffCode(teff) });
    }
    this.hostStars = new ExtraStars(starMaterial, hostStars);
    this.hostRel = new Float64Array(hostCount * 3);
    this.hostDim = new Float64Array(hostCount);
    this.group.add(this.snStars.points, this.birthStar.points, this.hostStars.points);

    const add = (key: CosmicKey, name: string, kind: string, radius: number, aliases: string[]) => {
      this.targets.push({ id: COSMIC_ID + COSMIC_KEYS.indexOf(key), name, kind, radius, aliases, key });
    };
    add('sn1987a', SN1987A.name, 'supernova', this.sn.sn1987a.view.geometry!.radius, SN1987A.aliases);
    add('betelgeuse', BETELGEUSE_SN.name, 'supernova (computed)', 764 * RSUN_KM, BETELGEUSE_SN.aliases);
    if (this.birth) add('b68', 'Barnard 68: a star is born', 'dark cloud', this.birth.radius / 1e5, BARNARD_68.aliases);
    add('gw150914', 'GW150914', 'black hole merger', 2 * this.massKm, ['gw150914', 'gw 150914', 'black hole merger', 'first gravitational waves', 'binary black hole']);
  }

  /** G M / c^2 of the binary (km, source frame). */
  get massKm(): number {
    return this.binary.mass * R_SUN_KM;
  }

  has(id: number): boolean {
    return this.targets.some((t) => t.id === id);
  }

  keyOf(id: number): CosmicKey | undefined {
    return this.targets.find((t) => t.id === id)?.key;
  }

  idOf(key: CosmicKey): number {
    return COSMIC_ID + COSMIC_KEYS.indexOf(key);
  }

  /** The merger's camera is placed from the binary itself (it is 404 Mpc out; its holes ~100 km across). */
  precise(id: number): boolean {
    return this.keyOf(id) === 'gw150914';
  }

  position(id: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const key = this.keyOf(id)!;
    const p = key === 'sn1987a' ? this.sn.sn1987a.pos : key === 'betelgeuse' ? this.betelgeuse() ?? this.sn.betelgeuse.pos : this.pos[key];
    out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
    return out;
  }

  /** Earth's side is up for the supernovae and the cloud (looking straight down is the view from Earth, north up); the orbit's axis for the merger. */
  frame(id: number, origin: Vec3): Frame {
    const key = this.keyOf(id)!;
    if (key === 'gw150914') {
      const { x, y, z } = this.orbit;
      return { origin, east: y, north: x, up: z };
    }
    const spec = key === 'b68' ? BARNARD_68 : this.sn[key].spec;
    const sky = skyBasis(spec.ra, spec.dec);
    const up = icrfToScene([-sky.n[0], -sky.n[1], -sky.n[2]]);
    const north = icrfToScene(sky.north);
    return { origin, east: cross(north, up), north, up };
  }

  viewFor(id: number): { distance: number; yaw: number; pitch: number } {
    const key = this.keyOf(id)!;
    if (key === 'sn1987a') return { distance: 3.2 * this.sn.sn1987a.view.geometry!.radius, yaw: 0.5, pitch: 1.15 };
    if (key === 'betelgeuse') return { distance: 1e11, yaw: 0.3, pitch: 1.3 };
    if (key === 'b68') return { distance: 2.6 * (this.birth!.radius / 1e5), yaw: 0.2, pitch: 1.35 };
    return { distance: 45 * this.massKm, yaw: 0.6, pitch: 0.42 };
  }

  minDistance(id: number, utc: number): number {
    const key = this.keyOf(id)!;
    if (key === 'gw150914') return 8 * this.massKm;
    if (key === 'b68') return 3e6;
    const s = this.sn[key];
    const day = s.collapse === undefined ? -1 : (utc - s.collapse) / (DAY * 1000);
    return Math.max(1e5, s.view.photosphere(day).radius * 1.05);
  }

  /** Days since the explosion's light reached the camera (Earth's date of the same moment). */
  day(key: 'sn1987a' | 'betelgeuse', utc: number): number | undefined {
    const c = this.sn[key].collapse;
    return c === undefined ? undefined : (utc - c) / (DAY * 1000);
  }

  /** Make Betelgeuse explode: the light of the collapse reaches Earth `leadHours` from now. */
  detonate(utc: number, leadHours = 2): void {
    this.sn.betelgeuse.collapse = utc + leadHours * 3600e3;
  }

  /** Clock rate for a supernova at `day` (simulated s per s): about a quarter of its age per second. */
  static pace(day: number): number {
    return Math.min(1e8, Math.max(300, 0.25 * Math.max(Math.abs(day), 0.02) * DAY));
  }

  /** Advance the event clocks (B68 in years, the merger in source seconds). */
  tick(dt: number, focusKey: CosmicKey | undefined): void {
    if (!this.playing) return;
    if (focusKey === 'b68') {
      // About 4 seconds per factor of e in age, once past the first thousands of years.
      this.birthYears = Math.min(1e8, this.birthYears + dt * (this.paced ? 0.25 * (this.birthYears + 2000) : 2e4));
      if (this.birthYears >= 1e8) this.playing = false;
    } else if (focusKey === 'gw150914') {
      // About half a wave cycle a second while they orbit; the ringing in slow motion.
      const f = this.binary.frequency(this.mergerTime).source;
      const rate = this.paced ? (this.mergerTime < 0 ? Math.min(0.05, 0.5 / Math.max(f, 1)) : 0.004) : 0.01;
      this.mergerTime = Math.min(0.3, this.mergerTime + dt * rate);
      if (this.mergerTime >= 0.3) this.playing = false;
    }
  }

  /** Everything placed and lit for this frame. */
  update(f: FrameInput): void {
    const diffuse = f.surfaceLight / (7 * SUN_SURFACE_BRIGHTNESS);
    this.globe.hide();
    this.updateSupernova('sn1987a', f, diffuse);
    this.updateSupernova('betelgeuse', f, diffuse);
    this.snStars.update(this.snRel, this.snDim);
    this.updateBirth(f, diffuse);
    this.updateMerger(f);
  }

  /** Smoothed exposure per event: the eye adapting. */
  private adapt(id: number, target: number, dt: number): number {
    const prev = this.exposureLog.get(id);
    const k = prev === undefined ? 1 : 1 - Math.exp(-dt * 2.5);
    const v = prev === undefined ? Math.log(target) : prev + (Math.log(target) - prev) * k;
    this.exposureLog.set(id, v);
    return Math.exp(v);
  }

  private relTo(id: number, f: FrameInput): Vec3 {
    if (f.rel && f.focus === id) return [-f.rel[0], -f.rel[1], -f.rel[2]];
    const p = this.position(id);
    return [p[0] - f.eye[0], p[1] - f.eye[1], p[2] - f.eye[2]];
  }

  /** The flash-lit glow of the rings (V, Suns), seen from Earth's direction. */
  private ringGlow(s: SnState, day: number): number {
    if (!s.earthDelays || day <= 0) return 0;
    const [near, far] = s.earthDelays;
    return 0.5 * (flashLight(day - near) + flashLight(day - far)) * SupernovaView.FLASH_LUM * 1.45;
  }

  /** The ring's light seen from Earth's direction (V, Suns) at `day` (for the far point). */
  private ringLight(s: SnState, day: number): number {
    if (!s.earthDelays || !s.spots || day <= 0) return 0;
    // The inner ring and the outer two (a quarter and a fifth as bright).
    const glow = this.ringGlow(s, day);
    const year = decimalYear(s.collapse! + day * DAY * 1000);
    let sum = 0, weight = 0;
    for (const sp of s.spots) {
      sum += sp.strength * hotSpotLight(year - sp.on, year);
      weight += sp.strength;
    }
    return glow + (SupernovaView.SPOT_LUM * sum) / weight;
  }

  private updateSupernova(key: 'sn1987a' | 'betelgeuse', f: FrameInput, diffuse: number): void {
    const s = this.sn[key];
    const id = this.idOf(key);
    const k = key === 'sn1987a' ? 0 : 1;
    const rel = this.relTo(id, f);
    const d = Math.hypot(...rel);
    const relPc = sceneToIcrf(rel, [0, 0, 0]);
    for (let c = 0; c < 3; c++) this.snRel[k * 3 + c] = relPc[c] / PC_KM;
    const day = this.day(key, f.utc);
    if (key === 'betelgeuse') {
      // Before it goes off, the catalogue's Betelgeuse is the star; after, this is.
      const exploded = day !== undefined && day >= 0;
      const hide = this.starUniforms.uHideAt.value as THREE.Vector4;
      if (exploded) {
        const p = sceneToIcrf(this.position(id), [0, 0, 0]);
        hide.set(p[0] / PC_KM, p[1] / PC_KM, p[2] / PC_KM, 0.02);
      } else hide.set(0, 0, 0, 0);
      if (!exploded) {
        this.snDim[k] = Infinity;
        s.view.hide();
        return;
      }
    }
    if (day === undefined) return;
    const ph = s.view.photosphere(day);
    const globePx = (ph.radius / d) * f.ppr;
    const extentPx = (s.view.extent(day) / d) * f.ppr;
    const showGlobe = globePx > 1.5;
    const showGlow = extentPx > 2 && day > 0;
    if (showGlobe || showGlow) {
      // The eye (or camera) adapts to the brightest thing that fills a fair part of the
      // view: the photosphere's disc, the ejecta or the rings. Smaller ones are left
      // over-exposed, as the supernova is in the photographs of its rings.
      const H = typeof innerHeight === 'number' ? innerHeight : 800;
      const fill = (radiusKm: number) => smoothstep(0.03, 0.12, ((radiusKm / d) * f.ppr) / H);
      let brightest = 0;
      if (showGlobe) brightest = ph.surface * fill(ph.radius);
      if (showGlow) {
        const rEj = ejectaRadius(s.spec, day, s.view.geometry?.radius);
        const ej = s.view.ejectaLight(day) / (rEj / RSUN_KM) ** 2;
        // Most of the light comes from the dense core, about a quarter of the radius across.
        brightest = Math.max(brightest, 4 * ej * fill(rEj));
        if (s.view.geometry) {
          const R = s.view.geometry.radius;
          // The flash-lit ring spreads over about 0.3 R^2; the hot spots crowd into 0.005 R^2.
          const glow = this.ringGlow(s, day), spots = this.ringLight(s, day) - glow;
          brightest = Math.max(brightest, Math.max(glow / 0.3, spots / 0.005) / (R / RSUN_KM) ** 2 * fill(R));
        }
      }
      const target = brightest > 0 ? Math.min(diffuse, 0.8 / (7 * SUN_SURFACE_BRIGHTNESS * brightest)) : diffuse;
      const exposure = f.focus === id ? this.adapt(id, target, f.dt) : target;
      s.view.update(rel, day, exposure, f.ppr, f.pixelRatio, f.tdb, showGlobe);
    } else s.view.hide();
    // The far point carries what is not drawn resolved.
    let lum = showGlobe ? 0 : ph.lumV;
    if (!showGlow && day > 0) lum += s.view.ejectaLight(day) + this.ringLight(s, day);
    const teff = !showGlobe && ph.lumV > 0.3 * lum ? ph.teff : 3800;
    this.snStars.setStar(k, lum > 0 ? 4.83 - 2.5 * Math.log10(lum) : 30, this.teffCode(teff));
    this.snDim[k] = lum > 0 ? s.spec.av * smoothstep(50 * PC_KM, 2000 * PC_KM, d) : Infinity;
  }
  private readonly snRel = new Float64Array(6);
  private readonly snDim = new Float64Array(2);
  private readonly birthRel = new Float64Array(3);
  private readonly birthDim = new Float64Array(1);

  private updateBirth(f: FrameInput, diffuse: number): void {
    if (!this.cloud) return;
    const id = this.idOf('b68');
    const rel = this.relTo(id, f);
    const d = Math.hypot(...rel);
    if (d > 3000 * PC_KM) {
      this.cloud.hide();
      this.birthDim[0] = Infinity;
      this.birthStar.update(this.birthRel, this.birthDim);
      return;
    }
    const s = this.cloud.model.update(this.birthYears);
    this.lastProtostar = s;
    let exposure = diffuse;
    const resolved = s.star > 0 && (s.radius / 1e5 / d) * f.ppr > 1.5;
    const lumV = s.star > 0 ? s.luminosity * vShare(s.teff) : 0;
    if (resolved) {
      const surface = lumV / (s.radius / 1e5 / RSUN_KM) ** 2;
      exposure = Math.min(diffuse, 0.6 / (7 * SUN_SURFACE_BRIGHTNESS * surface));
      const look = { teff: s.teff, radius: s.radius / 1e5, surface, gravity: 0.03, seed: 68 };
      this.globe.update(rel, look, f.focus === id ? this.adapt(id, exposure, f.dt) : exposure, f.tdb, new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]));
    }
    this.cloud.update(rel, this.birthYears, exposure, f.ppr, f.pixelRatio);
    const relPc = sceneToIcrf(rel, [0, 0, 0]);
    for (let c = 0; c < 3; c++) this.birthRel[c] = relPc[c] / PC_KM;
    this.birthStar.setStar(0, lumV > 0 ? 4.83 - 2.5 * Math.log10(lumV) : 30, this.teffCode(Math.max(s.teff, 2000)));
    this.birthDim[0] = lumV > 0 && !resolved ? Math.min(60, this.cloud.extinctionToStar(rel)) : Infinity;
    this.birthStar.update(this.birthRel, this.birthDim);
  }

  /** The protostar's state as last drawn. */
  get protostar(): Protostar | undefined {
    return this.lastProtostar;
  }

  /** The holes now: positions (scene axes, M from the centre of mass) and masses (M). */
  holes(): { merged: boolean; holes: Array<[Vec3, number]>; separation: number } {
    const p = this.binary.positions(this.mergerTime);
    const { x, y } = this.orbit;
    const toScene = (q: [number, number]): Vec3 => [0, 1, 2].map((c) => q[0] * x[c] + q[1] * y[c]) as Vec3;
    const M = this.binary.mass;
    return { merged: p.merged, separation: p.separation, holes: [[toScene(p.r1), GW150914.m1 / M], [toScene(p.r2), GW150914.m2 / M]] };
  }

  private updateMerger(f: FrameInput): void {
    const id = this.idOf('gw150914');
    const rel = this.relTo(id, f);
    const d = Math.hypot(...rel);
    const mk = this.massKm;
    // Its neighbourhood's stars, while within a few kpc.
    if (d < 5000 * PC_KM) {
      const relPc = sceneToIcrf(rel, [0, 0, 0]);
      for (let k = 0; k < this.hostDim.length; k++) {
        for (let c = 0; c < 3; c++) this.hostRel[k * 3 + c] = this.hostOffsets[k * 3 + c] + relPc[c] / PC_KM;
        this.hostDim[k] = 0;
      }
    } else this.hostDim.fill(Infinity);
    this.hostStars.update(this.hostRel, this.hostDim);
    // The wave sheet, out to 400 M, while near.
    const span = 400;
    this.sheet.mesh.visible = d < 3000 * mk;
    if (!this.sheet.mesh.visible) return;
    this.sheet.mesh.position.set(rel[0], rel[1], rel[2]);
    const u = this.sheet.uniforms;
    u.uSpan.value = span;
    u.uScale.value = mk;
    u.uLift.value = 14;
    const n = this.sheet.samples;
    const amp = new Float32Array(n), phase = new Float32Array(n);
    const z1 = 1 + GW150914.z;
    const now = this.binary.phaseAt(this.mergerTime * z1);
    const ref = 2 * Math.PI * Math.floor(now / (2 * Math.PI));
    const start = -2.2;
    for (let k = 0; k < n; k++) {
      const r = (k / (n - 1)) * span;
      const tr = this.mergerTime - (r * mk) / C_KMS;
      if (tr < start) { amp[k] = 0; phase[k] = 0; continue; }
      // The source's phase and amplitude at that retarded time (LIGO's clock runs (1 + z) slower).
      amp[k] = Math.min(1.2, this.binary.amplitudeAt(tr * z1) / this.peakAmp);
      phase[k] = this.binary.phaseAt(tr * z1) - ref;
    }
    this.sheet.setWave(amp, phase);
  }

  /** Is the camera near enough to the merger for its lensing to show? */
  lensing(focus: number, rel: Vec3 | undefined, ppr: number): boolean {
    if (!rel || this.keyOf(focus) !== 'gw150914') return false;
    const r = Math.hypot(...rel);
    return Math.sqrt((4 * this.massKm) / r) * ppr > 2;
  }

  /** The lensed frame: the scene into the view and sky textures, then each ray bent by the holes. */
  draw(
    renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, eye: Vec3, rel: Vec3, frame: number,
    prepare: (camera: THREE.PerspectiveCamera, size: number) => void, restore: () => void,
  ): void {
    const view = this.lens.kerr;
    if (view.skyStale(eye, 1e13, frame) || (this.sheet.mesh.visible && frame % 3 === 0)) {
      view.renderSky(renderer, scene, eye, frame, prepare);
      restore();
    }
    view.renderView(renderer, scene, camera);
    const h = this.holes();
    const mk = this.massKm;
    if (!h.merged) {
      this.lens.render(renderer, camera, [rel[0] / mk, rel[1] / mk, rel[2] / mk], h.holes);
      return;
    }
    const rg = this.binary.finalMass * R_SUN_KM;
    const camBH = new THREE.Vector3(rel[0] / rg, rel[1] / rg, rel[2] / rg).applyMatrix3(this.sceneToBH);
    view.render(renderer, camera, [camBH.x, camBH.y, camBH.z], this.sceneToBH, {
      spin: this.binary.finalSpin, flow: 0, discOuter: 0, tStar: 0, discExposure: 0, flowExposure: 0, background: 1,
      companion: [0, 0, 0, 0], companionTeff: 5800, companionExposure: 0,
    });
  }

  /** HUD lines. */
  describe(id: number, rel: Vec3, utc: number): string[] {
    const key = this.keyOf(id)!;
    const d = Math.hypot(...rel);
    if (key === 'gw150914') return this.describeMerger(rel);
    if (key === 'b68') return this.describeBirth(rel);
    const s = this.sn[key];
    const lines: string[] = [s.spec.summary];
    const day = this.day(key, utc);
    const ly = (s.spec.distancePc * LY_PER_PC).toLocaleString('en-US', { maximumFractionDigits: 0 });
    lines.push(`${ly} light years from the Sun`);
    if (day === undefined) {
      lines.push('Betelgeuse as it is: a red supergiant 764 times the Sun\'s radius. Start it from Events, Cosmic events.');
      return lines;
    }
    if (day < 0) {
      const hours = -day * 24;
      lines.push(`${s.spec.progenitor.name}, the star before: ${hours < 48 ? `${hours.toFixed(1)} hours` : `${(-day).toFixed(0)} days`} until the light of its collapse gets here`);
      return lines;
    }
    lines.push(`Day ${day < 10 ? day.toFixed(2) : day < 1000 ? day.toFixed(1) : Math.round(day).toLocaleString('en-US')} since its first light reached here${day > 730 ? ` (${(day / 365.25).toFixed(1)} years)` : ''}`);
    const L = s.curve.luminosity(day);
    lines.push(`Luminosity ${(L / LSUN_ERG).toExponential(2)} Suns (${L.toExponential(2)} erg/s, all wavelengths)`);
    const ph = s.curve.photosphere(day);
    if (ph.opaque > 0.05) {
      lines.push(`Photosphere radius ${formatDistance(ph.radius)}, ${Math.round(ph.teff).toLocaleString('en-US')} K, expanding at ${Math.round((ph.radius / (day * DAY)) || 0).toLocaleString('en-US')} km/s`);
    } else {
      lines.push('Nebular: the ejecta are see-through; they glow from radioactive decay (cobalt-56, then cobalt-57, titanium-44)');
    }
    const vMag = s.curve.absV(day) + 5 * Math.log10(s.spec.distancePc / 10) + s.spec.av;
    lines.push(`Brightness from Earth: magnitude ${vMag.toFixed(1)}; from here ${(s.curve.absV(day) + 5 * Math.log10(Math.max(d / PC_KM, 1e-9) / 10)).toFixed(1)}`);
    if (s.view.geometry) {
      const g = s.view.geometry;
      const dir = normalize(sceneToIcrf([-rel[0], -rel[1], -rel[2]], [0, 0, 0]));
      const [near, far] = ringDelays(g, dir);
      lines.push(`Inner ring ${(2 * g.radius / 9.4607e12).toFixed(2)} light years across, lit by the flash. Seen from here its near side lights up on day ${near.toFixed(0)}, its far side on day ${far.toFixed(0)}`);
      const year = decimalYear(s.collapse! + day * DAY * 1000);
      if (year > 1995) lines.push('Hot spots: the blast wave hitting the ring (first seen in 1995, all round it by 2004, fading since 2009)');
      lines.push('Light curve: radioactive heating diffusing out (Arnett), fitted to the measured bolometric light (Suntzeff 1991): 0.069 Suns of nickel-56');
    } else {
      lines.push(`Computed, not observed: a type II-P plateau for its size (Popov 1993), ${BETELGEUSE_SN.light.ni56} Suns of nickel-56`);
    }
    lines.push(`Camera ${formatDistance(d)} from the explosion`);
    return lines;
  }

  private describeBirth(rel: Vec3): string[] {
    const s = this.lastProtostar ?? this.birth!.state(this.birthYears);
    const b = this.birth!;
    const lines: string[] = [];
    const stage: Record<string, string> = {
      core: 'Barnard 68 now: a cold ball of gas and dust on the edge of collapse (a Bonnor-Ebert sphere, Alves et al. 2001)',
      '0': 'Class 0 protostar: deep inside its collapsing envelope, seen only in infrared and radio',
      I: 'Class I protostar: the outflow is clearing the envelope; a disc feeds the star',
      II: 'Classical T Tauri star: the envelope is gone; the star still feeds from its disc',
      III: 'Weak-lined T Tauri star: the disc has cleared; the star still contracts',
      MS: 'A main-sequence star: hydrogen burning in its core',
    };
    lines.push(stage[s.stage] ?? '');
    lines.push(`${this.birthYears <= 0 ? 'Collapse about to begin' : `${formatYears(this.birthYears)} since the collapse began`}`);
    lines.push(`Cloud: ${(b.mass / 1.98847e33).toFixed(2)} Suns of gas within ${Math.round(b.radius / 1.495978707e13).toLocaleString('en-US')} AU, at ${BARNARD_68.temperature} K, ${BARNARD_68.distancePc} pc away`);
    if (s.star > 0) {
      lines.push(`Star ${s.star.toFixed(3)} Suns, ${(s.radius / 6.957e10).toFixed(2)} × the Sun's radius, ${Math.round(s.teff).toLocaleString('en-US')} K, ${s.luminosity.toPrecision(3)} × the Sun's light`);
      if (s.accretion > 1e-9) lines.push(`Gaining ${s.accretion.toExponential(1)} Suns a year; envelope ${s.envelope.toFixed(2)} Suns still around it`);
      if (s.disc > 1e-5) lines.push(`Disc ${s.disc.toFixed(3)} Suns, ${Math.round(s.discRadius / 1.495978707e13)} AU across radius`);
      const av = this.cloud ? this.cloud.extinctionToStar(rel) : 0;
      lines.push(`Dust between here and the star: A_V = ${av < 100 ? av.toFixed(1) : '>100'} magnitudes${av > 30 ? ' (hidden in visible light)' : ''}`);
      lines.push('Track: Baraffe et al. 2015 models; collapse inside out (Shu 1977), a third of the gas into the star');
    } else {
      lines.push(`Peak dimming of starlight behind its centre: A_V = ${b.peakExtinction().toFixed(0)} magnitudes`);
    }
    lines.push(`Camera ${formatDistance(Math.hypot(...rel))} from the centre`);
    return lines;
  }

  private describeMerger(rel: Vec3): string[] {
    const b = this.binary;
    const t = this.mergerTime;
    const z1 = 1 + GW150914.z;
    const lines: string[] = ['Two black holes spiralling together, as LIGO heard on 14 Sep 2015: the first gravitational waves detected'];
    lines.push(`${GW150914.m1} and ${GW150914.m2} Suns (chirp mass ${chirpMass(GW150914.m1, GW150914.m2).toFixed(1)}), ${(GW150914.distanceMpc * LY_PER_PC / 1000).toFixed(2)} billion light years away`);
    const h = this.holes();
    const fr = b.frequency(t);
    if (!h.merged) {
      lines.push(`${(-t * 1000).toFixed(t > -0.1 ? 1 : 0)} ms to the merger (in their own time; LIGO's clock: ${(-t * z1 * 1000).toFixed(0)} ms)`);
      const sep = h.separation * this.massKm;
      lines.push(`Separation ${formatDistance(sep)}; orbiting ${(fr.source / 2).toFixed(1)} times a second at ${((Math.PI * sep * fr.source) / C_KMS).toFixed(2)}c`);
      lines.push(`Waves at ${fr.source.toFixed(0)} Hz (LIGO heard ${fr.detector.toFixed(0)} Hz)`);
    } else {
      const rd = b.ringdown();
      lines.push(`Merged ${(t * 1000).toFixed(1)} ms ago: one black hole of ${b.finalMass.toFixed(1)} Suns spinning at ${b.finalSpin.toFixed(2)} (LIGO: 63.1, 0.69)`);
      lines.push(`Ringing down at ${(rd.frequency * z1).toFixed(0)} Hz (LIGO heard ${rd.frequency.toFixed(0)} Hz), damping in ${(rd.tau / z1 * 1000).toFixed(1)} ms; ${(b.mass - b.finalMass).toFixed(1)} Suns of mass went out as waves`);
    }
    const L = b.luminosity(t);
    lines.push(`Power in gravitational waves ${L.toExponential(1)} erg/s${L > 1e55 ? ' (more than all the stars in the visible universe)' : ''}`);
    const r = Math.hypot(...rel);
    const strain = (4 * b.wave.eta * this.massKm * b.amplitudeAt(t * z1)) / r;
    lines.push(`Strain here ${strain.toExponential(1)}: you are stretched and squeezed by that fraction (LIGO measured 1.0e-21)`);
    if (!h.merged) lines.push('Light bent by both holes (each a Schwarzschild hole, their pulls added)');
    else lines.push(`Event horizon ${formatDistance(horizon(b.finalSpin) * b.finalMass * R_SUN_KM)} in radius; Kerr ray tracing`);
    lines.push('Blue sheet: the wave pattern in the orbital plane (height exaggerated); stars nearby are a computed neighbourhood');
    lines.push(`Camera ${formatDistance(r)} (${(r / this.massKm).toFixed(0)} GM/c²) from the centre`);
    return lines;
  }
}
