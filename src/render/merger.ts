import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { BlackHoleView } from './blackhole';

/**
 * Two black holes lensing the sky. Each pixel's ray is followed back from the camera
 * through the field of both holes, each bending light as a Schwarzschild hole does: in
 * Cartesian coordinates a photon's path obeys x'' = -3 m h^2 x / r^5 (h = |x x x'|),
 * which reproduces the exact Schwarzschild orbits (photon sphere at 3m, shadow 3 sqrt(3) m
 * in impact parameter). The two holes' pulls are added: exact for each hole alone,
 * approximate where both bend a ray strongly. A ray that falls within 2m of a hole is
 * lost (black). Units: the binary's total mass M, the camera at uCam, holes at uHole1/2.
 */
const fragmentShader = /* glsl */ `
precision highp float;
varying vec2 vNdc;
uniform vec2 uTan;
uniform mat3 uViewToScene;
uniform mat3 uSceneToView;
uniform vec3 uCam;
uniform vec4 uHole1;   // position (M), mass (M)
uniform vec4 uHole2;
uniform float uMaxSteps;
uniform sampler2D uView;
uniform samplerCube uSky;

vec3 decode(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 encode(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

vec3 sky(vec3 dir) {
  vec3 v = uSceneToView * dir;
  if (v.z < 0.0) {
    vec2 ndc = v.xy / (-v.z) / uTan;
    if (max(abs(ndc.x), abs(ndc.y)) < 0.985) return texture2D(uView, ndc * 0.5 + 0.5).rgb;
  }
  return textureCube(uSky, dir).rgb;
}

vec3 pull(vec3 x, vec3 v, vec4 hole) {
  vec3 r = x - hole.xyz;
  float d = length(r);
  vec3 hv = cross(r, v);
  return -3.0 * hole.w * dot(hv, hv) * r / (d * d * d * d * d);
}

/** What is left of a hole's bending from here to infinity on a straight line: (2m/b)(1 - cos psi), toward the hole. */
vec3 remainder(vec3 x, vec3 v, vec4 hole) {
  vec3 r = x - hole.xyz;
  vec3 perp = r - dot(r, v) * v;
  float b = max(length(perp), 1e-3);
  float cospsi = dot(normalize(r), v);
  return -(2.0 * hole.w / b) * (1.0 - cospsi) * perp / b;
}

void main() {
  vec3 v = normalize(uViewToScene * vec3(vNdc * uTan, -1.0));
  vec3 x = uCam;
  float escape = max(1.5 * length(uCam), 80.0);
  bool lost = false;
  for (int i = 0; i < 600; i++) {
    if (float(i) >= uMaxSteps) break;
    float r1 = length(x - uHole1.xyz), r2 = length(x - uHole2.xyz);
    if (r1 < 2.0 * uHole1.w || r2 < 2.0 * uHole2.w) { lost = true; break; }
    float rc = length(x);
    if (rc > escape && dot(x, v) > 0.0) break;
    // Fine steps near a hole, coarse ones far off (velocity Verlet: v stays unit).
    float rn = min(r1, r2);
    float ds = clamp(0.05 * rn * rn / (rn + 2.0), 0.002, 8.0);
    vec3 a = pull(x, v, uHole1) + pull(x, v, uHole2);
    vec3 vh = v + 0.5 * ds * a;
    x += ds * vh;
    vec3 a2 = pull(x, normalize(vh), uHole1) + pull(x, normalize(vh), uHole2);
    v = normalize(vh + 0.5 * ds * a2);
  }
  if (lost) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  v = normalize(v + remainder(x, v, uHole1) + remainder(x, v, uHole2));
  gl_FragColor = vec4(encode(decode(sky(v))), 1.0);
}
`;

const vertexShader = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export class BinaryLens {
  /** The Kerr tracer for the final hole; its view and sky textures serve the binary too. */
  readonly kerr = new BlackHoleView();
  private readonly material: THREE.ShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader, depthTest: false, depthWrite: false,
      uniforms: {
        uTan: { value: new THREE.Vector2(1, 1) },
        uViewToScene: { value: new THREE.Matrix3() },
        uSceneToView: { value: new THREE.Matrix3() },
        uCam: { value: new THREE.Vector3() },
        uHole1: { value: new THREE.Vector4() },
        uHole2: { value: new THREE.Vector4() },
        uMaxSteps: { value: 400 },
        uView: { value: this.kerr.view.texture },
        uSky: { value: this.kerr.sky.texture },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  setQuality(level: 'high' | 'normal' | 'low'): void {
    this.kerr.setQuality(level);
    this.material.uniforms.uMaxSteps.value = level === 'high' ? 600 : level === 'normal' ? 400 : 220;
  }

  /**
   * @param cam camera minus the centre of mass, scene axes, units of M
   * @param holes positions (M, scene axes) and masses (M)
   */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, cam: Vec3, holes: Array<[Vec3, number]>): void {
    const u = this.material.uniforms;
    const tanY = Math.tan((camera.fov * Math.PI) / 360);
    u.uTan.value.set(tanY * camera.aspect, tanY);
    const viewToScene = new THREE.Matrix3().setFromMatrix4(camera.matrixWorld);
    u.uViewToScene.value.copy(viewToScene);
    u.uSceneToView.value.copy(viewToScene).transpose();
    u.uCam.value.set(...cam);
    u.uHole1.value.set(...holes[0][0], holes[0][1]);
    u.uHole2.value.set(...holes[1][0], holes[1][1]);
    renderer.render(this.scene, this.quadCamera);
  }
}

/**
 * The gravitational waves made visible: a sheet in the orbital plane, lifted by the
 * wave's h+ at each point's retarded time (what left the binary r/c earlier), so the
 * two-armed spiral moves outward at the speed of light and tightens as the holes
 * close in. The pattern (phase, frequency, how amplitude grows) is the computed one;
 * the height is exaggerated by a huge factor, as no sheet could show a strain of 10^-21,
 * and falls off as r^-1/2 rather than the true 1/r so the outer ripples still show.
 */
const gridVertex = /* glsl */ `
uniform sampler2D uWave;   // r: amplitude (relative to the peak), g: phase lag behind now (radians)
uniform float uSpan;       // radius of the sheet (M)
uniform float uLift;       // height at full amplitude (M)
uniform float uScale;      // km per M
varying vec2 vPolar;
varying float vH;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  // position.xy: (r / uSpan, phi / 2 pi).
  float r = position.x * uSpan;
  float phi = position.y * 6.2831853;
  vec4 w = texture2D(uWave, vec2(position.x, 0.5));
  // h+ in the orbital plane: cos(2 phi - Phi(t - r/c)).
  float h = w.r * cos(2.0 * phi - w.g) * min(1.0, 6.0 / max(r, 1.0)) * sqrt(max(r, 1.0) / 6.0);
  vH = h;
  vPolar = vec2(r, phi);
  vec3 p = vec3(r * cos(phi), r * sin(phi), h * uLift) * uScale;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const gridFragment = /* glsl */ `
uniform float uOpacity;
uniform float uSpan;
varying vec2 vPolar;
varying float vH;
#include <common>
#include <logdepthbuf_pars_fragment>
float line(float x, float spacing) {
  float f = abs(fract(x / spacing + 0.5) - 0.5) * spacing;
  float w = fwidth(x) * 1.2;
  return 1.0 - smoothstep(0.0, w, f);
}
void main() {
  #include <logdepthbuf_fragment>
  float g = max(line(vPolar.x, uSpan / 40.0), 0.6 * line(vPolar.y, 6.2831853 / 36.0));
  // Faded out toward the edge, and inside the orbit where the holes are.
  float fade = (1.0 - smoothstep(0.75 * uSpan, uSpan, vPolar.x)) * smoothstep(6.0, 16.0, vPolar.x);
  vec3 c = mix(vec3(0.25, 0.45, 1.0), vec3(0.6, 0.85, 1.0), clamp(0.5 + vH, 0.0, 1.0));
  gl_FragColor = vec4(c * g * fade * uOpacity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class WaveSheet {
  readonly mesh: THREE.Mesh;
  private readonly texture: THREE.DataTexture;
  readonly samples = 512;
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    const radial = 240, around = 192;
    const geometry = new THREE.PlaneGeometry(1, 1, radial, around);
    // Map the plane's (x, y) in [-0.5, 0.5] to (r fraction, phi fraction) in [0, 1], r bunched near the middle.
    const p = geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) + 0.5;
      p.setXY(i, 0.004 + 0.996 * u * u, p.getY(i) + 0.5);
    }
    this.texture = new THREE.DataTexture(new Float32Array(this.samples * 4), this.samples, 1, THREE.RGBAFormat, THREE.FloatType);
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
    this.material = new THREE.ShaderMaterial({
      vertexShader: gridVertex, fragmentShader: gridFragment,
      uniforms: { uWave: { value: this.texture }, uSpan: { value: 400 }, uLift: { value: 12 }, uScale: { value: 1 }, uOpacity: { value: 0.32 } },
      side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      extensions: { derivatives: true } as never,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  get uniforms() {
    return this.material.uniforms;
  }

  /**
   * @param wave amplitude (relative) and phase at each sample's retarded time: sample k is
   * the wave at radius (k / (samples - 1)) * span, i.e. emitted (that radius / c) ago.
   */
  setWave(amp: Float32Array, phase: Float32Array): void {
    const d = this.texture.image.data as Float32Array;
    for (let k = 0; k < this.samples; k++) {
      d[k * 4] = amp[k];
      d[k * 4 + 1] = phase[k];
    }
    this.texture.needsUpdate = true;
  }
}
