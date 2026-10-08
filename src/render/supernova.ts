import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { icrfToScene } from '../core/frames';
import {
  DAY, LSUN_ERG, decimalYear, ejectaRadius, hotSpots, ringGeometry, echoDelay, vFraction,
  type LightCurve, type RingGeometry, type SupernovaSpec,
} from '../core/supernova';
import { GlowPoints } from './glowpoints';
import { StarGlobe, type StarLook } from './starglobe';

const C_KM_DAY = 299792.458 * DAY;
const RSUN_KM = 695700;
const IDENTITY = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/**
 * Light of each point as the camera sees it. `delayDays` is the extra light-travel time
 * via p compared with the direct light from the supernova (core/supernova.ts echoDelay),
 * written so float32 keeps it from any distance. The flash and hot-spot curves mirror
 * flashLight and hotSpotLight in core/supernova.ts (keep in sync).
 */
const RING_GLSL = /* glsl */ `
uniform float uDay;
uniform vec3 uCam;
uniform float uFlashLum;
uniform float uSpotLum;
uniform float uYear0;
float delayDays(vec3 p) {
  float r = length(p);
  float dc = length(uCam);
  float d = length(uCam - p);
  return (r + (dot(p, p) - 2.0 * dot(p, uCam)) / (d + dc)) / ${C_KM_DAY.toExponential(8)};
}
float flashCurve(float s) {
  return s <= 0.0 ? 0.0 : (1.0 - exp(-s / 30.0)) * exp(-s / 1100.0);
}
float spotCurve(float since, float year) {
  if (since <= 0.0) return 0.0;
  float fade = year < 2009.0 ? 1.0 : exp(-(year - 2009.0) / 9.8);
  return (1.0 - exp(-since / 2.5)) * fade;
}
`;

const RING_LIGHT = /* glsl */ `
  float s = uDay - delayDays(p);
  if (aParam.x < 0.5) return aParam.w * uFlashLum * flashCurve(s);
  // A hot spot: years since it lit up as seen from here, and the year Earth would see this moment.
  return aParam.w * uSpotLum * spotCurve((s - aParam.z + aParam.y) / 365.25, uYear0 + (s + aParam.y) / 365.25);
`;

/** The ejecta in velocity space: stretched by time, and held back near the ring's plane where they run into it. */
const EJECTA_GLSL = /* glsl */ `
uniform vec3 uNormal;
uniform float uRing;
`;
const EJECTA_PLACE = /* glsl */ `
  vec3 q = p * uScale;
  float r = length(q);
  float limit = uRing * (0.98 + 2.0 * abs(dot(p, uNormal)) / max(length(p), 1e-6));
  return r > limit ? q * (limit / r) : q;
`;

function random(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
}

/** A random unit vector. */
function direction(rand: () => number): Vec3 {
  const z = 2 * rand() - 1, phi = 2 * Math.PI * rand(), s = Math.sqrt(1 - z * z);
  return [s * Math.cos(phi), s * Math.sin(phi), z];
}

/**
 * A supernova up close: the photosphere while the ejecta are opaque (a glowing ball
 * expanding at thousands of km/s, cooling to where hydrogen recombines), then the
 * ejecta themselves, lit by radioactivity: hydrogen outside, and inside, fingers of
 * oxygen and iron mixed outward by Rayleigh-Taylor instabilities (as in 3D simulations,
 * Wongwathanarat et al. 2015). For SN 1987A, its rings: lit by the flash's ultraviolet
 * and fading, then hot spots where the blast wave reaches the inner ring, each seen
 * when its light gets to the camera (light echoes).
 */
export class SupernovaView {
  readonly group = new THREE.Group();
  readonly globe = new StarGlobe();
  readonly ejecta: GlowPoints;
  readonly rings?: GlowPoints;
  readonly geometry?: RingGeometry;
  private readonly sn: SupernovaSpec;
  private readonly curve: LightCurve;

  constructor(sn: SupernovaSpec, curve: LightCurve) {
    this.sn = sn;
    this.curve = curve;
    this.geometry = ringGeometry(sn);
    const g = this.geometry;
    const rand = random(sn.key.length * 7919 + 17);

    // ---- ejecta, in km/s (scene axes)
    const vOuter = ejectaRadius(sn, 1) / DAY;
    const nCore = 9000, nEnv = 9000;
    const n = nCore + nEnv;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), lum = new Float32Array(n), size = new Float32Array(n);
    // SN 1987A's inner ejecta are elongated, close to the ring's plane (Larsson et al. 2016).
    const stretch = (v: Vec3): Vec3 => {
      if (!g) return v;
      const along = v[0] * g.a[0] + v[1] * g.a[1] + v[2] * g.a[2];
      const up = v[0] * g.normal[0] + v[1] * g.normal[1] + v[2] * g.normal[2];
      return [0, 1, 2].map((k) => v[k] + 0.45 * along * g.a[k] - 0.3 * up * g.normal[k]) as Vec3;
    };
    const put = (k: number, v: Vec3, c: [number, number, number], l: number, s: number) => {
      const sc = icrfToScene(v);
      pos.set(sc, k * 3);
      col.set(c, k * 3);
      lum[k] = l;
      size[k] = s;
    };
    // Core: fingers of metals reaching out to about the core speed, with a clumpy middle.
    const fingers = Array.from({ length: 70 }, () => ({ dir: direction(rand), reach: 0.55 + 0.6 * rand(), kind: rand() }));
    for (let k = 0; k < nCore; k++) {
      const f = fingers[k % fingers.length];
      const t = rand() ** 0.7;
      const r = sn.ejecta.coreSpeed * f.reach * t;
      const spread = 0.12 + 0.25 * (1 - t);
      const d: Vec3 = [f.dir[0] + spread * gaussian(rand), f.dir[1] + spread * gaussian(rand), f.dir[2] + spread * gaussian(rand)];
      const l = Math.hypot(...d);
      const v = stretch([(d[0] / l) * r, (d[1] / l) * r, (d[2] / l) * r]);
      // Oxygen ([O I] 630 nm: orange-red), iron and calcium ([Fe II], [Ca II]: deep red and
      // gold), hydrogen mixed in (H-alpha).
      const c: [number, number, number] = f.kind < 0.4 ? [1, 0.55, 0.3] : f.kind < 0.7 ? [1, 0.78, 0.5] : [1, 0.3, 0.25];
      put(k, v, c, 0.92 / nCore, 60 + 80 * rand());
    }
    // Envelope: hydrogen out to the fastest ejecta, densest inside. Late on, most of the
    // light is from the core, where the radioactive heat is (Larsson et al. 2011).
    for (let k = nCore; k < n; k++) {
      const r = sn.ejecta.coreSpeed * 0.6 + (vOuter - sn.ejecta.coreSpeed * 0.6) * rand() ** 2.2;
      const d = direction(rand);
      put(k, stretch([d[0] * r, d[1] * r, d[2] * r]), [1, 0.28, 0.24], 0.08 / nEnv, 150 + 250 * rand());
    }
    this.ejecta = new GlowPoints({
      count: n, place: EJECTA_PLACE, declarations: EJECTA_GLSL,
      uniforms: { uNormal: { value: new THREE.Vector3() }, uRing: { value: 1e30 } },
    });
    this.ejecta.set(pos, col, lum, size);
    if (g) this.ejecta.uniforms.uNormal.value.set(...icrfToScene(g.normal));
    this.group.add(this.globe.group, this.ejecta.points);

    // ---- rings: km from the supernova (scene axes)
    if (g) {
      const spots = hotSpots(g, sn);
      const perRing = [3000, 1500, 1500];
      const perSpot = 40;
      const total = perRing.reduce((a, b) => a + b, 0) + spots.length * perSpot;
      const rp = new Float32Array(total * 3), rc = new Float32Array(total * 3), rl = new Float32Array(total), rs = new Float32Array(total), param = new Float32Array(total * 4);
      const earth: Vec3 = [-1e20 * dirOf(sn)[0], -1e20 * dirOf(sn)[1], -1e20 * dirOf(sn)[2]];
      const year0 = decimalYear(sn.collapse ?? 0);
      let k = 0;
      const add = (p: Vec3, c: [number, number, number], l: number, s: number, kind: number, onDay: number, w: number) => {
        rp.set(icrfToScene(p), k * 3);
        rc.set(c, k * 3);
        rl[k] = l;
        rs[k] = s;
        param.set([kind, echoDelay(p, earth), onDay, w], k * 4);
        k++;
      };
      g.rings.forEach((ring, j) => {
        // Clumpy: the inner ring is a necklace of dense knots.
        const knots = Array.from({ length: 40 }, () => rand());
        for (let i = 0; i < perRing[j]; i++) {
          const phi = 2 * Math.PI * rand();
          const knot = knots[Math.floor((phi / (2 * Math.PI)) * knots.length) % knots.length];
          const r = ring.radius * (1 + 0.025 * gaussian(rand));
          const h = ring.radius * 0.02 * gaussian(rand) + ring.offset;
          const p: Vec3 = [0, 1, 2].map((c) => r * (Math.cos(phi) * g.a[c] + Math.sin(phi) * g.b[c]) + h * g.normal[c]) as Vec3;
          // H-alpha and [N II]: red.
          add(p, [1, 0.3, 0.34], (0.4 + knot) / perRing[0] / 0.9, ring.radius * 0.012, 0, 0, ring.glow);
        }
      });
      for (const spot of spots) {
        const onDay = (spot.on - year0) * 365.25;
        for (let i = 0; i < perSpot; i++) {
          const phi = spot.phi + 0.012 * gaussian(rand);
          const r = g.radius * (spot.r + 0.01 * gaussian(rand));
          const h = g.radius * 0.01 * gaussian(rand);
          const p: Vec3 = [0, 1, 2].map((c) => r * (Math.cos(phi) * g.a[c] + Math.sin(phi) * g.b[c]) + h * g.normal[c]) as Vec3;
          // Shocked gas glows in many lines at once: nearly white, a little pink.
          add(p, [1, 0.82, 0.78], 1 / (spots.length * perSpot), g.radius * 0.008, 1, onDay, spot.strength);
        }
      }
      this.rings = new GlowPoints({
        count: total, light: RING_LIGHT, declarations: RING_GLSL,
        uniforms: {
          uDay: { value: 0 }, uCam: { value: new THREE.Vector3() }, uFlashLum: { value: 0 }, uSpotLum: { value: 0 }, uYear0: { value: year0 },
        },
      });
      this.rings.set(rp, rc, rl, rs, param);
      this.group.add(this.rings.points);
      this.ejecta.uniforms.uRing.value = g.radius;
    }
    this.group.visible = false;
  }

  /** The photosphere at `day`: radius (km), temperature, surface brightness (V, Sun = 1), and its V luminosity (Suns). */
  photosphere(day: number): { radius: number; teff: number; surface: number; lumV: number } {
    if (day < 0) {
      const p = this.sn.progenitor;
      const lumV = 10 ** (-0.4 * (p.absV - 4.83));
      return { radius: p.radiusSun * RSUN_KM, teff: p.teff, surface: lumV / p.radiusSun ** 2, lumV };
    }
    const ph = this.curve.photosphere(day);
    const lumV = (this.curve.luminosity(day) / LSUN_ERG) * ph.opaque * (vFraction(ph.teff) / vFraction(5772));
    return { radius: ph.radius, teff: ph.teff, surface: lumV / (ph.radius / RSUN_KM) ** 2, lumV };
  }

  /** V luminosity (Suns) of the ejecta's own glow, once they are see-through. */
  ejectaLight(day: number): number {
    if (day <= 0) return 0;
    return Math.max(0, this.curve.luminosityV(day) - this.photosphere(day).lumV);
  }

  /**
   * The ring's light: the flash-lit glow's peak and the hot spots' at their brightest
   * (V, Suns). Estimates from the ring's narrow emission lines (about 10^35 erg/s after
   * the flash; Lundqvist and Fransson 1996) and HST photometry of the hot spots
   * (several times that by 2009; Larsson et al. 2011).
   */
  static readonly FLASH_LUM = 15;
  static readonly SPOT_LUM = 80;

  /**
   * Place and light everything.
   * @param rel the supernova's centre minus the camera, scene km
   * @param day days since the explosion's first light reached the camera
   * @param exposure the scene's exposure for its light (see render/sun.ts)
   */
  update(rel: Vec3, day: number, exposure: number, ppr: number, pixelRatio: number, tdb: number, showGlobe: boolean): void {
    this.group.visible = true;
    this.group.position.set(rel[0], rel[1], rel[2]);
    // Sizes are absolute; positions relative to the group (the centre).
    const ph = this.photosphere(day);
    if (showGlobe && ph.surface > 0 && (day < 0 || this.curve.photosphere(day).opaque > 0.02)) {
      const look: StarLook = { teff: ph.teff, radius: ph.radius, surface: ph.surface, gravity: 1e-4, seed: 7, degenerate: true };
      this.globe.update([0, 0, 0], look, exposure, tdb, IDENTITY);
    } else this.globe.hide();
    const t = Math.max(day, 0) * DAY;
    const e = this.ejecta.uniforms;
    e.uScale.value = t;
    e.uSizeScale.value = t;
    e.uLum.value = this.ejectaLight(day);
    e.uExposure.value = exposure;
    e.uPixelsPerRadian.value = ppr;
    e.uPixelRatio.value = pixelRatio;
    this.ejecta.points.visible = day > 0 && e.uLum.value > 0;
    if (this.rings) {
      const u = this.rings.uniforms;
      u.uDay.value = day;
      u.uCam.value.set(-rel[0], -rel[1], -rel[2]);
      u.uFlashLum.value = SupernovaView.FLASH_LUM;
      u.uSpotLum.value = SupernovaView.SPOT_LUM;
      u.uExposure.value = exposure;
      u.uPixelsPerRadian.value = ppr;
      u.uPixelRatio.value = pixelRatio;
      this.rings.points.visible = day > 0;
    }
  }

  hide(): void {
    this.group.visible = false;
    this.globe.hide();
  }

  /** How big the whole thing is now (km): the rings, or the ejecta. */
  extent(day: number): number {
    const ej = ejectaRadius(this.sn, Math.max(day, 0), this.geometry?.radius ?? Infinity);
    return Math.max(this.photosphere(day).radius, this.geometry ? this.geometry.radius * 3 : ej);
  }
}

/** Unit vector from the Sun toward the supernova (ICRS). */
export function dirOf(sn: { ra: number; dec: number }): Vec3 {
  const a = (sn.ra * Math.PI) / 180, d = (sn.dec * Math.PI) / 180;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}
