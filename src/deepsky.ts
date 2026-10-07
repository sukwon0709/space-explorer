import type { Vec3 } from './core/ephemeris';
import { icrfToScene } from './core/frames';
import {
  Cosmology, FLAG_GLOBULAR, FLAG_SPHEROID, MPC_KM, decodeGalaxies, discAxes, galaxyAbsMag, galaxyRadiusKpc, galaxyPosition,
  type GalaxyBlock, type GalaxyIndex,
} from './core/galaxies';
import { R0, galactocentricToIcrsPc, totalLuminosity, ICRS_TO_GAL } from './core/milkyway';
import { modelAxes, type GalaxyModelSpec, type ModelAxes } from './core/galaxymodel';
import { GalaxyLayer } from './render/galaxies';
import { GalaxyModelLayer } from './render/galaxymodels';
import { ImageLayer, type SkyImage } from './render/images';
import type { Frame } from './render/camera';
import { formatLightYearCount, formatYears } from './ui/format';

export const GALAXY_ID = 60_000_000;
export const CLUSTER_ID = 70_000_000;
export const NEBULA_ID = 78_000_000;
export const MILKY_WAY_ID = 80_000_000;
export const SGR_A_ID = 80_000_001;
export const LOCAL_GROUP_ID = 80_000_002;
const FLAG_MILKY_WAY = 128;
const LY_PER_MPC = 3.261563777e6;
/**
 * The Local Group's centre of mass, as a fraction of the way from the Milky Way to
 * Andromeda: M31 taken as about 1.2 times the Milky Way's mass (estimates range from
 * equal to twice; e.g. Peñarrubia et al. 2014, Patel et al. 2017).
 */
const LOCAL_GROUP_FRACTION = 0.55;
/**
 * Magnitudes added to a nebula's picture. The photographic plates saturate over a bright
 * nebula's core, so scaling the picture to the nebula's total light spreads that light
 * too evenly and leaves the core several times too faint; this restores it roughly.
 */
const NEBULA_CORE_GAIN = 2;

export interface DeepTarget {
  id: number;
  name: string;
  kind: string;
  /** Radius used for viewing distances, km. */
  radius: number;
  aliases: string[];
}

/** Sgr A*: VLBA position (Reid and Brunthaler 2004), distance from GRAVITY (2022). */
const SGR_A = { ra: 266.41683708, dec: -29.00781056, pc: R0 * 1000 };

/**
 * Everything beyond the stars: the Milky Way as a whole, the galaxy catalogue and its
 * clusters, as search targets with positions, camera frames, labels and descriptions.
 */
export class DeepSky {
  readonly layer: GalaxyLayer;
  readonly images: ImageLayer;
  readonly models: GalaxyModelLayer;
  /** 3D models by catalogue index: centre (Mpc, at the nucleus) and axes. */
  private readonly modelOf = new Map<number, { spec: GalaxyModelSpec; centre: Vec3; axes: ModelAxes }>();
  private readonly nebulae: SkyImage[] = [];
  private readonly modelled = new Set<number>();
  private extinction = 1;
  private andromeda = -1;
  readonly targets: DeepTarget[] = [];
  readonly cosmology: Cosmology;
  private local?: GalaxyBlock;
  private deepRequested = false;
  private readonly milkyWay = totalLuminosity();
  /** Galactic north pole and centre direction, scene axes. */
  private readonly galacticPole: Vec3;
  private readonly galacticCentreDir: Vec3;

  constructor(
    readonly index: GalaxyIndex | undefined,
    localBuffer: ArrayBuffer | undefined,
    imageList: SkyImage[],
    pixelRatio: number,
    anisotropy: number,
    private readonly deepUrl: string,
    imageUrl: string,
    modelList: GalaxyModelSpec[] = [],
    modelUrl = '',
    modelSteps = 160,
  ) {
    this.layer = new GalaxyLayer(pixelRatio);
    this.images = new ImageLayer(imageUrl, anisotropy, pixelRatio);
    this.models = new GalaxyModelLayer(modelUrl, anisotropy, pixelRatio, modelSteps);
    this.layer.group.add(this.images.group);
    this.layer.group.add(this.models.group);
    this.cosmology = new Cosmology(index?.H0 ?? 74.6, index?.omegaM ?? 0.3);
    const g = ICRS_TO_GAL;
    this.galacticPole = icrfToScene([g[6], g[7], g[8]]);
    this.galacticCentreDir = icrfToScene([g[0], g[1], g[2]]);
    if (index && localBuffer) {
      this.local = withMilkyWay(decodeGalaxies(localBuffer, index.local), this.milkyWay.absMag);
      this.layer.add(this.local);
      index.named.forEach((g, k) => {
        const kind = g.kind === 'globular' ? 'globular cluster' : 'galaxy';
        this.targets.push({ id: GALAXY_ID + k, name: g.name, kind, radius: this.extentKm(g.i), aliases: g.aka });
      });
      index.clusters.forEach((c, k) => {
        this.targets.push({ id: CLUSTER_ID + k, name: c.name, kind: 'galaxy cluster', radius: c.radius * MPC_KM, aliases: [] });
      });
      this.andromeda = index.named.findIndex((g) => g.name === 'Andromeda Galaxy');
      this.addModels(modelList);
    }
    for (const n of imageList) {
      if (n.kind === 'galaxy' || n.dist === undefined) continue;
      const k = this.nebulae.push(n) - 1;
      this.targets.push({ id: NEBULA_ID + k, name: n.name, kind: n.kind === 'emission' ? 'nebula' : n.kind, radius: this.nebulaRadiusPc(n) * 1e-6 * MPC_KM, aliases: n.aka ?? [] });
      const centre = this.positionMpc(NEBULA_ID + k);
      const pc = n.dist, v = n.V ?? 8;
      if (!n.within) this.images.add(n, { centre, distance: pc * 1e-6, magnitude: (d) => v - NEBULA_CORE_GAIN + 5 * Math.log10(Math.max(d, 1e-12) / (pc * 1e-6)) });
    }
    if (this.andromeda >= 0) {
      this.targets.push({ id: LOCAL_GROUP_ID, name: 'Local Group', kind: 'galaxy group', radius: 1.2 * MPC_KM, aliases: ['Local Group of galaxies'] });
    }
    this.targets.push({ id: MILKY_WAY_ID, name: 'Milky Way', kind: 'galaxy', radius: 15 * MPC_KM * 1e-3, aliases: ['Galaxy', 'Our galaxy'] });
  }

  has(id: number): boolean {
    return id >= GALAXY_ID && id <= LOCAL_GROUP_ID && id !== SGR_A_ID && (id < NEBULA_ID || id >= MILKY_WAY_ID || id - NEBULA_ID < this.nebulae.length);
  }

  /** 3D models of the nearest galaxies: the catalogue hands each over to its model as it resolves. */
  private addModels(list: GalaxyModelSpec[]): void {
    const b = this.local!, index = this.index!;
    const byName = new Map(index.named.map((g) => [g.name, g]));
    for (const spec of list) {
      const g = byName.get(spec.name);
      if (!g || this.modelled.has(g.i)) continue;
      this.modelled.add(g.i);
      const i = g.i;
      // Centred on the nucleus, at the catalogue's distance (an interacting companion at its partner's).
      const partner = spec.with ? byName.get(spec.with) : undefined;
      const d = Math.hypot(...galaxyPosition(b, partner ? partner.i : i));
      const ra = (spec.ra * Math.PI) / 180, dec = (spec.dec * Math.PI) / 180;
      const centre: Vec3 = [d * Math.cos(dec) * Math.cos(ra), d * Math.cos(dec) * Math.sin(ra), d * Math.sin(dec)];
      const axes = modelAxes(spec, centre);
      this.modelOf.set(i, { spec, centre, axes });
      const absMag = galaxyAbsMag(b.absMag[i]);
      const av = 3.1 * b.ebv[i] * 0.01;
      this.models.add(spec, {
        centre,
        axes,
        magnitudeFromSun: () => absMag + 5 * Math.log10(d * 1e5) + av * this.extinction,
        handover: galaxyRadiusKpc(b.radius[i]) * 1e-3,
      }, () => this.layer.markImage(b, 0, i));
    }
  }

  private nebulaRadiusPc(n: SkyImage): number {
    return ((n.fov * Math.PI) / 180) * (n.dist ?? 0) * 0.35;
  }

  /** D25-like radius of a catalogue galaxy (km): 3.2 disc scale lengths, or 3 half-light radii. */
  private extentKm(i: number): number {
    const b = this.local!;
    const r = galaxyRadiusKpc(b.radius[i]) * ((b.flags[i] & FLAG_SPHEROID) ? 3 : 3.2);
    return r * 1e-3 * MPC_KM;
  }

  /** Barycentric ICRS position in Mpc. */
  positionMpc(id: number, out: Vec3 = [0, 0, 0]): Vec3 {
    if (id === MILKY_WAY_ID) {
      galactocentricToIcrsPc([0, 0, 0], out);
      for (let k = 0; k < 3; k++) out[k] *= 1e-6;
      return out;
    }
    if (id === SGR_A_ID) {
      const ra = (SGR_A.ra * Math.PI) / 180, dec = (SGR_A.dec * Math.PI) / 180;
      const d = SGR_A.pc * 1e-6;
      out[0] = d * Math.cos(dec) * Math.cos(ra);
      out[1] = d * Math.cos(dec) * Math.sin(ra);
      out[2] = d * Math.sin(dec);
      return out;
    }
    if (id >= NEBULA_ID && id < MILKY_WAY_ID) {
      const n = this.nebulae[id - NEBULA_ID];
      const ra = (n.ra * Math.PI) / 180, dec = (n.dec * Math.PI) / 180;
      const d = (n.dist ?? 0) * 1e-6;
      out[0] = d * Math.cos(dec) * Math.cos(ra);
      out[1] = d * Math.cos(dec) * Math.sin(ra);
      out[2] = d * Math.sin(dec);
      return out;
    }
    if (!this.index || !this.local) return out;
    if (id === LOCAL_GROUP_ID) {
      const mw = this.positionMpc(MILKY_WAY_ID);
      const m31 = galaxyPosition(this.local, this.index.named[this.andromeda].i);
      for (let k = 0; k < 3; k++) out[k] = mw[k] + LOCAL_GROUP_FRACTION * (m31[k] - mw[k]);
      return out;
    }
    if (id >= CLUSTER_ID) {
      const c = this.index.clusters[id - CLUSTER_ID];
      galaxyPosition(this.local, c.i, out);
      // The cluster's distance (its members' average) along its brightest galaxy's direction.
      const d = Math.hypot(out[0], out[1], out[2]);
      const z = this.cosmology.redshift(c.dist);
      for (let k = 0; k < 3; k++) out[k] *= c.dist / (1 + z) / d;
      return out;
    }
    const i = this.index.named[id - GALAXY_ID].i;
    const model = this.modelOf.get(i);
    if (model) {
      out[0] = model.centre[0];
      out[1] = model.centre[1];
      out[2] = model.centre[2];
      return out;
    }
    return galaxyPosition(this.local, i, out);
  }

  /** Scene position (km). */
  position(id: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const p = this.positionMpc(id, out);
    for (let k = 0; k < 3; k++) p[k] *= MPC_KM;
    return icrfToScene(p, out);
  }

  /** Camera frame: discs are orbited about their own axis, the Milky Way about the Galactic pole. */
  frame(id: number, origin: Vec3): Frame | undefined {
    let up: Vec3 | undefined;
    let ref: Vec3 = this.galacticCentreDir;
    if (id === MILKY_WAY_ID || id === SGR_A_ID || id === LOCAL_GROUP_ID) up = this.galacticPole;
    else if (id >= GALAXY_ID && id < CLUSTER_ID && this.local) {
      const i = this.index!.named[id - GALAXY_ID].i;
      const model = this.modelOf.get(i);
      if (model) {
        up = icrfToScene(model.axes.z);
        ref = icrfToScene(model.axes.x);
      } else if (!(this.local.flags[i] & FLAG_SPHEROID)) {
        const { normal, major } = discAxes(this.local, i);
        up = icrfToScene(normal);
        ref = icrfToScene(major);
      }
    }
    if (!up) return undefined;
    const north = normalise(sub3(ref, scale3(up, dot3(ref, up))));
    const east = cross3(north, up);
    return { origin, east, north, up };
  }

  view(id: number, radius: number): { distance: number; yaw: number; pitch: number } {
    if (id === MILKY_WAY_ID) return { distance: 0.06 * MPC_KM, yaw: 0.4, pitch: 0.75 };
    if (id === SGR_A_ID) return { distance: 0.0006 * MPC_KM, yaw: 0.4, pitch: 0.35 };
    if (id === LOCAL_GROUP_ID) return { distance: 2.4 * MPC_KM, yaw: 0.5, pitch: 0.45 };
    if (id >= NEBULA_ID && id < MILKY_WAY_ID) return { distance: radius * 4, yaw: 0, pitch: 0.1 };
    if (id >= CLUSTER_ID) return { distance: radius * 3, yaw: 0.3, pitch: 0.4 };
    const model = id >= GALAXY_ID && this.index ? this.modelOf.get(this.index.named[id - GALAXY_ID].i) : undefined;
    if (model) {
      // From where Earth sees it (the pictures are taken from here), turned a little so
      // that its depth shows.
      const { x, y, z } = model.axes;
      const toEarth = normalise(scale3(model.centre, -1));
      const pitch = Math.asin(Math.max(-1, Math.min(1, dot3(toEarth, z))));
      const north = x, east = scale3(y, -1);
      const h = scale3(sub3(toEarth, scale3(z, Math.sin(pitch))), -1);
      const yaw = Math.atan2(dot3(h, east), dot3(h, north));
      return { distance: radius * 3.2, yaw: yaw + 0.25, pitch: pitch + 0.12 * Math.sign(pitch || 1) };
    }
    return { distance: radius * 3.2, yaw: 0.3, pitch: 0.9 };
  }

  /**
   * @param cameraMpc barycentric ICRS camera position (Mpc).
   * @param msat saturation magnitude for galaxies as points.
   */
  update(cameraMpc: Vec3, msat: number, pixelsPerRadian: number, brightness: number, lookDistanceKm: number): void {
    const fromSun = Math.hypot(cameraMpc[0], cameraMpc[1], cameraMpc[2]);
    // Milky Way dust in front of a galaxy is the catalogue's, as seen from the Sun.
    const extinction = 1 - smoothstep(0.015, 0.06, fromSun);
    this.extinction = extinction;
    this.layer.update(cameraMpc, msat, pixelsPerRadian, brightness, extinction);
    const sigma = this.layer.uniforms.uSigma.value * this.layer.uniforms.uPixelRatio.value;
    this.images.update(cameraMpc, msat, pixelsPerRadian, brightness, 2 * Math.PI * sigma * sigma);
    this.models.update(cameraMpc, msat, pixelsPerRadian, brightness, 2 * Math.PI * sigma * sigma);
    if (!this.deepRequested && this.index && (fromSun > 8 || lookDistanceKm > 8 * MPC_KM)) {
      this.deepRequested = true;
      fetch(this.deepUrl)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
        .then((buffer) => this.layer.add(decodeGalaxies(buffer, this.index!.deep)))
        .catch((err) => console.warn('deep galaxies:', err));
    }
  }

  /** Named galaxies worth labelling from here: [target id, apparent V] sorted brightest first. */
  labelCandidates(cameraMpc: Vec3, limit: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    if (!this.index || !this.local) return out;
    const p: Vec3 = [0, 0, 0];
    const fromSun = Math.hypot(cameraMpc[0], cameraMpc[1], cameraMpc[2]);
    this.index.named.forEach((g, k) => {
      if (g.kind === 'globular' && fromSun > 0.3) return;
      galaxyPosition(this.local!, g.i, p);
      const d = Math.hypot(p[0] - cameraMpc[0], p[1] - cameraMpc[1], p[2] - cameraMpc[2]);
      const m = galaxyAbsMag(this.local!.absMag[g.i]) + 5 * Math.log10(Math.max(d, 1e-9) * 1e5);
      if (m < limit) out.push([GALAXY_ID + k, m]);
    });
    // The Milky Way itself, once the camera is out among the other galaxies.
    if (fromSun > 0.1) {
      const mw = this.positionMpc(MILKY_WAY_ID, p);
      const d = Math.hypot(mw[0] - cameraMpc[0], mw[1] - cameraMpc[1], mw[2] - cameraMpc[2]);
      const m = this.milkyWay.absMag + 5 * Math.log10(d * 1e5);
      if (m < limit) out.push([MILKY_WAY_ID, m]);
    }
    return out.sort((a, b) => a[1] - b[1]);
  }

  /** HUD lines for a deep-sky target, seen from the camera. */
  describe(id: number, cameraMpc: Vec3, cameraDistanceKm: number): string[] {
    const lines: string[] = [];
    const p = this.positionMpc(id);
    const fromSun = Math.hypot(p[0], p[1], p[2]);
    const methods = this.index?.methods ?? [];
    const away = (mpc: number) => `${formatLightYearCount(mpc * LY_PER_MPC)} from the Sun (${mpc < 1 ? `${(mpc * 1000).toFixed(mpc < 0.1 ? 1 : 0)} kpc` : `${mpc.toFixed(mpc < 10 ? 2 : 1)} Mpc`})`;
    if (id === MILKY_WAY_ID) {
      lines.push('Our galaxy, a barred spiral (modelled)');
      lines.push(`Sun ${(R0 * 3261.56).toLocaleString('en-US', { maximumFractionDigits: 0 })} light years from the centre (GRAVITY 2022)`);
      lines.push(`Absolute magnitude ${this.milkyWay.absMag.toFixed(1)} (model)`);
      lines.push('Spiral arms: masers, Reid et al. 2019; far side extrapolated');
    } else if (id === LOCAL_GROUP_ID) {
      lines.push('The Milky Way, Andromeda, Triangulum and about 100 smaller galaxies');
      lines.push(away(fromSun));
      lines.push('Centre of mass taken 55% of the way to Andromeda (assumed mass ratio)');
    } else if (id >= NEBULA_ID && id < MILKY_WAY_ID) {
      const n = this.nebulae[id - NEBULA_ID];
      if (n.aka?.length) lines.push(n.aka.slice(0, 3).join(' · '));
      lines.push(`${n.kind[0].toUpperCase()}${n.kind.slice(1)}${n.kind.endsWith('nebula') ? '' : ' nebula'}`);
      lines.push(`${formatLightYearCount((n.dist ?? 0) * 3.261563777)} from the Sun (${n.source})`);
      lines.push(`About ${formatLightYearCount(2 * this.nebulaRadiusPc(n) * 3.261563777)} across`);
      lines.push(`Magnitude ${(n.V ?? 0).toFixed(1)} from Earth`);
      lines.push(n.within ? `In the ${n.within}, part of its 3D model` : 'Picture: DSS2 colour plates, as seen from Earth');
      const shown = this.images.shown(n.name);
      if (shown.detail?.kind === 'survey') {
        lines.push(`Close-up of ${shown.detail.what}: ${shown.detail.source} (${shown.detail.arcsec}″ per pixel)`);
      } else if (shown.detail?.kind === 'ai') {
        lines.push(`Close-up of ${shown.detail.what}: AI-enhanced ×4 (Real-ESRGAN), matched to the survey at its resolution`);
      } else if (n.detail?.length) {
        lines.push(`Close-up of ${n.detail[0].what} as you approach (${n.detail[0].arcsec}″ survey, then AI ×4)`);
      }
    } else if (id >= CLUSTER_ID && this.index) {
      const c = this.index.clusters[id - CLUSTER_ID];
      lines.push(`Galaxy cluster around ${c.centre}`);
      lines.push(away(c.dist));
      lines.push(`Cosmicflows-4 group distance, ${c.members} members measured`);
      lines.push(`Light travel time ${formatYears(this.cosmology.lightTravelYears(c.dist))}`);
    } else if (this.index && this.local) {
      const g = this.index.named[id - GALAXY_ID];
      const b = this.local;
      const flags = b.flags[g.i];
      const globular = (flags & FLAG_GLOBULAR) !== 0;
      if (g.aka.length) lines.push(g.aka.slice(0, 3).join(' · '));
      lines.push(globular ? 'Globular cluster of the Milky Way' : flags & FLAG_SPHEROID ? 'Elliptical or lenticular galaxy' : 'Disc galaxy');
      lines.push(away(fromSun));
      const how = methods[g.method] ?? 'redshift';
      lines.push(`Distance from ${how}${g.own ? ` (galaxy alone: ${g.own.toFixed(1)} Mpc)` : ''}`);
      const across = (2 * this.extentKm(g.i)) / MPC_KM * LY_PER_MPC;
      lines.push(`About ${formatLightYearCount(across)} across`);
      const absMag = galaxyAbsMag(b.absMag[g.i]);
      const fromHere = Math.hypot(p[0] - cameraMpc[0], p[1] - cameraMpc[1], p[2] - cameraMpc[2]);
      lines.push(`Absolute magnitude ${absMag.toFixed(1)}; ${(absMag + 5 * Math.log10(Math.max(fromHere, 1e-9) * 1e5)).toFixed(1)} from here`);
      if (g.v !== undefined && g.v !== null && !globular) lines.push(g.v >= 0 ? `Receding at ${g.v.toLocaleString('en-US')} km/s` : `Approaching at ${(-g.v).toLocaleString('en-US')} km/s`);
      lines.push(`Light travel time ${formatYears(this.cosmology.lightTravelYears(fromSun))}`);
      const model = this.modelOf.get(g.i)?.spec;
      if (model) {
        const from = model.survey === 'SDSS' ? 'SDSS' : 'DSS2 plate';
        lines.push(model.kind === 'spheroid'
          ? `3D model from ${from} images: Sérsic n = ${model.bulge.n}`
          : `3D model from ${from} images: bulge ${Math.round((model.bulge.L / (model.bulge.L + (model.discL ?? 0))) * 100)}% of the starlight, disc tilted ${Math.round((Math.acos(model.cosi ?? 1) * 180) / Math.PI)}° to our view`);
      }
    }
    lines.push(`Camera ${formatLightYearCount((cameraDistanceKm / MPC_KM) * LY_PER_MPC)} from its centre`);
    return lines;
  }
}

/** The catalogue with the Milky Way added as a point for views from far away. */
function withMilkyWay(b: GalaxyBlock, absMag: number): GalaxyBlock {
  const n = b.count + 1;
  const grow = <T extends Float32Array | Uint8Array>(a: T, size: number, make: (n: number) => T): T => {
    const out = make(n * size);
    out.set(a);
    return out;
  };
  const position = grow(b.position, 3, (k) => new Float32Array(k));
  const gc = galactocentricToIcrsPc([0, 0, 0]);
  position.set(gc.map((v) => v * 1e-6), b.count * 3);
  const u8 = (k: number) => new Uint8Array(k);
  const out: GalaxyBlock = {
    count: n,
    position,
    absMag: grow(b.absMag, 1, u8),
    radius: grow(b.radius, 1, u8),
    axis: grow(b.axis, 1, u8),
    angle: grow(b.angle, 1, u8),
    colour: grow(b.colour, 1, u8),
    ebv: grow(b.ebv, 1, u8),
    flags: grow(b.flags, 1, u8),
  };
  out.absMag[b.count] = Math.round((absMag + 26) * 10);
  out.radius[b.count] = Math.round(60 * Math.log10(2.6 / 0.05));
  out.axis[b.count] = 255;
  out.colour[b.count] = Math.round(0.75 * 200);
  out.flags[b.count] = FLAG_MILKY_WAY;
  return out;
}

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalise = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
