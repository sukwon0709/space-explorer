import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { AU_KM, GAUSS_K, cometOrbit, orbitPosition, type AsteroidSet, type Comet, type Orbit } from '../core/smallbodies';

/**
 * Asteroids as points whose orbits are solved on the GPU each frame (Kepler's equation
 * in the vertex shader, float32, good to a few hundred km at most: far below a pixel at
 * the distances the belt is seen from), and comets solved on the CPU in float64 so the
 * camera can fly to one.
 */

const asteroidVertex = /* glsl */ `
attribute vec4 el0;  // a [AU], e, i, Omega
attribute vec4 el1;  // omega, M, epoch [days past J2000], H
attribute float neo;
uniform float uDays;
uniform vec3 uSunRel;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  float a = el0.x, e = el0.y;
  float n = ${GAUSS_K} / pow(a, 1.5);
  float M = mod(el1.y + n * (uDays - el1.z), 2.0 * PI);
  float E = e < 0.8 ? M : PI;
  for (int k = 0; k < 8; k++) E -= (E - e * sin(E) - M) / (1.0 - e * cos(E));
  float x = a * (cos(E) - e), y = a * sqrt(1.0 - e * e) * sin(E);
  float cO = cos(el0.w), sO = sin(el0.w), cw = cos(el1.x), sw = sin(el1.x), ci = cos(el0.z), si = sin(el0.z);
  vec3 ecl = vec3(
    x * (cO * cw - sO * sw * ci) - y * (cO * sw + sO * cw * ci),
    x * (sO * cw + cO * sw * ci) - y * (sO * sw - cO * cw * ci),
    x * sw * si + y * cw * si);
  vec3 p = vec3(ecl.x, ecl.z, -ecl.y) * ${AU_KM.toFixed(1)} + uSunRel; // scene axes, camera-relative
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = 1.5 * uPixelRatio;
  vColor = neo > 0.5 ? vec3(0.95, 0.6, 0.38) : vec3(0.62, 0.66, 0.74);
  // Larger asteroids (smaller H) brighter; the many small near-Earth ones faint.
  vAlpha = clamp(0.9 - (el1.w - 8.0) * 0.08, 0.12, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const pointFragment = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  gl_FragColor = vec4(vColor * vAlpha * uOpacity, 1.0);
}
`;

const cometVertex = /* glsl */ `
uniform float uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = 2.4 * uPixelRatio;
  vColor = vec3(0.5, 0.9, 1.0);
  vAlpha = 1.0;
  #include <logdepthbuf_vertex>
}
`;

export class SmallBodies {
  readonly group = new THREE.Group();
  readonly asteroids: THREE.Points;
  readonly comets: THREE.Points;
  readonly cometOrbits: Orbit[];
  private readonly asteroidMaterial: THREE.ShaderMaterial;
  private readonly cometMaterial: THREE.ShaderMaterial;
  private readonly cometPositions: Float32Array;
  private readonly helio: Vec3 = [0, 0, 0];

  constructor(set: AsteroidSet, readonly cometList: Comet[], pixelRatio: number) {
    const g = new THREE.BufferGeometry();
    const el = set.elements;
    const el0 = new Float32Array(set.count * 4), el1 = new Float32Array(set.count * 4), neo = new Float32Array(set.count);
    for (let k = 0; k < set.count; k++) {
      for (let j = 0; j < 4; j++) {
        el0[k * 4 + j] = el[k * 8 + j];
        el1[k * 4 + j] = el[k * 8 + 4 + j];
      }
      neo[k] = set.flags[k];
    }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(set.count * 3), 3));
    g.setAttribute('el0', new THREE.BufferAttribute(el0, 4));
    g.setAttribute('el1', new THREE.BufferAttribute(el1, 4));
    g.setAttribute('neo', new THREE.BufferAttribute(neo, 1));
    this.asteroidMaterial = new THREE.ShaderMaterial({
      vertexShader: asteroidVertex,
      fragmentShader: pointFragment,
      uniforms: { uDays: { value: 0 }, uSunRel: { value: new THREE.Vector3() }, uPixelRatio: { value: pixelRatio }, uOpacity: { value: 0.45 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.asteroids = new THREE.Points(g, this.asteroidMaterial);
    this.asteroids.frustumCulled = false;
    this.group.add(this.asteroids);

    this.cometOrbits = cometList.map(cometOrbit);
    this.cometPositions = new Float32Array(cometList.length * 3);
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(this.cometPositions, 3));
    this.cometMaterial = new THREE.ShaderMaterial({
      vertexShader: cometVertex,
      fragmentShader: pointFragment,
      uniforms: { uPixelRatio: { value: pixelRatio }, uOpacity: { value: 0.9 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.comets = new THREE.Points(cg, this.cometMaterial);
    this.comets.frustumCulled = false;
    this.group.add(this.comets);
  }

  /**
   * @param days TDB days past J2000.
   * @param sun Sun position (scene axes, km, barycentric, float64).
   * @param eye Camera position, same frame.
   * @param opacity 0 hides the layer.
   */
  update(days: number, sun: Vec3, eye: Vec3, opacity: number): void {
    this.group.visible = opacity > 0.01;
    if (!this.group.visible) return;
    const sunRel = [sun[0] - eye[0], sun[1] - eye[1], sun[2] - eye[2]];
    this.asteroidMaterial.uniforms.uDays.value = days;
    this.asteroidMaterial.uniforms.uSunRel.value.set(sunRel[0], sunRel[1], sunRel[2]);
    this.asteroidMaterial.uniforms.uOpacity.value = 0.45 * opacity;
    this.cometMaterial.uniforms.uOpacity.value = 0.9 * opacity;
    const p = this.cometPositions;
    const h = this.helio;
    for (let k = 0; k < this.cometOrbits.length; k++) {
      orbitPosition(this.cometOrbits[k], days, h);
      // Comets far out (beyond 60 AU) are parked out of view.
      if (h[0] * h[0] + h[1] * h[1] + h[2] * h[2] > (60 * AU_KM) ** 2) {
        p[k * 3] = p[k * 3 + 1] = p[k * 3 + 2] = 1e15;
        continue;
      }
      p[k * 3] = h[0] + sunRel[0];
      p[k * 3 + 1] = h[2] + sunRel[1];
      p[k * 3 + 2] = -h[1] + sunRel[2];
    }
    this.comets.geometry.attributes.position.needsUpdate = true;
  }
}
