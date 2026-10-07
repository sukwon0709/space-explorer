import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { icrfToScene } from '../core/frames';

/** One telescope image (data/images/index.json, from pipeline/fetch_images.py). */
export interface SkyImage {
  name: string;
  kind: string;
  /** Centre, degrees (J2000), and the image's width on the sky, degrees. */
  ra: number;
  dec: number;
  fov: number;
  /** The picture, absent for a nebula `within` a galaxy's own picture. */
  file?: string;
  /** Mean linear pixel value per channel (after squaring the stored value). */
  mean?: [number, number, number];
  aka?: string[];
  /** Nebulae: distance (pc), its source, and the integrated V magnitude. */
  dist?: number;
  source?: string;
  V?: number;
  /** A nebula already in this galaxy's own image (it is a target, but not drawn again). */
  within?: string;
  /** Nested close-up pictures, each inside the previous one (pipeline/build_nebula_detail.py). */
  detail?: DetailImage[];
}

/** A close-up picture inside a nebula's picture, matched to it at the parent's resolution. */
export interface DetailImage {
  file: string;
  ra: number;
  dec: number;
  fov: number;
  /** Pixels across, and arcseconds per pixel. */
  px: number;
  arcsec: number;
  /** Stored value squared, times this, is in the whole-field picture's linear units. */
  gain: number;
  /** Real survey data, or AI-enhanced (Real-ESRGAN, back-projected onto its parent). */
  kind: 'survey' | 'ai';
  /** What the close-up shows, and where its pixels come from. */
  what: string;
  source: string;
  /** Mean residual against the parent after back-projection (relative). */
  match: number;
}

/** Which picture of a nebula the camera mostly sees. */
export type Shown = 'none' | 'plates' | 'survey' | 'ai';

/** Where an image is and how it is drawn, worked out by the caller (DeepSky). */
export interface ImagePlacement {
  /** Barycentric ICRS centre, Mpc. */
  centre: Vec3;
  /** The object's distance from the Sun, Mpc (the image's angular scale holds there). */
  distance: number;
  /** Apparent magnitude of the whole object from a camera `d` Mpc away. */
  magnitude: (d: number) => number;
  /** Scale radius (Mpc) where the catalogue's own point or disc hands over to the image. */
  handover?: number;
}

const vertexShader = /* glsl */ `
attribute vec2 corner;
uniform vec3 uRel;
uniform vec3 uA;
uniform vec3 uB;
uniform vec2 uHalf;
uniform mat3 uIcrfToScene;
varying vec2 vUv;
void main() {
  vec3 off = corner.x * uHalf.x * uA + corner.y * uHalf.y * uB;
  vUv = vec2(0.5 - 0.5 * corner.x, 0.5 + 0.5 * corner.y);
  vec3 p = uRel + off;
  // Shrink toward the camera (the picture is unchanged) to stay inside the projection's range.
  vec3 scene = uIcrfToScene * (p * (1e6 / max(length(uRel), 1e-12)));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(scene, 1.0);
  gl_Position.z = gl_Position.w * 0.999999;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uTex;
uniform float uScale;
// A close-up drawn over this picture: its centre and half size in this picture's uv, and
// how much it has taken over. Both use the same feathered edge, so they add up to one.
uniform vec4 uHole;
uniform float uHoleW;
// A close-up fades out toward its own edge.
uniform float uEdge;
varying vec2 vUv;
float feather(vec2 q) {
  return smoothstep(1.0, 0.6, max(abs(q.x), abs(q.y)));
}
void main() {
  if (vUv.x < 0.0 || vUv.y < 0.0 || vUv.x > 1.0 || vUv.y > 1.0) discard;
  float w = 1.0;
  if (uEdge > 0.5) w *= feather(2.0 * vUv - 1.0);
  if (uHoleW > 0.0) w *= 1.0 - uHoleW * feather((vUv - uHole.xy) / uHole.zw);
  vec3 t = texture2D(uTex, vUv).rgb;
  // Clip before blending, so that a saturated picture and its close-up still add up to one.
  vec3 c = min(t * t * uScale, 1.0);
  if (max(c.r, max(c.g, c.b)) * w < 1.0 / 2048.0) discard;
  // The pictures add up after encoding, so the weights apply to the encoded colour: a
  // picture and its close-up then blend to the same value where they agree (weighting
  // before encoding would brighten the seam, up to 1.46 times where both weigh a half).
  gl_FragColor = vec4(mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)) * w, 1.0);
}
`;

/** One picture drawn as a camera-facing quad: the whole field, or a close-up inside it. */
interface Layer {
  file: string;
  mesh: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  /** Close-ups: offset from the whole-field centre (radians east and north), size, gain. */
  east: number;
  north: number;
  fov: number;
  px: number;
  gain: number;
  kind: 'plates' | 'survey' | 'ai';
  /** How much of the parent this layer currently replaces (close-ups), 0..1. */
  weight: number;
}

interface Item {
  image: SkyImage;
  place: ImagePlacement;
  /** The whole-field picture, then each close-up inside the one before. */
  layers: Layer[];
  meanLuma: number;
  onReady?: () => void;
}

/**
 * Telescope images of the bright nebulae, as camera-facing pictures (which is how Earth
 * sees them; the nearest galaxies are 3D models, render/galaxymodels.ts). Each is scaled
 * so that its total light equals the object's catalogue magnitude, on the same scale as
 * the galaxy layer.
 */
export class ImageLayer {
  readonly group = new THREE.Group();
  private readonly items: Item[] = [];
  private readonly geometry = new THREE.BufferGeometry();
  private readonly icrfToScene = new THREE.Matrix3();
  private readonly loader = new THREE.TextureLoader();

  constructor(private readonly baseUrl: string, private readonly anisotropy: number, private readonly pixelRatio: number) {
    this.geometry.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    // Positions are worked out in the shader; the attribute only gives three.js a count.
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => icrfToScene(v as Vec3, [0, 0, 0]));
    this.icrfToScene.set(cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]);
    this.group.renderOrder = -11;
  }

  /** Add an image; `onReady` runs once its texture has loaded (the catalogue then stops drawing the object itself). */
  add(image: SkyImage, place: ImagePlacement, onReady?: () => void): void {
    const ra = (image.ra * Math.PI) / 180, dec = (image.dec * Math.PI) / 180;
    const s: Vec3 = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
    const east = normalise([-s[1] + 1e-12, s[0], 0]);
    const north = cross(s, east);
    const layers: Layer[] = [this.layer(image.file!, north, 0, 0, image.fov, 0, 1, 'plates')];
    for (const d of image.detail ?? []) {
      // Offset of the close-up's centre on the sky (gnomonic, about the picture's centre).
      const r = (d.ra * Math.PI) / 180, q = (d.dec * Math.PI) / 180;
      const c = Math.sin(dec) * Math.sin(q) + Math.cos(dec) * Math.cos(q) * Math.cos(r - ra);
      const x = (Math.cos(q) * Math.sin(r - ra)) / c;
      const y = (Math.cos(dec) * Math.sin(q) - Math.sin(dec) * Math.cos(q) * Math.cos(r - ra)) / c;
      layers.push(this.layer(d.file, north, x, y, d.fov, d.px, d.gain, d.kind));
    }
    const [r, g, b] = image.mean ?? [1, 1, 1];
    this.items.push({ image, place, layers, meanLuma: 0.2126 * r + 0.7152 * g + 0.0722 * b, onReady });
  }

  private layer(file: string, north: Vec3, east: number, northOff: number, fov: number, px: number, gain: number, kind: Layer['kind']): Layer {
    const uniforms: Record<string, THREE.IUniform> = {
      uRel: { value: new THREE.Vector3() },
      uA: { value: new THREE.Vector3() },
      uB: { value: new THREE.Vector3() },
      uHalf: { value: new THREE.Vector2() },
      uNorth: { value: new THREE.Vector3(...north) },
      uIcrfToScene: { value: this.icrfToScene },
      uTex: { value: null },
      uScale: { value: 0 },
      uHole: { value: new THREE.Vector4(0.5, 0.5, 1, 1) },
      uHoleW: { value: 0 },
      uEdge: { value: kind === 'plates' ? 0 : 1 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms, vertexShader, fragmentShader,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -11;
    mesh.visible = false;
    this.group.add(mesh);
    return { file, mesh, uniforms, state: 'idle', east, north: northOff, fov, px, gain, kind, weight: 0 };
  }

  /** Which of a nebula's pictures the camera now mostly sees. */
  shown(name: string): { kind: Shown; detail?: DetailImage } {
    const item = this.items.find((i) => i.image.name === name);
    if (!item || !item.layers.some((l) => l.mesh.visible)) return { kind: 'none' };
    let k = 0;
    for (let j = 1; j < item.layers.length; j++) if (item.layers[j].mesh.visible && item.layers[j].weight > 0.5) k = j;
    return k === 0 ? { kind: 'plates' } : { kind: item.layers[k].kind as Shown, detail: item.image.detail![k - 1] };
  }

  /**
   * @param camera barycentric ICRS camera position, Mpc.
   * @param msat magnitude of a point that just saturates (the galaxy layer's).
   * @param pointLight a saturating point's total light in device-pixel values (2 pi sigma^2).
   */
  update(camera: Vec3, msat: number, pixelsPerRadian: number, brightness: number, pointLight: number): void {
    const ppr = pixelsPerRadian * this.pixelRatio;
    for (const item of this.items) {
      const { place, image, layers } = item;
      const base = layers[0];
      const rel: Vec3 = [place.centre[0] - camera[0], place.centre[1] - camera[1], place.centre[2] - camera[2]];
      const d = Math.hypot(rel[0], rel[1], rel[2]);
      const half = (((image.fov * Math.PI) / 180) * place.distance) / 2;
      const sizePx = ((2 * half) / Math.max(d, 1e-12)) * ppr;
      const flux = 10 ** (-0.4 * (place.magnitude(d) - msat)) * brightness;
      // Hand over from the catalogue's own drawing as the object resolves.
      const handover = place.handover ? smoothstep(0.6, 1.6, (place.handover / d) * ppr) : smoothstep(2, 6, sizePx);
      // Loaded once it resolves, even from inside it (its close-ups build on it).
      if (handover > 0 && flux * handover > 1e-5 && base.state === 'idle') this.load(item, base, true);
      // Surface brightness, the same for every layer (each stores the whole picture's units).
      const scale0 = (flux * pointLight) / (item.meanLuma * sizePx * sizePx);
      const view: Vec3 = [rel[0] / d, rel[1] / d, rel[2] / d];
      const n = base.uniforms.uNorth.value as THREE.Vector3;
      const north = normalise(sub([n.x, n.y, n.z], scale(view, n.x * view[0] + n.y * view[1] + n.z * view[2])));
      const a = cross(north, view), b = north;
      // Close-ups: each takes over from its parent as the parent's pixels grow past a screen
      // pixel. Where they sit and how much they have taken over:
      const rad = Math.PI / 180;
      const geo = layers.map((L, j) => {
        const h = j === 0 ? half : (L.fov * rad * place.distance) / 2;
        const r: Vec3 = j === 0 ? rel : [
          rel[0] + place.distance * (L.east * a[0] + L.north * b[0]),
          rel[1] + place.distance * (L.east * a[1] + L.north * b[1]),
          rel[2] + place.distance * (L.east * a[2] + L.north * b[2]),
        ];
        return { h, r, d: Math.hypot(r[0], r[1], r[2]) };
      });
      base.weight = base.state === 'ready' ? 1 : 0;
      let inner = { h: half, d };
      for (let j = 1; j < layers.length; j++) {
        const L = layers[j], parent = layers[j - 1];
        const parentTexel = ((2 * geo[j - 1].h) / Math.max(d, 1e-12)) * ppr / Math.max(parent.px, 1);
        const ok = parent.weight > 0 && parent.state === 'ready' && handover * flux > 1e-5;
        if (ok && parentTexel > 0.5 && L.state === 'idle') this.load(item, L, false);
        L.weight = ok && L.state === 'ready' ? smoothstep(0.8, 1.6, parentTexel) : 0;
        if (L.weight > 0.5) inner = geo[j];
      }
      // Fade out from inside (a picture has no inside): measured against the innermost
      // close-up in use, so flying in to it keeps the whole picture, with no seams.
      const fade = handover * smoothstep(0.6, 1.5, inner.d / inner.h);
      const wanted = fade > 0 && flux * fade > 1e-5;
      for (let j = 0; j < layers.length; j++) {
        const L = layers[j];
        L.mesh.visible = wanted && L.weight > 0;
        const child = layers[j + 1];
        const u = L.uniforms;
        if (child) {
          (u.uHole.value as THREE.Vector4).set(
            0.5 - (child.east - L.east) / (L.fov * rad), 0.5 + (child.north - L.north) / (L.fov * rad),
            child.fov / (2 * L.fov), child.fov / (2 * L.fov));
          u.uHoleW.value = wanted ? child.weight : 0;
        }
        if (L.mesh.visible) this.place(L, geo[j].r, geo[j].h, a, b, scale0 * L.gain * fade);
      }
    }
  }

  private place(L: Layer, rel: Vec3, half: number, a: Vec3, b: Vec3, uScale: number): void {
    const u = L.uniforms;
    u.uHalf.value.set(half, half);
    u.uRel.value.set(rel[0], rel[1], rel[2]);
    u.uA.value.set(a[0], a[1], a[2]);
    u.uB.value.set(b[0], b[1], b[2]);
    u.uScale.value = uScale;
  }

  private load(item: Item, L: Layer, first: boolean): void {
    L.state = 'loading';
    this.loader.loadAsync(`${this.baseUrl}${L.file}`).then((tex) => {
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = this.anisotropy;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      L.uniforms.uTex.value = tex;
      if (!L.px) L.px = (tex.image as { width: number }).width;
      L.state = 'ready';
      if (first) item.onReady?.();
    }).catch((err) => {
      L.state = 'failed';
      console.warn(`image ${L.file}:`, err);
    });
  }
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalise = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
