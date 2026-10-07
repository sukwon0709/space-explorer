import * as THREE from 'three';
import type { Vec3 } from './core/ephemeris';
import { icrfToScene, sceneToIcrf } from './core/frames';
import { PC_KM, type NamedStar } from './core/stars';
import { AU_KM, EARTH_RADIUS_KM, SUN_GM, StarSystems, hashName, type PlanetInfo, type State, type SystemsData } from './core/systems';
import { ExoplanetGlobe, type PlanetLight } from './render/exoplanet';
import { StarGlobe, starColor, type StarLook } from './render/starglobe';
import { formatDistance } from './ui/format';

/** Ids of companion stars missing from the catalogue (Sirius B), and of exoplanets. */
export const COMPANION_ID = 56_000_000;
export const PLANET_ID = 57_000_000;
const SOLAR_RADIUS_KM = 695700;
const EARTH_GM = 398600.4418;
/** How far off (fraction of its distance) the sky catalogue may draw a star: float32 and then some. */
export const CATALOGUE_PRECISION = 5e-7;
/** How far out (km) a system's members are drawn by this layer instead of the catalogue. */
const SYSTEM_REACH = 3000 * AU_KM;
const MAX_POINTS = 16;

export interface SystemTarget {
  id: number;
  name: string;
  kind: string;
  radius: number;
  aliases: string[];
}

/** Uniforms this layer sets itself instead of sharing with the star field. */
const OWN = new Set(['uCamHigh', 'uCamLow', 'uHideWithin', 'uDustBlend', 'uYears']);

/**
 * Star systems around the catalogue stars: binary companions on their orbits, and
 * exoplanets. Gives search targets, positions for the camera and the ship, gravity,
 * and draws the system the view is in: stars up close (render/starglobe.ts), planets
 * (render/exoplanet.ts), points for whatever is too small to see, and orbits.
 */
export class Systems {
  readonly model: StarSystems;
  readonly group = new THREE.Group();
  readonly targets: SystemTarget[] = [];
  private readonly globes: StarGlobe[] = [new StarGlobe(), new StarGlobe()];
  private readonly planetGlobes: ExoplanetGlobe[] = [];
  private readonly orbits = new THREE.Group();
  private readonly orbitMaterial = new THREE.LineBasicMaterial({ color: '#7fb0ff', transparent: true, opacity: 0.5, depthWrite: false });
  private readonly binaryMaterial = new THREE.LineBasicMaterial({ color: '#ffd27f', transparent: true, opacity: 0.4, depthWrite: false });
  private orbitHost = -1;
  private readonly points: THREE.Points;
  private readonly pointPos: THREE.BufferAttribute;
  private readonly pointMag: THREE.BufferAttribute;
  private readonly pointTeff: THREE.BufferAttribute;
  /** The system drawn this frame: its primary (a named star index), or -1. */
  active = -1;
  /** Members drawn this frame, for labels: id and scene position. */
  readonly shown: Array<{ id: number; name: string; pos: Vec3 }> = [];

  constructor(
    readonly stars: NamedStar[],
    data: SystemsData,
    private readonly starId: number,
    starMaterial: THREE.ShaderMaterial,
    fallbackMass: (star: NamedStar) => number,
  ) {
    this.model = new StarSystems(stars, data, fallbackMass);
    for (const c of this.model.companions) {
      const primary = stars[this.model.binaries[c.binary].primary];
      this.targets.push({ id: COMPANION_ID + c.index, name: c.name, kind: c.kind, radius: c.radius * SOLAR_RADIUS_KM, aliases: [`${primary.desig ?? primary.name} B`] });
    }
    for (const p of this.model.planets) {
      this.targets.push({ id: PLANET_ID + p.index, name: p.name, kind: `${p.kind} (look estimated)`, radius: p.radius * EARTH_RADIUS_KM, aliases: [] });
    }
    for (const g of this.globes) this.group.add(g.group);
    this.group.add(this.orbits);

    // Points for members too small to see as discs, with the star field's shader.
    const material = starMaterial.clone();
    for (const key of Object.keys(starMaterial.uniforms)) if (!OWN.has(key)) material.uniforms[key] = starMaterial.uniforms[key];
    material.uniforms.uDustBlend.value = 0;
    const geometry = new THREE.BufferGeometry();
    this.pointPos = new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.pointMag = new THREE.BufferAttribute(new Float32Array(MAX_POINTS), 1).setUsage(THREE.DynamicDrawUsage);
    this.pointTeff = new THREE.BufferAttribute(new Float32Array(MAX_POINTS), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.pointPos);
    geometry.setAttribute('velocity', new THREE.Float16BufferAttribute(new Uint16Array(MAX_POINTS * 3), 3));
    geometry.setAttribute('absMag', this.pointMag);
    geometry.setAttribute('teffCode', this.pointTeff);
    geometry.setAttribute('avCode', new THREE.BufferAttribute(new Uint8Array(MAX_POINTS), 1));
    geometry.setDrawRange(0, 0);
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = -10;
    this.group.add(this.points);
  }

  has(id: number): boolean {
    return (id >= COMPANION_ID && id < COMPANION_ID + this.model.companions.length) || (id >= PLANET_ID && id < PLANET_ID + this.model.planets.length);
  }

  isPlanet(id: number): boolean {
    return id >= PLANET_ID && id < PLANET_ID + this.model.planets.length;
  }

  planet(id: number): PlanetInfo {
    return this.model.planets[id - PLANET_ID];
  }

  // ---- positions -----------------------------------------------------------------

  private readonly s: State = { p: [0, 0, 0], v: [0, 0, 0], acc: [0, 0, 0] };

  /** State (ICRF) of a star by id (catalogue or companion) or planet. */
  state(id: number, tdb: number, out: State = this.s): State {
    if (this.isPlanet(id)) return this.model.planetState(id - PLANET_ID, tdb, out);
    if (id >= COMPANION_ID && id < PLANET_ID) return this.model.companionState(id - COMPANION_ID, tdb, out);
    return this.model.starState(id - this.starId, tdb, out);
  }

  /** Scene position (km) of a catalogue star, companion or planet. */
  position(id: number, tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    return icrfToScene(this.state(id, tdb).p, out);
  }

  velocity(id: number, tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    return icrfToScene(this.state(id, tdb).v, out);
  }

  acceleration(id: number, tdb: number, out: Vec3 = [0, 0, 0]): Vec3 {
    return icrfToScene(this.state(id, tdb).acc, out);
  }

  // ---- what belongs to which system ----------------------------------------------

  /** The primary (named star index) of the system an id belongs to, or -1. */
  systemOf(id: number): number {
    let k = -1;
    if (this.isPlanet(id)) k = this.planet(id).host;
    else if (id >= COMPANION_ID && id < PLANET_ID) return this.model.binaries[this.model.companions[id - COMPANION_ID].binary].primary;
    else if (id >= this.starId && id < this.starId + this.stars.length) k = id - this.starId;
    if (k < 0) return -1;
    const b = this.model.binaryOf.get(k);
    if (b) return b.primary;
    return this.model.planetsOf.has(k) ? k : -1;
  }

  /** Ids of a system's stars. */
  starsOf(primary: number): number[] {
    const b = this.model.binaryOf.get(primary);
    if (!b) return [this.starId + primary];
    return [this.starId + b.primary, 'star' in b.secondary ? this.starId + b.secondary.star : COMPANION_ID + b.secondary.companion];
  }

  /** Ids of a system's planets. */
  planetsIn(primary: number): number[] {
    const out: number[] = [];
    for (const id of this.starsOf(primary)) {
      if (id >= COMPANION_ID) continue;
      for (const p of this.model.planetsOf.get(id - this.starId) ?? []) out.push(PLANET_ID + p.index);
    }
    return out;
  }

  /** A star's look and light: radius (km), temperature, surface brightness, gravity, visual luminosity. */
  starLook(id: number): StarLook & { luminosity: number; mass: number; name: string } {
    let teff: number, rSun: number, M: number, mass: number, name: string, degenerate = false;
    if (id >= COMPANION_ID) {
      const c = this.model.companions[id - COMPANION_ID];
      teff = c.teff; rSun = c.radius; M = c.M; mass = this.model.companionMass(c); name = c.name;
      degenerate = c.kind === 'white dwarf';
    } else {
      const k = id - this.starId;
      const s = this.stars[k];
      teff = s.teff; rSun = s.radius; M = s.M; mass = this.model.massOf(k); name = s.name;
    }
    const luminosity = 10 ** (-0.4 * (M - 4.83));
    return {
      teff, radius: rSun * SOLAR_RADIUS_KM, surface: luminosity / (rSun * rSun), gravity: mass / (rSun * rSun),
      seed: hashName(name), degenerate, luminosity, mass, name,
    };
  }

  /** Light from a system's stars at a point (scene km): sum of L_V / r² in Suns at 1 AU. */
  fluxAt(primary: number, p: Vec3, tdb: number): number {
    let flux = 0;
    for (const id of this.starsOf(primary)) {
      const s = this.position(id, tdb);
      const r = Math.hypot(s[0] - p[0], s[1] - p[1], s[2] - p[2]) / AU_KM;
      flux += this.starLook(id).luminosity / Math.max(r * r, 1e-8);
    }
    return flux;
  }

  /** Starlight energy (all wavelengths) at a point, in Earth's from the Sun. */
  energyAt(primary: number, p: Vec3, tdb: number): number {
    let flux = 0;
    for (const id of this.starsOf(primary)) {
      const look = this.starLook(id);
      const s = this.position(id, tdb);
      const r = Math.hypot(s[0] - p[0], s[1] - p[1], s[2] - p[2]) / AU_KM;
      flux += ((look.radius / SOLAR_RADIUS_KM) ** 2 * (look.teff / 5772) ** 4) / Math.max(r * r, 1e-8);
    }
    return flux;
  }

  // ---- the ship ---------------------------------------------------------------------

  /** Gravity sources near a point (scene km): companions and planets of systems within 0.05 pc. */
  sources(abs: Vec3, out: Array<{ id: number; gm: number }>): void {
    const icrf = sceneToIcrf(abs, [0, 0, 0]);
    const near = (k: number) => {
      const s = this.stars[k];
      return Math.hypot(s.pos[0] * PC_KM - icrf[0], s.pos[1] * PC_KM - icrf[1], s.pos[2] * PC_KM - icrf[2]) < 0.2 * PC_KM;
    };
    for (const c of this.model.companions) {
      const b = this.model.binaries[c.binary];
      if (near(b.primary)) out.push({ id: COMPANION_ID + c.index, gm: b.data.masses[1] * SUN_GM });
    }
    for (const [k, list] of this.model.planetsOf) {
      if (!near(k)) continue;
      for (const p of list) out.push({ id: PLANET_ID + p.index, gm: p.mass * EARTH_GM });
    }
  }

  /** Masses (GM, km³/s²) of the system's stars, for the ship. */
  starGm(id: number): number {
    return this.starLook(id).mass * SUN_GM;
  }

  /** Sphere of influence of a planet, km. */
  influence(id: number): number {
    return this.model.planetInfluence(this.planet(id));
  }

  // ---- drawing --------------------------------------------------------------------

  private readonly m: Float64Array = new Float64Array(9);

  /**
   * Draw the system the focus belongs to (or none).
   * @returns how far (pc) from the camera the catalogue's stars must be hidden, so this
   *   layer's members are not drawn twice.
   */
  update(eye: Vec3, focus: number, tdb: number, exposure: number, pixelsPerRadian: number, starTeffCode: (t: number) => number): number {
    this.shown.length = 0;
    const primary = this.systemOf(focus);
    const centre = primary >= 0 ? this.position(this.starId + primary, tdb) : undefined;
    const near = centre && Math.hypot(centre[0] - eye[0], centre[1] - eye[1], centre[2] - eye[2]) < SYSTEM_REACH;
    this.active = near ? primary : -1;
    if (!near) {
      for (const g of this.globes) g.hide();
      for (const g of this.planetGlobes) g.hide();
      this.orbits.visible = false;
      this.points.geometry.setDrawRange(0, 0);
      return 0;
    }
    let hide = 0;
    let count = 0;
    const pos = this.pointPos.array as Float32Array;
    const mag = this.pointMag.array as Float32Array;
    const teffs = this.pointTeff.array as Float32Array;
    const addPoint = (rel: Vec3, absMag: number, teff: number) => {
      if (count >= MAX_POINTS) return;
      const icrf = sceneToIcrf(rel, [0, 0, 0]);
      for (let a = 0; a < 3; a++) pos[count * 3 + a] = icrf[a] / PC_KM;
      mag[count] = absMag * 1000;
      teffs[count] = starTeffCode(teff);
      count++;
    };

    // Stars: a globe once the disc is a few pixels across, else a point.
    const starIds = this.starsOf(primary);
    const starPos: Vec3[] = [];
    starIds.forEach((id, i) => {
      const p = this.position(id, tdb);
      starPos.push(p);
      const look = this.starLook(id);
      const rel: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
      const d = Math.hypot(...rel);
      hide = Math.max(hide, (d * 1.01) / PC_KM + 1e-6);
      if (id !== focus || id >= COMPANION_ID) this.shown.push({ id, name: look.name, pos: p });
      const px = (look.radius / d) * pixelsPerRadian;
      if (px > 2) {
        this.globes[i].update(rel, look, exposure, tdb, this.starSpin(id, tdb));
      } else this.globes[i].hide();
      if (px < 6) {
        const M = id >= COMPANION_ID ? this.model.companions[id - COMPANION_ID].M : this.stars[id - this.starId].M;
        addPoint(rel, M, look.teff);
      }
    });
    for (let i = starIds.length; i < this.globes.length; i++) this.globes[i].hide();
    // The sky catalogue has binary members where their proper motion alone takes them,
    // tens of AU off: hide its copies out to the far side of the orbit.
    // Its float32 positions are also only good to a few parts in 10⁸ of their distance.
    let margin = CATALOGUE_PRECISION * Math.hypot(...starPos[0]);
    if (starPos.length > 1) margin += 3 * Math.hypot(starPos[1][0] - starPos[0][0], starPos[1][1] - starPos[0][1], starPos[1][2] - starPos[0][2]);
    hide += margin / PC_KM;

    // Planets.
    const planetIds = this.planetsIn(primary);
    while (this.planetGlobes.length < planetIds.length) {
      const g = new ExoplanetGlobe();
      this.planetGlobes.push(g);
      this.group.add(g.mesh);
    }
    planetIds.forEach((id, i) => {
      const info = this.planet(id);
      const st = this.model.planetState(info.index, tdb, { p: [0, 0, 0], v: [0, 0, 0], acc: [0, 0, 0] });
      const p = icrfToScene(st.p);
      const rel: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
      const d = Math.hypot(...rel);
      this.shown.push({ id, name: info.name, pos: p });
      const radius = info.radius * EARTH_RADIUS_KM;
      const px = (radius / d) * pixelsPerRadian;
      const lights = this.lightsAt(p, starIds, starPos, exposure);
      if (px > 0.7) {
        this.planetGlobes[i].update(info, hashName(info.name), rel, this.planetFrame(info, st, tdb), lights, exposure);
      } else this.planetGlobes[i].hide();
      if (px < 3) {
        // As a point: reflected light, Lambert phase law, from the brightest star.
        const toStar = lights[0]?.dir ?? [1, 0, 0];
        const cosPhase = -(toStar[0] * rel[0] + toStar[1] * rel[1] + toStar[2] * rel[2]) / d;
        const alpha = Math.acos(Math.max(-1, Math.min(1, cosPhase)));
        const phase = (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;
        const flux = this.fluxAt(primary, p, tdb); // Suns at 1 AU
        // Flux at the camera relative to the Sun's at 1 AU, then as the absolute
        // magnitude of a star giving it from this distance.
        const ratio = info.albedo * phase * flux * (radius / AU_KM) ** 2 / Math.max((d / AU_KM) ** 2, 1e-30);
        const m = -26.74 - 2.5 * Math.log10(Math.max(ratio, 1e-40));
        addPoint(rel, m - 5 * Math.log10(d / PC_KM / 10), this.stars[info.host].teff);
      }
    });
    for (let i = planetIds.length; i < this.planetGlobes.length; i++) this.planetGlobes[i].hide();
    this.pointPos.needsUpdate = this.pointMag.needsUpdate = this.pointTeff.needsUpdate = true;
    this.points.geometry.setDrawRange(0, count);

    // Orbits: the planets' around their stars, a binary's companion around the primary.
    if (this.orbitHost !== primary) this.buildOrbits(primary, tdb);
    this.orbits.visible = true;
    for (const child of this.orbits.children) {
      const host = child.userData.host as number;
      const p = host >= 0 ? starPos[starIds.indexOf(host)] ?? this.position(host, tdb) : starPos[0];
      child.position.set(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
    }
    return hide;
  }

  /** Fade orbit lines (0 to 1), as near a planet they cut across the view. */
  set orbitOpacity(v: number) {
    this.orbitMaterial.opacity = 0.5 * v;
    this.binaryMaterial.opacity = 0.4 * v;
  }

  private lightsAt(p: Vec3, ids: number[], positions: Vec3[], exposure: number): PlanetLight[] {
    return ids.map((id, i) => {
      const s = positions[i];
      const d: Vec3 = [s[0] - p[0], s[1] - p[1], s[2] - p[2]];
      const r = Math.hypot(...d);
      const look = this.starLook(id);
      return {
        dir: [d[0] / r, d[1] / r, d[2] / r] as Vec3,
        // As SolarSystem.intensity: 7 x exposure at 1 AU from the Sun.
        intensity: (7 * exposure * look.luminosity) / Math.max((r / AU_KM) ** 2, 1e-8),
        color: starColor(look.teff).multiplyScalar(1 / 0.906),
      };
    }).sort((a, b) => b.intensity - a.intensity);
  }

  /** A star's body frame: turning about the ICRF pole at its rotation period (the Sun's if unknown). */
  starSpin(id: number, tdb: number): Float64Array {
    const k = id - this.starId;
    const rotp = id < COMPANION_ID ? this.model.data.hosts[this.stars[k].name]?.rotp : undefined;
    const days = rotp ?? (id >= COMPANION_ID ? 0.5 : 25);
    const angle = ((tdb / (days * 86400)) % 1) * 2 * Math.PI;
    const c = Math.cos(angle), s = Math.sin(angle);
    const x = icrfToScene([c, s, 0]), y = icrfToScene([-s, c, 0]), z = icrfToScene([0, 0, 1]);
    const m = new Float64Array(9);
    for (let r = 0; r < 3; r++) {
      m[r * 3] = x[r];
      m[r * 3 + 1] = y[r];
      m[r * 3 + 2] = z[r];
    }
    return m;
  }

  /**
   * A planet's body frame (row-major body-to-scene): z along its orbit's pole, x toward
   * its star on a world that keeps one face to it, else turning once a day (rocky) or
   * every ten hours (giants): their real days are not known.
   */
  planetFrame(info: PlanetInfo, st: State, tdb: number): Float64Array {
    const star = this.model.starState(info.host, tdb);
    const rel: Vec3 = [st.p[0] - star.p[0], st.p[1] - star.p[1], st.p[2] - star.p[2]];
    const v: Vec3 = [st.v[0] - star.v[0], st.v[1] - star.v[1], st.v[2] - star.v[2]];
    const z = norm(cross(rel, v));
    const toStar = norm([-rel[0], -rel[1], -rel[2]]);
    let x: Vec3;
    if (info.locked) x = toStar;
    else {
      const e1 = norm(cross(z, Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
      const e2 = cross(z, e1);
      const day = (info.kind === 'gas giant' || info.kind === 'ice giant' ? 10 : 24) * 3600;
      const a = ((tdb / day) % 1) * 2 * Math.PI;
      x = [0, 1, 2].map((i) => Math.cos(a) * e1[i] + Math.sin(a) * e2[i]) as Vec3;
    }
    // Orthogonalise x against z.
    const dz = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
    x = norm([x[0] - dz * z[0], x[1] - dz * z[1], x[2] - dz * z[2]]);
    const y = cross(z, x);
    const xs = icrfToScene(x), ys = icrfToScene(y), zs = icrfToScene(z);
    const m = this.m;
    for (let r = 0; r < 3; r++) {
      m[r * 3] = xs[r];
      m[r * 3 + 1] = ys[r];
      m[r * 3 + 2] = zs[r];
    }
    return m;
  }

  private buildOrbits(primary: number, tdb: number): void {
    this.orbitHost = primary;
    for (const child of [...this.orbits.children]) {
      this.orbits.remove(child);
      (child as THREE.Line).geometry.dispose();
    }
    const line = (pts: number[], material: THREE.LineBasicMaterial, host: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const l = new THREE.Line(g, material);
      l.frustumCulled = false;
      l.userData.host = host;
      this.orbits.add(l);
    };
    for (const id of this.planetsIn(primary)) {
      const info = this.planet(id);
      const pts: number[] = [];
      const period = info.orbit.period * 86400;
      for (let k = 0; k <= 360; k++) {
        const p = icrfToScene(this.model.planetOffsetIcrf(info.index, tdb + (k / 360) * period));
        pts.push(p[0], p[1], p[2]);
      }
      line(pts, this.orbitMaterial, this.starId + info.host);
    }
    const b = this.model.binaryOf.get(primary);
    if (b) {
      const pts: number[] = [];
      const period = b.data.orbit.P * 365.25 * 86400;
      for (let k = 0; k <= 720; k++) {
        const p = icrfToScene(this.model.relative(b, tdb + (k / 720) * period).p);
        pts.push(p[0], p[1], p[2]);
      }
      line(pts, this.binaryMaterial, this.starId + b.primary);
    }
  }

  // ---- words ------------------------------------------------------------------------

  /** HUD lines for a planet or companion star (camera at `eye`, scene km). */
  describe(id: number, eye: Vec3, tdb: number): string[] {
    const lines: string[] = [];
    const p = this.position(id, tdb);
    const dist = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
    if (this.isPlanet(id)) {
      const info = this.planet(id);
      const host = this.stars[info.host];
      const star = this.position(this.starId + info.host, tdb);
      const r = Math.hypot(p[0] - star[0], p[1] - star[1], p[2] - star[2]) / AU_KM;
      const flux = this.fluxAt(this.systemOf(id), p, tdb);
      lines.push(`Planet of ${host.name} · ${info.kind}`);
      lines.push(`${info.radius.toFixed(info.radius < 10 ? 2 : 1)} Earth radii${info.radiusEstimated ? ' (estimated from its mass)' : ''} · ${info.mass < 10 ? info.mass.toFixed(2) : Math.round(info.mass).toLocaleString('en-US')} Earth masses${info.massMinimum ? ' at least' : info.massEstimated ? ' (estimated from its size)' : ''}`);
      const P = info.orbit.period;
      lines.push(`Orbit ${P < 2 ? `${(P * 24).toFixed(1)} hours` : P < 1000 ? `${P.toFixed(P < 10 ? 2 : 1)} days` : `${(P / 365.25).toFixed(1)} years`}, ${info.orbit.a.toFixed(info.orbit.a < 1 ? 4 : 2)} AU${info.orbit.e > 0.01 ? `, eccentricity ${info.orbit.e.toFixed(2)}` : ''} · now ${r.toFixed(r < 1 ? 4 : 2)} AU from its star`);
      // Energy (all wavelengths) as Earth gets from the Sun, and visible light, which
      // around a red dwarf is far less: most of its light is infrared.
      const energy = this.energyAt(this.systemOf(id), p, tdb);
      const fmt = (x: number) => (x < 0.01 ? x.toPrecision(1) : x < 10 ? x.toFixed(2) : Math.round(x).toLocaleString('en-US'));
      lines.push(`${Math.round(info.teq).toLocaleString('en-US')} K equilibrium temperature · gets ${fmt(energy)}× the energy Earth does${Math.abs(flux / energy - 1) > 0.25 ? `, ${fmt(flux)}× its visible light` : ''}`);
      if (info.locked) lines.push('Probably keeps one face to its star');
      lines.push(`Found ${info.data.year ?? ''} by ${(info.data.method ?? 'unknown').toLowerCase()}${info.extra.transits ? ' · seen to transit' : ''}`.replace('Found  by', 'Found by'));
      lines.push(`Orbit tilt ${info.inclinationKnown ? 'measured' : 'unknown (drawn at 60°)'}, its turn on the sky unknown${info.phaseKnown ? '' : ' · position along it unknown'}`);
      lines.push('Surface: estimated from its size, mass and temperature; no image exists');
      lines.push(`Camera ${formatDistance(dist - info.radius * EARTH_RADIUS_KM)} above it`);
      return lines;
    }
    const c = this.model.companions[id - COMPANION_ID];
    const b = this.model.binaries[c.binary];
    const primary = this.stars[b.primary];
    const sep = Math.hypot(...this.model.relative(b, tdb).p) / AU_KM;
    lines.push(`Companion of ${primary.name} · ${c.kind}`);
    lines.push(`${c.teff.toLocaleString('en-US')} K, ${c.radius < 0.1 ? `${(c.radius * SOLAR_RADIUS_KM).toLocaleString('en-US', { maximumFractionDigits: 0 })} km radius` : `${c.radius.toFixed(2)} × the Sun's radius`}, ${b.data.masses[1]} Suns`);
    lines.push(`With ${primary.name}: ${sep.toFixed(1)} AU apart now, one orbit in ${b.data.orbit.P.toFixed(1)} years (USNO ORB6: ${b.data.orbit.ref})`);
    lines.push(`Camera ${formatDistance(dist)} from its centre`);
    return lines;
  }

  /** "In a binary with ..." for a star of a binary. */
  binaryLine(k: number, tdb: number): string | undefined {
    const b = this.model.binaryOf.get(k);
    if (!b) return undefined;
    const other = b.primary === k
      ? ('star' in b.secondary ? this.stars[b.secondary.star].name : this.model.companions[b.secondary.companion].name)
      : this.stars[b.primary].name;
    const sep = Math.hypot(...this.model.relative(b, tdb).p) / AU_KM;
    return `With ${other}: ${sep.toFixed(1)} AU apart now, one orbit in ${b.data.orbit.P.toFixed(1)} years (USNO ORB6: ${b.data.orbit.ref})`;
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

