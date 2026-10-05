import * as THREE from 'three';
import type { Vec3 } from './core/ephemeris';
import { icrfToScene, sceneToIcrf } from './core/frames';
import {
  BLACK_HOLES, type BlackHole, blackHolePc, companionOffsetKm, companionRadiusKm, discTemperatureScale, gravRadius, julianDate,
  orbitOffset, skyBasis, viewInclination,
} from './core/blackholes';
import { holeBasis, modelImage, shadowDiameter, toHole } from './core/ehtimage';
import { cartesianToBL, discFlux, efficiency, horizon, isco } from './core/kerr';
import { PC_KM } from './core/stars';
import { BlackHoleView, type BlackHoleParams } from './render/blackhole';
import { ExtraStars } from './render/extrastars';
import type { Frame } from './render/camera';
import { formatDistance, formatLightYearCount } from './ui/format';

export const BH_ID = 81_000_000;
const AU_KM = 149597870.7;
const LY_PER_PC = 3.261563777;

/** An S-star orbit as published: a in arcseconds, tp in years, period in years. */
export interface SStar {
  name: string;
  a: number;
  e: number;
  i: number;
  Omega: number;
  omega: number;
  tp: number;
  period: number | null;
  K: number;
  type: string;
  source: string;
}

/** Extinction toward the Galactic Centre from the Sun, A_V (A_Ks = 2.42, Fritz et al. 2011, with A_K / A_V = 0.09). */
const GC_EXTINCTION = 27;
/** Distance modulus and K-band extinction used to turn the S-stars' K magnitudes into absolute magnitudes. */
const SGR_DM = 5 * Math.log10(8277 / 10);
const SGR_AK = 2.42;

interface Hole {
  bh: BlackHole;
  rg: number;
  basis: { x: Vec3; y: Vec3; z: Vec3 };
  sceneToBH: THREE.Matrix3;
  /** Scene position, km. */
  pos: Vec3;
  /** Peak 230 GHz intensity seen from Earth, for the radio view's exposure. */
  flowPeak?: number;
}

/**
 * The black holes: search targets, camera frames, descriptions, the stars that orbit
 * them, and the ray-traced view when the camera is close enough for lensing to show.
 */
export class BlackHoles {
  readonly view = new BlackHoleView();
  readonly stars: ExtraStars;
  readonly targets: Array<{ id: number; name: string; kind: string; radius: number; aliases: string[] }> = [];
  /** Radio (230 GHz) view of Sgr A* and M87*; off shows visible light (nothing but the shadow). */
  radio = true;
  private readonly holes: Hole[];
  private readonly sstars: SStar[];
  private readonly rel: Float64Array;
  private readonly dim: Float64Array;
  /** Scene positions (km) of the extra stars this frame. */
  private readonly starPos: Vec3[];
  /** Distance from the camera to the nearest extra star (km). */
  private nearest = Infinity;
  private companionAsSphere = false;

  constructor(starMaterial: THREE.ShaderMaterial, teff: [number, number], sstars: SStar[]) {
    this.sstars = sstars;
    this.holes = BLACK_HOLES.map((bh) => {
      const basis = holeBasis(bh);
      const xs = icrfToScene(basis.x), ys = icrfToScene(basis.y), zs = icrfToScene(basis.z);
      const m = new THREE.Matrix3().set(xs[0], xs[1], xs[2], ys[0], ys[1], ys[2], zs[0], zs[1], zs[2]);
      const pc = blackHolePc(bh);
      const pos = icrfToScene([pc[0] * PC_KM, pc[1] * PC_KM, pc[2] * PC_KM]);
      return { bh, rg: gravRadius(bh), basis, sceneToBH: m, pos };
    });
    this.holes.forEach((h, k) => {
      this.targets.push({ id: BH_ID + k, name: h.bh.name, kind: 'black hole', radius: 5 * h.rg, aliases: h.bh.aliases });
    });
    // Extra stars: the S-stars, then each companion.
    const code = (t: number) => Math.max(0, Math.min(255, Math.round((255 * Math.log(t / teff[0])) / Math.log(teff[1]))));
    const list = sstars.map((s) => {
      const early = s.type !== 'l';
      // V - K for B dwarfs (about -0.8) and for K/M giants (about +3.8); Pecaut and Mamajek 2013.
      return { absMag: s.K - SGR_DM - SGR_AK + (early ? -0.8 : 3.8), teffCode: code(early ? 25000 : 3800) };
    });
    for (const h of this.holes) if (h.bh.companion) list.push({ absMag: h.bh.companion.absMag, teffCode: code(h.bh.companion.teff) });
    this.stars = new ExtraStars(starMaterial, list);
    this.rel = new Float64Array(list.length * 3);
    this.dim = new Float64Array(list.length);
    this.starPos = list.map(() => [0, 0, 0] as Vec3);
  }

  has(id: number): boolean {
    return id >= BH_ID && id < BH_ID + this.holes.length;
  }

  hole(id: number): BlackHole {
    return this.holes[id - BH_ID].bh;
  }

  position(id: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const p = this.holes[id - BH_ID].pos;
    out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
    return out;
  }

  /**
   * The EHT targets: up is toward Earth and north is the sky's north, so looking straight
   * down (pitch pi/2) shows the hole as the EHT sees it, north up and east left. Others:
   * orbit about the spin axis.
   */
  frame(id: number, origin: Vec3): Frame {
    const h = this.holes[id - BH_ID];
    if (h.bh.eht) {
      const sky = skyBasis(h.bh.ra, h.bh.dec);
      const up = icrfToScene([-sky.n[0], -sky.n[1], -sky.n[2]]);
      const north = icrfToScene(sky.north);
      const east: Vec3 = [north[1] * up[2] - north[2] * up[1], north[2] * up[0] - north[0] * up[2], north[0] * up[1] - north[1] * up[0]];
      return { origin, east, north, up };
    }
    const up = icrfToScene(h.basis.z);
    const north = icrfToScene(h.basis.x); // in the plane of the spin and the line of sight, away from us
    const east: Vec3 = [north[1] * up[2] - north[2] * up[1], north[2] * up[0] - north[0] * up[2], north[0] * up[1] - north[1] * up[0]];
    return { origin, east, north, up };
  }

  /** Default view: from Earth's side for the EHT targets, from above the disc otherwise. */
  viewFor(id: number): { distance: number; yaw: number; pitch: number } {
    const h = this.holes[id - BH_ID];
    if (h.bh.eht) return { distance: 30 * h.rg, yaw: 0, pitch: Math.PI / 2 };
    if (h.bh.flow === 'thin') return { distance: 45 * h.rg, yaw: 0.4, pitch: 0.16 };
    return { distance: 18 * h.rg, yaw: 0.6, pitch: 0.25 };
  }

  minDistance(id: number): number {
    return 2.6 * this.holes[id - BH_ID].rg;
  }

  /** Time in Julian days (TDB) and the camera; places the extra stars and returns how near catalogue stars may be drawn (pc). */
  update(eye: Vec3, focus: number, camRel: Vec3 | undefined, tdb: number): number {
    const jd = julianDate(tdb);
    const sgr = this.holes[0];
    const tmp: Vec3 = [0, 0, 0];
    let k = 0;
    const fromSgr = camRel && focus === BH_ID ? Math.hypot(...camRel) : Math.hypot(eye[0] - sgr.pos[0], eye[1] - sgr.pos[1], eye[2] - sgr.pos[2]);
    const av = GC_EXTINCTION * smoothstep(50 * PC_KM, 2000 * PC_KM, fromSgr);
    const place = (centre: Hole, offsetIcrfKm: Vec3) => {
      const off = icrfToScene(offsetIcrfKm, tmp);
      const p = this.starPos[k];
      for (let c = 0; c < 3; c++) p[c] = centre.pos[c] + off[c];
      // Camera-relative, from the offset when the camera is placed relative to this hole.
      const r: Vec3 = camRel && focus === BH_ID + this.holes.indexOf(centre)
        ? [off[0] - camRel[0], off[1] - camRel[1], off[2] - camRel[2]]
        : [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
      const icrf = sceneToIcrf(r, [0, 0, 0]);
      for (let c = 0; c < 3; c++) this.rel[k * 3 + c] = icrf[c] / PC_KM;
      return Math.hypot(r[0], r[1], r[2]);
    };
    let nearest = Infinity;
    for (const s of this.sstars) {
      const o = orbitOffset({ a: s.a * 8277, e: s.e, i: s.i, Omega: s.Omega, omega: s.omega, tp: 2451545 + (s.tp - 2000) * 365.25, period: (s.period ?? 1e4) * 365.25 }, sgr.bh.ra, sgr.bh.dec, jd);
      for (let c = 0; c < 3; c++) o[c] *= AU_KM;
      nearest = Math.min(nearest, place(sgr, o));
      this.dim[k] = av;
      k++;
    }
    let hide = 0;
    for (const h of this.holes) {
      if (!h.bh.companion) continue;
      const d = place(h, companionOffsetKm(h.bh, jd));
      nearest = Math.min(nearest, d);
      const focused = focus === BH_ID + this.holes.indexOf(h);
      this.dim[k] = focused && this.companionAsSphere ? Infinity : 0;
      // Up close, the catalogue's own entry for the companion (if any) gives way to this one.
      if (focused && d < 1e4 * AU_KM) hide = Math.max(hide, (d * 1.5 + 50 * AU_KM) / PC_KM);
      k++;
    }
    this.nearest = nearest;
    this.stars.update(this.rel, this.dim);
    return hide;
  }

  /** Is the camera close enough to `focus` that lensing shows (Einstein radius over two pixels)? */
  active(focus: number, distanceKm: number, pixelsPerRadian: number): boolean {
    if (!this.has(focus)) return false;
    const rg = this.holes[focus - BH_ID].rg;
    return Math.sqrt((4 * rg) / distanceKm) * pixelsPerRadian > 2;
  }

  /** The ray-traced frame. `prepare` readies camera-dependent layers for a cube face. */
  draw(
    renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, focus: number, eye: Vec3, camRel: Vec3,
    tdb: number, frame: number, pixelsPerRadian: number, prepare: (camera: THREE.PerspectiveCamera, size: number) => void, restore: () => void,
  ): void {
    const h = this.holes[focus - BH_ID];
    const bh = h.bh;
    const rel = [camRel[0] / h.rg, camRel[1] / h.rg, camRel[2] / h.rg];
    const camBH = new THREE.Vector3(rel[0], rel[1], rel[2]).applyMatrix3(h.sceneToBH);
    const cam: Vec3 = [camBH.x, camBH.y, camBH.z];
    if (this.view.skyStale(eye, Math.min(this.nearest, 1e30), frame)) {
      this.view.renderSky(renderer, scene, eye, frame, prepare);
      restore();
    }
    this.view.renderView(renderer, scene, camera);

    const p: BlackHoleParams = {
      spin: bh.spin, flow: 0, discOuter: bh.discOuter ?? 0, tStar: 0, discExposure: 0, flowExposure: 0, background: 1,
      companion: [0, 0, 0, 0], companionTeff: 5800, companionExposure: 0,
    };
    const distM = Math.hypot(...camRel) / h.rg;
    // The eye adapts to what fills the view: the disc's light at about a thirtieth of
    // the camera's distance (its hot centre over-exposed from afar), or the companion.
    let tRef = Infinity;
    if (bh.flow === 'thin') {
      p.flow = 1;
      p.tStar = discTemperatureScale(bh, efficiency(bh.spin));
      tRef = this.discTemperature(h, p.tStar, distM / 30);
    } else if (bh.flow === 'hot' && this.radio) {
      p.flow = 2;
      h.flowPeak ??= peakFlow(bh);
      p.flowExposure = 0.9 / h.flowPeak;
      // The sky is dark at 230 GHz; starlight is shown again once the ring is small.
      const ringPx = (10 / distM) * pixelsPerRadian;
      p.background = 1 - smoothstep(10, 80, ringPx);
    }
    this.companionAsSphere = false;
    if (bh.companion) {
      const off = companionOffsetKm(bh, julianDate(tdb));
      const inHole = toHole(h.basis, off);
      const radius = companionRadiusKm(bh.companion);
      const sceneOff = icrfToScene(off);
      const dist = Math.hypot(sceneOff[0] - camRel[0], sceneOff[1] - camRel[1], sceneOff[2] - camRel[2]);
      // Drawn as a sphere (lensed exactly) once its disc spans a couple of pixels.
      if ((radius / dist) * pixelsPerRadian > 1.5) {
        this.companionAsSphere = true;
        p.companion = [inHole[0] / h.rg, inHole[1] / h.rg, inHole[2] / h.rg, radius / h.rg];
        p.companionTeff = bh.companion.teff;
        if (p.flow !== 1) tRef = bh.companion.teff;
      }
    }
    if (Number.isFinite(tRef)) p.discExposure = p.companionExposure = 0.4 / radianceV(tRef);
    this.view.render(renderer, camera, cam, h.sceneToBH, p);
  }

  /** The disc's temperature at radius `r` (M); within the inner 60 M, its peak temperature. */
  private discTemperature(h: Hole, tStar: number, r: number): number {
    let f = 0;
    if (r > 60) f = discFlux(h.bh.spin, r);
    else for (let x = isco(h.bh.spin) * 1.001; x < 60; x *= 1.02) f = Math.max(f, discFlux(h.bh.spin, x));
    return tStar * f ** 0.25;
  }

  /** Points worth labelling: [key, name, scene position]. */
  labels(focus: number): Array<[number, string, Vec3]> {
    const out: Array<[number, string, Vec3]> = [];
    if (focus === BH_ID) this.sstars.forEach((s, k) => { if (s.name === 'S2' || s.K < 14.3) out.push([k, s.name, this.starPos[k]]); });
    let k = this.sstars.length;
    for (const h of this.holes) {
      if (!h.bh.companion) continue;
      if (focus === BH_ID + this.holes.indexOf(h)) out.push([k, h.bh.companion.name, this.starPos[k]]);
      k++;
    }
    return out;
  }

  /** HUD lines. */
  describe(id: number, camRel: Vec3, tdb: number): string[] {
    const h = this.holes[id - BH_ID];
    const bh = h.bh;
    const lines: string[] = [bh.summary];
    lines.push(`${formatLightYearCount(bh.dist * LY_PER_PC)} from the Sun`);
    const mass = bh.mass >= 1e9 ? `${(bh.mass / 1e9).toFixed(2)} billion` : bh.mass >= 1e6 ? `${(bh.mass / 1e6).toFixed(2)} million` : bh.mass.toFixed(1);
    lines.push(`${mass} times the Sun's mass (${bh.massSource})`);
    lines.push(`Spin ${bh.spin}: ${bh.spinSource}`);
    lines.push(`Event horizon ${formatDistance(horizon(bh.spin) * h.rg)} in radius`);
    const shadow = shadowDiameter(bh, viewInclination(bh));
    lines.push(`Shadow ${shadow >= 1 ? shadow.toFixed(1) : shadow.toPrecision(2)} µas across from Earth${bh.eht ? `; ring measured by the EHT ${bh.eht.ring} ± ${bh.eht.error} µas` : ''}`);
    // The camera: distance in gravitational radii and how fast its clocks run.
    const camBH = new THREE.Vector3(camRel[0] / h.rg, camRel[1] / h.rg, camRel[2] / h.rg).applyMatrix3(h.sceneToBH);
    const [r, th] = cartesianToBL(bh.spin, [camBH.x, camBH.y, camBH.z]);
    const a = bh.spin, s2 = Math.sin(th) ** 2, sigma = r * r + a * a * Math.cos(th) ** 2, delta = r * r - 2 * r + a * a;
    const A = (r * r + a * a) ** 2 - a * a * delta * s2;
    const rate = Math.sqrt((sigma * delta) / A);
    lines.push(`Camera ${r < 100 ? r.toFixed(1) : Math.round(r).toLocaleString('en-US')} GM/c² (${formatDistance(Math.hypot(...camRel))}) from the centre`);
    if (rate < 0.999) lines.push(`Clocks here run at ${(rate * 100).toFixed(1)}% of the rate far away`);
    if (bh.flow === 'hot') {
      lines.push(this.radio
        ? 'Light: 230 GHz radio, false colour, from a modelled hot flow (GRMHD-fitted profile)'
        : 'Visible light: its faint hot flow does not show; only the shadow against the stars');
    } else if (bh.flow === 'thin') {
      lines.push(`Visible light: thin disc at ${(bh.eddington! * 100).toFixed(0)}% of the Eddington limit (Novikov-Thorne model)`);
    } else {
      lines.push('Dormant: no light of its own, only bent starlight');
    }
    lines.push(`Orientation: ${bh.axisSource}`);
    if (bh.companion) {
      const d = Math.hypot(...companionOffsetKm(bh, julianDate(tdb)));
      lines.push(`${bh.companion.name}: ${bh.companion.source}; ${(d / AU_KM).toFixed(d < 10 * AU_KM ? 3 : 2)} AU away now`);
    }
    if (id === BH_ID) lines.push(`${this.sstars.length} S-stars on measured orbits (Gillessen et al. 2017; S2: GRAVITY 2020)`);
    return lines;
  }

  /** The EHT targets: their names and model/observed image info. */
  ehtTarget(id: number): BlackHole | undefined {
    return this.has(id) ? this.holes[id - BH_ID].bh.eht && this.holes[id - BH_ID].bh : undefined;
  }

  sky(id: number): ReturnType<typeof skyBasis> {
    const bh = this.hole(id);
    return skyBasis(bh.ra, bh.dec);
  }
}

/** Relative V-band blackbody radiance (matches the shader's radianceV). */
export function radianceV(t: number): number {
  return 1 / (Math.exp(Math.min(25924 / Math.max(t, 1), 80)) - 1);
}

/** Peak 230 GHz intensity of a hole's modelled flow, from a coarse image seen from Earth. */
function peakFlow(bh: BlackHole): number {
  const field = (bh.eht?.ring ?? 50) * 2;
  const img = modelImage(bh, 24, field, 0.08);
  return img.reduce((m, v) => Math.max(m, v), 1e-30);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
