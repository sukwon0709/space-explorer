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
  file: string;
  /** Mean linear pixel value per channel (after squaring the stored value). */
  mean: [number, number, number];
  aka?: string[];
  /** Nebulae: distance (pc), its source, and the integrated V magnitude. */
  dist?: number;
  source?: string;
  V?: number;
  /** A nebula already in this galaxy's own image (it is a target, but not drawn again). */
  within?: string;
}

/** Where an image is and how it is drawn, worked out by the caller (DeepSky). */
export interface ImagePlacement {
  /** Barycentric ICRS centre, Mpc. */
  centre: Vec3;
  /** The object's distance from the Sun, Mpc (the image's angular scale holds there). */
  distance: number;
  /**
   * A disc galaxy is laid in its own plane (the image deprojected), with these axes
   * (ICRS); anything else faces the camera, north up as seen from Earth.
   */
  disc?: { major: Vec3; normal: Vec3; cosI: number };
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
uniform vec3 uEast;
uniform vec3 uNorth;
uniform float uSkyScale;
uniform float uDisc;
uniform mat3 uIcrfToScene;
varying vec2 vUv;
void main() {
  vec3 off = corner.x * uHalf.x * uA + corner.y * uHalf.y * uB;
  // A disc's image is where each point of the disc appears on Earth's sky (east left).
  vUv = uDisc > 0.5
    ? vec2(0.5 - dot(off, uEast) * uSkyScale, 0.5 + dot(off, uNorth) * uSkyScale)
    : vec2(0.5 - 0.5 * corner.x, 0.5 + 0.5 * corner.y);
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
varying vec2 vUv;
void main() {
  if (vUv.x < 0.0 || vUv.y < 0.0 || vUv.x > 1.0 || vUv.y > 1.0) discard;
  vec3 t = texture2D(uTex, vUv).rgb;
  vec3 c = min(t * t * uScale, 1.0);
  if (max(c.r, max(c.g, c.b)) < 1.0 / 2048.0) discard;
  gl_FragColor = vec4(mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)), 1.0);
}
`;

interface Item {
  image: SkyImage;
  place: ImagePlacement;
  mesh: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  meanLuma: number;
  onReady?: () => void;
}

/**
 * Telescope images of the nearest galaxies and the bright nebulae: disc galaxies laid in
 * their own planes, so they can be flown around; nebulae and elliptical galaxies as
 * camera-facing pictures, which is how Earth sees them. Each is scaled so that its total
 * light equals the object's catalogue magnitude, on the same scale as the galaxy layer.
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
    const uniforms: Record<string, THREE.IUniform> = {
      uRel: { value: new THREE.Vector3() },
      uA: { value: new THREE.Vector3() },
      uB: { value: new THREE.Vector3() },
      uHalf: { value: new THREE.Vector2() },
      uEast: { value: new THREE.Vector3(...east) },
      uNorth: { value: new THREE.Vector3(...north) },
      uSkyScale: { value: 1 / (((image.fov * Math.PI) / 180) * place.distance) },
      uDisc: { value: place.disc ? 1 : 0 },
      uIcrfToScene: { value: this.icrfToScene },
      uTex: { value: null },
      uScale: { value: 0 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms, vertexShader, fragmentShader,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: false,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -11;
    mesh.visible = false;
    this.group.add(mesh);
    const [r, g, b] = image.mean;
    this.items.push({ image, place, mesh, uniforms, state: 'idle', meanLuma: 0.2126 * r + 0.7152 * g + 0.0722 * b, onReady });
  }

  /**
   * @param camera barycentric ICRS camera position, Mpc.
   * @param msat magnitude of a point that just saturates (the galaxy layer's).
   * @param pointLight a saturating point's total light in device-pixel values (2 pi sigma^2).
   */
  update(camera: Vec3, msat: number, pixelsPerRadian: number, brightness: number, pointLight: number): void {
    const ppr = pixelsPerRadian * this.pixelRatio;
    for (const item of this.items) {
      const { place, uniforms: u, image } = item;
      const rel: Vec3 = [place.centre[0] - camera[0], place.centre[1] - camera[1], place.centre[2] - camera[2]];
      const d = Math.hypot(rel[0], rel[1], rel[2]);
      const half = (((image.fov * Math.PI) / 180) * place.distance) / 2;
      const sizePx = ((2 * half) / Math.max(d, 1e-12)) * ppr;
      const flux = 10 ** (-0.4 * (place.magnitude(d) - msat)) * brightness;
      // Hand over from the catalogue's own drawing as the object resolves, and fade out
      // from inside (a picture has no inside).
      const handover = place.handover ? smoothstep(0.6, 1.6, (place.handover / d) * ppr) : smoothstep(2, 6, sizePx);
      const fade = handover * smoothstep(0.6, 1.5, d / half);
      const wanted = fade > 0 && flux * fade > 1e-5;
      if (wanted && item.state === 'idle') this.load(item);
      item.mesh.visible = wanted && item.state === 'ready';
      if (!item.mesh.visible) continue;
      const view: Vec3 = [rel[0] / d, rel[1] / d, rel[2] / d];
      let tilt = 1;
      let a: Vec3, b: Vec3;
      if (place.disc) {
        const { major, normal, cosI } = place.disc;
        a = major;
        b = cross(normal, major);
        const k = Math.max(cosI, 0.25);
        u.uHalf.value.set(half, half / k);
        // Spread over the disc the image's light covers k times the sky area; seen at a
        // slant it covers |n . view| of that on screen.
        tilt = Math.max(Math.abs(dot(normal, view)), 0.15) / k;
      } else {
        const n = u.uNorth.value as THREE.Vector3;
        const north = normalise(sub([n.x, n.y, n.z], scale(view, n.x * view[0] + n.y * view[1] + n.z * view[2])));
        a = cross(north, view);
        b = north;
        u.uHalf.value.set(half, half);
      }
      u.uRel.value.set(rel[0], rel[1], rel[2]);
      u.uA.value.set(a[0], a[1], a[2]);
      u.uB.value.set(b[0], b[1], b[2]);
      const area = sizePx * sizePx * tilt;
      u.uScale.value = (flux * pointLight * fade) / (item.meanLuma * area);
    }
  }

  private load(item: Item): void {
    item.state = 'loading';
    this.loader.loadAsync(`${this.baseUrl}${item.image.file}`).then((tex) => {
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = this.anisotropy;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      item.uniforms.uTex.value = tex;
      item.state = 'ready';
      item.onReady?.();
    }).catch((err) => {
      item.state = 'failed';
      console.warn(`image ${item.image.file}:`, err);
    });
  }
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
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
