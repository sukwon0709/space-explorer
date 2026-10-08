import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { icrfToScene } from '../core/frames';
import { REDDENING } from '../core/stars';
import { FLAG_IMAGE, FLAG_SPHEROID, type GalaxyBlock } from '../core/galaxies';
import { RELATIVITY_GLSL, relativityUniforms } from './relativity';

/**
 * Shared GLSL: a galaxy's apparent brightness, colour and orientation from the packed
 * catalogue attributes (see core/galaxies.ts for the codes).
 */
const COMMON = /* glsl */ `
attribute float absMag;
attribute float radius;
attribute float axis;
attribute float angle;
attribute float colour;
attribute float ebv;
attribute float flags;
uniform vec3 uCamHigh;
uniform vec3 uCamLow;
uniform mat3 uIcrfToScene;
uniform float uMsat;
uniform float uSigma;
uniform float uPixelsPerRadian;
uniform float uPixelRatio;
uniform float uBrightness;
uniform float uExtBlend;
varying vec3 vColor;
${RELATIVITY_GLSL}

vec3 kelvinToRgb(float kelvin) {
  float t = clamp(kelvin, 1000.0, 40000.0) / 100.0;
  float r = t <= 66.0 ? 255.0 : 329.698727446 * pow(t - 60.0, -0.1332047592);
  float g = t <= 66.0 ? 99.4708025861 * log(t) - 161.1195681661 : 288.1221695283 * pow(t - 60.0, -0.0755148492);
  float b = t >= 66.0 ? 255.0 : (t <= 19.0 ? 0.0 : 138.5177312231 * log(t - 10.0) - 305.0447927307);
  vec3 srgb = clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
  return mix(srgb / 12.92, pow((srgb + 0.055) / 1.055, vec3(2.4)), step(0.04045, srgb));
}

// Camera-relative position (Mpc), with the camera split in two float32 parts.
vec3 relative() { return (position - uCamHigh) - uCamLow; }

// Peak brightness of the galaxy as a point (1 saturates), and its colour. Seen from a
// ship moving near light speed (Doppler factor D), its light is that of a blackbody at
// D times its colour temperature: this is the gain in surface brightness (a point also
// shrinks by D in each direction, which the caller applies).
float galaxyFlux(float d, float D, out vec3 color) {
  float av = 3.1 * ebv * 0.01 * uExtBlend;
  float m = (absMag * 0.1 - 26.0) + 5.0 * log2(d * 1e5) * 0.30102999566 + av;
  float bv = colour / 200.0;
  // Ballesteros (2012): B-V to a blackbody temperature.
  float teff = 4600.0 * (1.0 / (0.92 * bv + 1.7) + 1.0 / (0.92 * bv + 0.62));
  vec3 c = kelvinToRgb(teff * D) * exp2(-1.3287712 * av * (vec3(${REDDENING.join(', ')}) - 1.0));
  color = c / dot(c, vec3(0.2126, 0.7152, 0.0722));
  return exp2(-1.3287712 * (m - uMsat)) * uBrightness * surfaceGainV(D, teff);
}

// Scale radius (Mpc) and its size on screen in device pixels.
float scaleRadius() { return 5e-5 * exp2(radius / 60.0 * 3.321928); }
`;

const ENCODE = /* glsl */ `
vec4 encode(vec3 c) {
  c = min(c, 1.0);
  return vec4(mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)), 1.0);
}
`;

const pointVertex = /* glsl */ `
${COMMON}
varying float vPeak;
varying float vSigma;
varying float vSize;
void main() {
  vec3 rel = relative();
  float d = length(rel);
  vec4 view = modelViewMatrix * vec4(uIcrfToScene * (rel / max(d, 1e-30)), 0.0);
  float D = dopplerRest(normalize(view.xyz));
  vec3 color;
  float flux = galaxyFlux(d, D, color) / (D * D);
  float hPx = scaleRadius() / d * uPixelsPerRadian * uPixelRatio / D;
  // Resolved galaxies are drawn as discs instead (render the same light).
  float point = 1.0 - smoothstep(0.6, 1.6, hPx);
  float peak = min(flux, 1.0) * point;
  if (peak < 1.0 / 1600.0 || d < 1e-9) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  view.xyz = aberrateDir(normalize(view.xyz));
  gl_Position = projectionMatrix * vec4(view.xyz, 1.0);
  gl_Position.z = gl_Position.w * 0.999999;
  float sigma = uSigma * uPixelRatio * min(pow(max(flux * point * 33.0, 1.0), 0.3), 8.0);
  vColor = color;
  vPeak = peak;
  vSigma = sigma;
  vSize = min(2.0 * ceil(3.0 * sigma) + 1.0, 255.0);
  gl_PointSize = vSize;
}
`;

const pointFragment = /* glsl */ `
varying vec3 vColor;
varying float vPeak;
varying float vSigma;
varying float vSize;
${ENCODE}
void main() {
  vec2 p = (gl_PointCoord - 0.5) * vSize;
  vec3 c = vColor * vPeak * exp(-0.5 * dot(p, p) / (vSigma * vSigma));
  if (max(c.r, max(c.g, c.b)) < 1.0 / 2048.0) discard;
  gl_FragColor = encode(c);
}
`;

const discVertex = /* glsl */ `
${COMMON}
attribute vec2 corner;
varying vec2 vUv;
varying float vScale;
varying float vSpheroid;
const float EXTENT = 5.0;
void main() {
  vec3 rel = relative();
  float d = length(rel);
  vec4 centre = modelViewMatrix * vec4(uIcrfToScene * (rel / d), 0.0);
  float D = dopplerRest(normalize(centre.xyz));
  vec3 color;
  // The disc keeps its surface brightness gain; its area shrinks by D^2 as it is drawn.
  float flux = galaxyFlux(d, D, color);
  float h = scaleRadius();
  float hPx0 = h / d * uPixelsPerRadian * uPixelRatio;
  float hPx = hPx0 / D;
  float disc = smoothstep(0.6, 1.6, hPx);
  bool spheroid = mod(floor(flags / ${FLAG_SPHEROID.toFixed(1)}), 2.0) > 0.5;
  bool image = mod(floor(flags / ${FLAG_IMAGE.toFixed(1)}), 2.0) > 0.5;
  if (disc * flux < 1e-4 || image || flags >= 128.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // The galaxy's axes from where Earth sees it: position angle east of north, and the
  // inclination from the axis ratio (an oblate disc with intrinsic thickness 0.2).
  vec3 s = normalize(position);
  vec3 east = normalize(vec3(-s.y, s.x, 0.0) + vec3(1e-9, 0.0, 0.0));
  vec3 north = cross(s, east);
  float pa = angle * ${(Math.PI / 256).toFixed(8)};
  vec3 major = cos(pa) * north + sin(pa) * east;
  vec3 minorSky = -sin(pa) * north + cos(pa) * east;
  float q = axis / 255.0;
  float cosI = sqrt(clamp((q * q - 0.04) / 0.96, 0.0, 1.0));
  vec3 view = rel / d;
  vec3 a, b;
  float tilt = 1.0;
  if (spheroid) {
    // A spheroid looks the same from every side: a camera-facing ellipse.
    a = normalize(major - dot(major, view) * view + vec3(0.0, 0.0, 1e-9));
    b = cross(view, a) * q;
  } else {
    vec3 n = -cosI * s + sqrt(1.0 - cosI * cosI) * minorSky;
    a = major;
    b = cross(n, a);
    // A thin disc seen at a slant packs more light into each pixel.
    tilt = max(abs(dot(n, view)), 0.15);
  }
  vec3 p = rel + EXTENT * h * (corner.x * a + corner.y * b);
  // Shrink the whole quad toward the camera (the picture is unchanged) to keep the
  // numbers inside the projection's range.
  vec3 scene = uIcrfToScene * (p * (1e6 / d));
  vec4 mv = relativistic(modelViewMatrix * vec4(scene, 1.0));
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.999999;
  vColor = color;
  vUv = corner * EXTENT;
  vSpheroid = spheroid ? 1.0 : 0.0;
  // Value per unit of the normalised profile: the same total light as the point would
  // have (flux times 2 pi sigma^2), spread over the profile.
  float sigma = uSigma * uPixelRatio;
  // (Per unit of the unshifted profile: the quad itself is drawn D times smaller.)
  vScale = flux * disc * 6.2831853 * sigma * sigma / (hPx0 * hPx0 * tilt);
}
`;

const discFragment = /* glsl */ `
varying vec3 vColor;
varying vec2 vUv;
varying float vScale;
varying float vSpheroid;
const float EXTENT = 5.0;
${ENCODE}
void main() {
  float r2 = dot(vUv, vUv);
  // Exponential disc, or a Plummer sphere, each normalised to unit total light.
  float profile = vSpheroid > 0.5 ? 0.31830989 / ((1.0 + r2) * (1.0 + r2)) : exp(-sqrt(r2)) * 0.15915494;
  // Fade to nothing at the quad's edge rather than stopping short.
  profile *= 1.0 - smoothstep(0.6 * EXTENT * EXTENT, EXTENT * EXTENT, r2);
  vec3 c = vColor * vScale * profile;
  if (max(c.r, max(c.g, c.b)) < 1.0 / 2048.0) discard;
  gl_FragColor = encode(c);
}
`;

const ATTRIBUTES = ['absMag', 'radius', 'axis', 'angle', 'colour', 'ebv', 'flags'] as const;

/**
 * Catalogue galaxies: points while they are too small to resolve, inclined discs (or
 * spheroids) with their measured size, shape and orientation once they are not.
 */
export class GalaxyLayer {
  readonly group = new THREE.Group();
  readonly uniforms: Record<string, THREE.IUniform>;
  private readonly pointMaterial: THREE.ShaderMaterial;
  private readonly discMaterial: THREE.ShaderMaterial;
  private readonly flagAttributes: THREE.BufferAttribute[][] = [];

  constructor(pixelRatio: number) {
    const icrfToScene = new THREE.Matrix3();
    const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => icrfToScene3(v as Vec3));
    icrfToScene.set(cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]);
    this.uniforms = {
      uCamHigh: { value: new THREE.Vector3() },
      uCamLow: { value: new THREE.Vector3() },
      uIcrfToScene: { value: icrfToScene },
      uMsat: { value: 5 },
      uSigma: { value: 0.75 },
      uPixelsPerRadian: { value: 800 },
      uPixelRatio: { value: pixelRatio },
      uBrightness: { value: 1 },
      uExtBlend: { value: 1 },
      ...relativityUniforms,
    };
    const common = { blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: false, side: THREE.DoubleSide };
    this.pointMaterial = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: pointVertex, fragmentShader: pointFragment, ...common });
    this.discMaterial = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: discVertex, fragmentShader: discFragment, ...common });
    this.group.renderOrder = -12;
  }

  /** Add a block of galaxies (both as points and as discs). */
  add(block: GalaxyBlock): void {
    const points = new THREE.BufferGeometry();
    points.setAttribute('position', new THREE.BufferAttribute(block.position, 3));
    const discs = new THREE.InstancedBufferGeometry();
    discs.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    discs.setIndex([0, 1, 2, 0, 2, 3]);
    discs.setAttribute('position', new THREE.InstancedBufferAttribute(block.position, 3));
    discs.instanceCount = block.count;
    for (const name of ATTRIBUTES) {
      points.setAttribute(name, new THREE.BufferAttribute(block[name], 1));
      discs.setAttribute(name, new THREE.InstancedBufferAttribute(block[name], 1));
    }
    this.flagAttributes.push([points.getAttribute('flags') as THREE.BufferAttribute, discs.getAttribute('flags') as THREE.BufferAttribute]);
    for (const [g, m] of [[points, this.pointMaterial], [discs, this.discMaterial]] as const) {
      const object = g instanceof THREE.InstancedBufferGeometry ? new THREE.Mesh(g, m) : new THREE.Points(g, m);
      object.frustumCulled = false;
      object.renderOrder = -12;
      this.group.add(object);
    }
  }

  /**
   * Galaxy `i` of block `k` is drawn from a telescope image once resolved (render/images.ts):
   * it stays a point while it is too small to resolve, and no longer becomes a model disc.
   */
  markImage(block: GalaxyBlock, k: number, i: number): void {
    block.flags[i] |= FLAG_IMAGE;
    for (const a of this.flagAttributes[k] ?? []) a.needsUpdate = true;
  }

  /**
   * @param camera barycentric ICRS position of the camera, Mpc (float64).
   * @param msat magnitude of a point that just saturates.
   */
  update(camera: Vec3, msat: number, pixelsPerRadian: number, brightness: number, extinction: number): void {
    const u = this.uniforms;
    const high = camera.map((c) => Math.fround(c)) as Vec3;
    u.uCamHigh.value.set(high[0], high[1], high[2]);
    u.uCamLow.value.set(camera[0] - high[0], camera[1] - high[1], camera[2] - high[2]);
    u.uMsat.value = msat;
    u.uPixelsPerRadian.value = pixelsPerRadian;
    u.uBrightness.value = brightness;
    u.uExtBlend.value = extinction;
  }
}

function icrfToScene3(v: Vec3): Vec3 {
  return icrfToScene(v, [0, 0, 0]);
}
