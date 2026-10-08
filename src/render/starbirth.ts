import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { REDDENING } from '../core/stars';
import { AU, MSUN, type Protostar, type StarBirth } from '../core/starbirth';
import { GlowPoints } from './glowpoints';
import { starColor } from './starglobe';
import { SUN_SURFACE_BRIGHTNESS } from './sun';

const AU_KM = AU / 1e5;
const M_H = 1.6735575e-24;
/** Visual extinction per AU of path per g/cm^3 of gas: N_H / A_V = 1.87e21 cm^-2 (Bohlin et al. 1978), 1.4 m_H per hydrogen nucleus. */
export const AV_PER_AU = AU / (1.4 * M_H * 1.87e21);
const SAMPLES = 256;
const RSUN_AU = 695700 / AU_KM;
/** Dust albedo in V (Draine 2003). */
const ALBEDO = 0.6;

/**
 * The cloud as the camera's rays meet it, in AU in the cloud's own axes (z the spin
 * axis): the envelope's density from the collapse model, an empty outflow cavity
 * round the axis, and the disc as a thin sheet in the z = 0 plane.
 */
export class CloudModel {
  /** Envelope log10 density at r = R (i / (n-1))^3, and the A_V from the centre out to there. */
  readonly logRho = new Float32Array(SAMPLES);
  readonly column = new Float32Array(SAMPLES);
  /** Cloud radius (AU), cavity half-angle (radians), disc radius (AU) and surface density at 1 AU (g/cm^2, falling as 1/R). */
  radius = 1;
  cavity = 0;
  discRadius = 0;
  sigma1 = 0;
  /** Star: luminosity (Suns), temperature, radius (AU). */
  star: Protostar | undefined;

  constructor(readonly birth: StarBirth) {
    this.radius = birth.radius / AU;
  }

  /** Recompute for `years` after the collapse began. */
  update(years: number): Protostar {
    const b = this.birth;
    const s = b.state(years);
    const prof = b.profile(Math.max(0, years) * 3.15576e7, 160);
    const R = this.radius;
    let k = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const r = R * (Math.max(i, 0.5) / (SAMPLES - 1)) ** 3 * AU;
      let rho = 0;
      if (prof.length) {
        while (k < prof.length - 1 && prof[k + 1][0] < r) k++;
        if (r <= prof[0][0]) rho = prof[0][1] * (r / prof[0][0]) ** -1.5;
        else if (k >= prof.length - 1) rho = r <= prof[prof.length - 1][0] * 1.0001 ? prof[prof.length - 1][1] : 0;
        else {
          const [r0, p0] = prof[k], [r1, p1] = prof[k + 1];
          const f = Math.log(r / r0) / Math.log(r1 / r0);
          rho = Math.exp(Math.log(p0) * (1 - f) + Math.log(p1) * f);
        }
      }
      // What has fallen inside the disc's radius is in the disc (or the star).
      if (s.discRadius > 0 && r < s.discRadius * 0.5) rho = Math.min(rho, prof.length ? prof[0][1] * (s.discRadius * 0.5 / prof[0][0]) ** -1.5 : 0);
      this.logRho[i] = Math.log10(Math.max(rho, 1e-30));
    }
    // Radial A_V from the star outward.
    let col = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const r = R * (Math.max(i, 0.5) / (SAMPLES - 1)) ** 3;
      const prev = i === 0 ? 0 : R * (Math.max(i - 1, 0.5) / (SAMPLES - 1)) ** 3;
      col += 10 ** this.logRho[i] * AV_PER_AU * (r - prev);
      this.column[i] = col;
    }
    this.cavity = s.star > 0 ? s.cavity : 0;
    this.discRadius = s.discRadius / AU;
    // Surface density falling as 1/R out to the disc's radius: M = 2 pi Sigma_1 R_d (AU^2 -> cm^2).
    this.sigma1 = this.discRadius > 0 ? (s.disc * MSUN) / (2 * Math.PI * this.discRadius * AU * AU) : 0;
    this.star = s.star > 0 ? s : undefined;
    return s;
  }

  /** Envelope density (g/cm^3) at a point (AU, cloud axes). */
  density(p: Vec3): number {
    const r = Math.hypot(p[0], p[1], p[2]);
    if (r >= this.radius) return 0;
    const x = Math.cbrt(r / this.radius) * (SAMPLES - 1);
    const i = Math.min(SAMPLES - 2, Math.floor(x)), f = x - i;
    let rho = 10 ** (this.logRho[i] * (1 - f) + this.logRho[i + 1] * f);
    if (this.cavity > 0 && Math.abs(p[2]) > r * Math.cos(this.cavity)) rho *= 0.01;
    return rho;
  }

  /** A_V along a straight path between two points (AU, cloud axes), the disc included. */
  extinction(a: Vec3, b: Vec3, steps = 400): number {
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...d);
    if (len === 0) return 0;
    let av = 0;
    // Steps bunched toward the point nearest the centre, where the gas is densest.
    const tc = Math.min(1, Math.max(0, -(a[0] * d[0] + a[1] * d[1] + a[2] * d[2]) / (len * len)));
    for (let i = 0; i < steps; i++) {
      const u0 = i / steps, u1 = (i + 1) / steps;
      const map = (u: number) => (u < 0.5 ? tc * (1 - (1 - 2 * u) ** 3) : tc + (1 - tc) * (2 * u - 1) ** 3);
      const t0 = map(u0), t1 = map(u1), tm = 0.5 * (t0 + t1);
      av += this.density([a[0] + d[0] * tm, a[1] + d[1] * tm, a[2] + d[2] * tm]) * AV_PER_AU * (t1 - t0) * len;
    }
    // The disc, where the path crosses its plane.
    if (this.discRadius > 0 && a[2] * b[2] < 0) {
      const t = a[2] / (a[2] - b[2]);
      const R = Math.hypot(a[0] + d[0] * t, a[1] + d[1] * t);
      if (R < this.discRadius && R > 0) av += ((this.sigma1 / Math.max(R, 0.05)) / (1.4 * M_H * 1.87e21)) / Math.max(Math.abs(d[2]) / len, 0.02);
    }
    return av;
  }
}

const vertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

/**
 * March each ray through the cloud. Steps grow with the distance from the centre, so
 * the dense middle is sampled finely; the disc is a sheet added where the ray crosses
 * its plane. `mode` 0 returns the transmittance (multiplied into what is behind), 1
 * the light scattered toward the camera by the dust.
 */
const fragmentShader = (mode: 0 | 1) => /* glsl */ `
uniform float uR;
uniform vec3 uCam;
uniform sampler2D uProfile;  // r: log10 density, g: log10(1 + A_V from the centre)
uniform float uCavity;
uniform float uDiscR;
uniform float uSigma1;
uniform float uStarLum;      // V luminosity, Suns
uniform vec3 uStarColor;
uniform float uLight;        // display scale for scattered light
uniform float uMinStep;
uniform vec2 uViewport;      // drawing buffer, pixels
uniform vec4 uProj;         // the projection's x and y scale and offset
uniform mat3 uViewToLocal;   // camera axes to the cloud's
#include <common>
#include <logdepthbuf_pars_fragment>

const vec3 RED = vec3(${REDDENING.join(', ')});
const float AV_PER_AU = ${AV_PER_AU.toExponential(6)};
const float SIGMA_AV = ${(1 / (1.4 * M_H * 1.87e21)).toExponential(6)};

vec2 profileAt(float r) {
  vec4 t = texture2D(uProfile, vec2((pow(r / uR, 1.0 / 3.0) * ${SAMPLES - 1}.0 + 0.5) / ${SAMPLES}.0, 0.5));
  return t.rg;
}

float densityAt(vec3 p, float r) {
  if (r >= uR) return 0.0;
  float rho = pow(10.0, profileAt(r).r);
  if (uCavity > 0.0 && abs(p.z) > r * cos(uCavity)) rho *= 0.01;
  return rho;
}

void main() {
  #include <logdepthbuf_fragment>
  // Each pixel's ray from the camera itself: interpolating across the sphere's huge
  // facets from inside it is not accurate enough.
  vec2 ndc = gl_FragCoord.xy / uViewport * 2.0 - 1.0;
  vec3 d = normalize(uViewToLocal * vec3((ndc.x + uProj.z) / uProj.x, (ndc.y + uProj.w) / uProj.y, -1.0));
  float b = dot(uCam, d);
  float c = dot(uCam, uCam) - uR * uR;
  float h = b * b - c;
  if (h <= 0.0) discard;
  h = sqrt(h);
  float t = max(-b - h, 0.0), tEnd = -b + h;
  if (tEnd <= 0.0) discard;
  // A different first step for each pixel turns the steps' banding into fine noise.
  float jitter = 0.3 + fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  vec3 tau = vec3(0.0);   // A_V-weighted per channel, magnitudes
  vec3 light = vec3(0.0);
  for (int i = 0; i < 240; i++) {
    if (t >= tEnd) break;
    vec3 p = uCam + d * t;
    float r = length(p);
    float ds = min(max(0.06 * r, uMinStep) * (i == 0 ? jitter : 1.0), tEnd - t);
    vec3 pm = uCam + d * (t + 0.5 * ds);
    float rm = length(pm);
    float rho = densityAt(pm, rm);
    float dAv = rho * AV_PER_AU * ds;
    // The disc: a sheet in the z = 0 plane.
    vec3 q = uCam + d * (t + ds);
    if (uDiscR > 0.0 && p.z * q.z <= 0.0 && abs(d.z) > 1e-6) {
      vec3 x = uCam + d * (-uCam.z / d.z);
      float R = length(x.xy);
      if (R < uDiscR) dAv += SIGMA_AV * uSigma1 / max(R, 0.05) / max(abs(d.z), 0.02);
    }
    ${mode === 1 ? /* glsl */ `
    if (uStarLum > 0.0 && rho > 0.0) {
      // Starlight scattered here: dimmed on the way out by the envelope (none up the
      // cavity) and in the disc's shadow near its plane, then on the way to the camera.
      vec2 pr = profileAt(rm);
      float inCavity = uCavity > 0.0 && abs(pm.z) > rm * cos(uCavity) ? 0.0 : 1.0;
      float shadow = uDiscR > 0.0 && abs(pm.z) < 0.12 * length(pm.xy) && length(pm.xy) > 0.5 ? 40.0 : 0.0;
      float avStar = (pow(10.0, pr.g) - 1.0) * inCavity + shadow;
      float kappa = rho * AV_PER_AU * 0.921;  // optical depth per AU in V
      vec3 dimmed = exp2(-1.3287712 * (avStar * RED + tau));
      // Forward-scattering dust (Henyey-Greenstein, g = 0.6) lit from the centre.
      float mu = dot(normalize(pm), d);
      float g = 0.6;
      float phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
      light += uStarColor * dimmed * (${ALBEDO} * kappa * ds * uStarLum * ${(RSUN_AU * RSUN_AU).toExponential(6)} / (4.0 * max(rm * rm, 1e-4))) * phase;
    }` : ''}
    tau += dAv * RED;
    t += ds;
  }
  ${mode === 0 ? /* glsl */ `
  // Multiplied into the sRGB-encoded frame behind: the transmittance, encoded alike.
  vec3 T = exp2(-1.3287712 * tau);
  gl_FragColor = vec4(pow(T, vec3(1.0 / 2.2)), 1.0);` : /* glsl */ `
  gl_FragColor = vec4(light * uLight, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>`}
}
`;

/**
 * Barnard 68 and the star it makes: the dark cloud dimming and reddening what is behind
 * it, the starlight its dust scatters once a star is lit (a reflection nebula up the
 * outflow's cavity, the disc's shadow across it), and the jets' shocked knots
 * (Herbig-Haro objects) glowing red in H-alpha.
 */
export class CloudView {
  readonly group = new THREE.Group();
  readonly model: CloudModel;
  private readonly absorb: THREE.Mesh;
  private readonly scatter: THREE.Mesh;
  private readonly texture: THREE.DataTexture;
  private readonly uniforms: Record<string, THREE.IUniform>;
  readonly jets: GlowPoints;
  /** Cloud axes to scene (columns: x, y, z = spin axis). */
  readonly axes: THREE.Matrix3;
  private readonly sceneToCloud: THREE.Matrix3;

  constructor(birth: StarBirth, axesScene: { x: Vec3; y: Vec3; z: Vec3 }) {
    this.model = new CloudModel(birth);
    // Half floats: linear filtering of them is core WebGL 2 (of full floats, an extension).
    const data = new Uint16Array(SAMPLES * 4);
    this.texture = new THREE.DataTexture(data, SAMPLES, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
    this.uniforms = {
      uR: { value: this.model.radius },
      uCam: { value: new THREE.Vector3() },
      uProfile: { value: this.texture },
      uCavity: { value: 0 },
      uDiscR: { value: 0 },
      uSigma1: { value: 0 },
      uStarLum: { value: 0 },
      uStarColor: { value: new THREE.Color() },
      uLight: { value: 0 },
      uMinStep: { value: 0.05 },
      uViewport: { value: new THREE.Vector2(1, 1) },
      uProj: { value: new THREE.Vector4() },
      uViewToLocal: { value: new THREE.Matrix3() },
    };
    const geometry = new THREE.IcosahedronGeometry(1, 4);
    const absorb = new THREE.ShaderMaterial({
      vertexShader, fragmentShader: fragmentShader(0), uniforms: this.uniforms, side: THREE.BackSide,
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
    });
    const scatter = new THREE.ShaderMaterial({
      vertexShader, fragmentShader: fragmentShader(1), uniforms: this.uniforms, side: THREE.BackSide,
      depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
    });
    this.absorb = new THREE.Mesh(geometry, absorb);
    this.scatter = new THREE.Mesh(geometry, scatter);
    this.absorb.renderOrder = 10;
    this.scatter.renderOrder = 11;
    this.absorb.frustumCulled = this.scatter.frustumCulled = false;
    const toLocal = new THREE.Matrix3();
    this.absorb.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getDrawingBufferSize(this.uniforms.uViewport.value);
      const e = camera.projectionMatrix.elements;
      this.uniforms.uProj.value.set(e[0], e[5], e[8], e[9]);
      this.uniforms.uViewToLocal.value.copy(this.sceneToCloud).multiply(toLocal.setFromMatrix4(camera.matrixWorld));
    };
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...axesScene.x), new THREE.Vector3(...axesScene.y), new THREE.Vector3(...axesScene.z));
    this.group.quaternion.setFromRotationMatrix(m);
    this.axes = new THREE.Matrix3().setFromMatrix4(m);
    this.sceneToCloud = this.axes.clone().transpose();
    // A little larger than the cloud, so the facets enclose all of it.
    this.absorb.scale.setScalar(1.02 * this.model.radius * AU_KM);
    this.scatter.scale.setScalar(1.02 * this.model.radius * AU_KM);

    // Jets: knots thrown out along both poles at 150-300 km/s, a new one every few
    // hundred years while the star is accreting (Reipurth and Bally 2001).
    const knots = 400;
    const pos = new Float32Array(knots * 3), col = new Float32Array(knots * 3), lum = new Float32Array(knots), size = new Float32Array(knots), param = new Float32Array(knots * 4);
    let seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < knots; k++) {
      const side = k % 2 ? 1 : -1;
      const born = 2e4 + 6e5 * (k / knots) ** 1.4 + 150 * rand();
      // A slight precession of the jet's axis.
      const wob = 0.04 * Math.sin(born / 4000);
      pos.set([wob + 0.01 * (rand() - 0.5), 0.01 * (rand() - 0.5), side], k * 3);
      col.set([1, 0.22, 0.25], k * 3);
      lum[k] = 1;
      size[k] = 0.5 + rand();
      param.set([born, 150 + 150 * rand(), 0, 0], k * 4);
    }
    this.jets = new GlowPoints({
      count: knots,
      declarations: 'uniform float uAge; uniform float uKnotLum;',
      // Where a knot is: its speed times its age, in AU (1 km/s for a year is 0.211 AU).
      place: 'float age = uAge - aParam.x; return age > 0.0 ? p * (aParam.y * age * 0.2109 * uScale) : vec3(0.0);',
      // Bright for a few thousand years, then fading as it sweeps into the cloud.
      light: 'float age = uAge - aParam.x; return age > 0.0 ? uKnotLum * exp(-age / 3000.0) : 0.0;',
      uniforms: { uAge: { value: 0 }, uKnotLum: { value: 0 } },
    });
    this.jets.set(pos, col, lum, size, param);
    this.jets.points.renderOrder = 9;
    this.group.add(this.absorb, this.scatter, this.jets.points);
    this.group.visible = false;
  }

  /** The camera in the cloud's axes, AU, from the cloud centre minus the camera (scene km). */
  cameraLocal(rel: Vec3): Vec3 {
    const v = new THREE.Vector3(-rel[0], -rel[1], -rel[2]).applyMatrix3(this.sceneToCloud).multiplyScalar(1 / AU_KM);
    return [v.x, v.y, v.z];
  }

  /**
   * @param rel the cloud's centre minus the camera, scene km
   * @param years since the collapse began
   * @param exposure the exposure for diffuse light (render/sun.ts units)
   */
  update(rel: Vec3, years: number, exposure: number, ppr: number, pixelRatio: number): Protostar {
    const s = this.model.update(years);
    const data = this.texture.image.data as Uint16Array;
    for (let i = 0; i < SAMPLES; i++) {
      data[i * 4] = THREE.DataUtils.toHalfFloat(this.model.logRho[i]);
      data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(Math.log10(1 + this.model.column[i]));
    }
    this.texture.needsUpdate = true;
    this.group.visible = true;
    this.group.position.set(rel[0], rel[1], rel[2]);
    const cam = this.cameraLocal(rel);
    const u = this.uniforms;
    u.uCam.value.set(...cam);
    u.uCavity.value = this.model.cavity;
    u.uDiscR.value = this.model.discRadius;
    u.uSigma1.value = this.model.sigma1;
    // Steps no finer than a part of the view's resolution at the camera's distance.
    u.uMinStep.value = Math.min(this.model.radius * 0.004, Math.max(0.01, Math.hypot(...cam) * 2e-3));
    const lumV = s.star > 0 ? s.luminosity * vShare(s.teff) : 0;
    u.uStarLum.value = lumV;
    u.uStarColor.value.copy(starColor(Math.max(s.teff, 1000)));
    u.uLight.value = 7 * SUN_SURFACE_BRIGHTNESS * exposure;
    const j = this.jets.uniforms;
    j.uAge.value = years;
    j.uScale.value = AU_KM;
    // Knot sizes about 50 AU; H-alpha about 1e-4 Suns a knot (Reipurth and Bally 2001).
    j.uSizeScale.value = 50 * AU_KM;
    j.uKnotLum.value = s.star > 0 ? Math.max(s.accretion / 2e-6, 0) * 3e-5 * Math.max(s.luminosity, 0.1) : 0;
    j.uExposure.value = exposure;
    j.uPixelsPerRadian.value = ppr;
    j.uPixelRatio.value = pixelRatio;
    return s;
  }

  /** A_V from the camera to the star (at the centre). */
  extinctionToStar(rel: Vec3): number {
    return this.model.extinction(this.cameraLocal(rel), [0, 0, 0]);
  }

  hide(): void {
    this.group.visible = false;
  }
}

/** A blackbody's share of its light in V relative to the Sun's (bolometric to V). */
export function vShare(teff: number): number {
  const f = (t: number) => {
    const x = 26400 / t;
    return x ** 4 / (Math.exp(Math.min(x, 700)) - 1);
  };
  return f(teff) / f(5772);
}
