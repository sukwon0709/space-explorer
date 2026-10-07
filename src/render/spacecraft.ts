import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import type { CraftModel } from '../ui/missions';
import { linear } from './lander';

/**
 * Spacecraft models from published dimensions, simplified to a few dozen primitives:
 * the parts that give each its silhouette (dish, bus, booms, RTGs, solar wings, heat
 * shield). Metres, +z along the high-gain antenna's beam (the side that faces Earth),
 * or the Sun-facing side for Parker Solar Probe and the nose for Orion. Lit by the Sun
 * with the same intensity scale as the planets' surfaces.
 */

const vertex = /* glsl */ `
varying vec3 vNormal;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

// Thin parts (dishes, panels) are double-sided: the far side faces the other way.
const fragment = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uSunDir;
uniform float uSunIntensity;
uniform vec3 uAmbient;
uniform float uShine;
varying vec3 vNormal;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float ndl = max(dot(n, uSunDir), 0.0);
  float glint = uShine * pow(ndl, 12.0);
  vec3 color = uColor * (ndl * uSunIntensity + uAmbient) + vec3(glint * uSunIntensity * 0.6);
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

type Uniforms = { uSunDir: { value: THREE.Vector3 }; uSunIntensity: { value: number }; uAmbient: { value: THREE.Vector3 } };

class Kit {
  readonly root = new THREE.Group();
  private readonly cache = new Map<string, THREE.ShaderMaterial>();

  constructor(private readonly uniforms: Uniforms) {}

  material(hex: string, shine = 0): THREE.ShaderMaterial {
    const key = `${hex}/${shine}`;
    let m = this.cache.get(key);
    if (!m) {
      m = new THREE.ShaderMaterial({
        vertexShader: vertex, fragmentShader: fragment, side: THREE.DoubleSide,
        uniforms: { ...this.uniforms, uColor: { value: linear(hex) }, uShine: { value: shine } },
      });
      this.cache.set(key, m);
    }
    return m;
  }

  add(geometry: THREE.BufferGeometry, hex: string, at: [number, number, number] = [0, 0, 0], shine = 0, parent: THREE.Object3D = this.root): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, this.material(hex, shine));
    mesh.position.set(...at);
    mesh.frustumCulled = false;
    parent.add(mesh);
    return mesh;
  }

  /** A paraboloid dish of radius r and depth d, opening towards +z, vertex at z0. */
  dish(r: number, d: number, z0: number, hex = '#e9e7e0'): THREE.Mesh {
    const pts: THREE.Vector2[] = [];
    for (let k = 0; k <= 12; k++) {
      const x = (r * k) / 12;
      pts.push(new THREE.Vector2(x, (d * x * x) / (r * r)));
    }
    const g = new THREE.LatheGeometry(pts, 32);
    g.rotateX(Math.PI / 2);
    return this.add(g, hex, [0, 0, z0], 0.3);
  }

  /** A prism along z: n sides (n = 32 for a cylinder), circumradius r, length l. */
  prism(n: number, r: number, l: number, at: [number, number, number], hex: string, shine = 0): THREE.Mesh {
    const g = new THREE.CylinderGeometry(r, r, l, n);
    g.rotateX(Math.PI / 2);
    return this.add(g, hex, at, shine);
  }

  /** A thin rod from a to b. */
  rod(a: [number, number, number], b: [number, number, number], r: number, hex = '#8a8a86'): THREE.Mesh {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    const d = new THREE.Vector3().subVectors(vb, va);
    const mesh = this.add(new THREE.CylinderGeometry(r, r, d.length(), 6), hex, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    return mesh;
  }

  box(sx: number, sy: number, sz: number, at: [number, number, number], hex: string, shine = 0): THREE.Mesh {
    return this.add(new THREE.BoxGeometry(sx, sy, sz), hex, at, shine);
  }

  /** A flat solar panel in the x-y plane (cells facing +z), centred at `at`. */
  panel(sx: number, sy: number, at: [number, number, number], rotZ = 0): THREE.Mesh {
    const m = this.box(sx, sy, 0.04, at, '#1b2540', 0.8);
    m.rotation.z = rotZ;
    return m;
  }

  /** A solar wing: n panels end to end along direction angle `a` (radians in x-y). */
  wing(a: number, from: number, n: number, length: number, width: number): void {
    const c = Math.cos(a), s = Math.sin(a);
    this.rod([c * (from - 0.6), s * (from - 0.6), 0], [c * from, s * from, 0], 0.05);
    for (let k = 0; k < n; k++) {
      const mid = from + (k + 0.5) * length + k * 0.08;
      this.panel(length, width, [c * mid, s * mid, 0], a);
    }
  }

  /** A radioisotope generator: a finned cylinder along `axis`. */
  rtg(at: [number, number, number], along: 'x' | 'y', length = 1.1, r = 0.22): void {
    const g = new THREE.CylinderGeometry(r, r, length, 8);
    if (along === 'x') g.rotateZ(Math.PI / 2);
    this.add(g, '#3a3a3a', at, 0.1);
    // Two crossed fin plates through the axis.
    const fins = along === 'x'
      ? [new THREE.BoxGeometry(length * 0.9, 0.02, r * 3.2), new THREE.BoxGeometry(length * 0.9, r * 3.2, 0.02)]
      : [new THREE.BoxGeometry(0.02, length * 0.9, r * 3.2), new THREE.BoxGeometry(r * 3.2, length * 0.9, 0.02)];
    for (const fin of fins) this.add(fin, '#2e2e2e', at);
  }
}

const GOLD = '#b8892e', FOIL_BLACK = '#202020', GREY = '#9a9a96', WHITE = '#e9e7e0', SILVER = '#c8c8c4';

export function buildModel(kind: CraftModel, uniforms: Uniforms): THREE.Group {
  const k = new Kit(uniforms);
  switch (kind) {
    case 'voyager':
      // 3.66 m dish over a ten-sided bus; RTGs on one boom, the cameras on the other,
      // and the 13 m magnetometer boom.
      k.dish(1.83, 0.45, -0.1);
      k.prism(10, 0.94, 0.47, [0, 0, -0.45], FOIL_BLACK);
      k.rod([-0.8, 0, -0.45], [-3.4, 0, -0.45], 0.05);
      for (const x of [-2.1, -2.65, -3.2]) k.rtg([x, 0, -0.45], 'x', 0.5, 0.2);
      k.rod([0.8, 0, -0.45], [2.4, 0, -0.45], 0.06);
      k.box(0.5, 0.45, 0.6, [2.6, 0, -0.4], GREY);
      k.box(0.25, 0.25, 0.5, [2.7, 0.3, -0.1], FOIL_BLACK);
      k.rod([0.3, -0.7, -0.5], [4.5, -12.2, -0.5], 0.03, SILVER);
      break;
    case 'pioneer':
      // 2.74 m dish on a hexagonal bus; two RTG trusses and the magnetometer boom.
      k.dish(1.37, 0.46, -0.05);
      k.prism(6, 0.72, 0.36, [0, 0, -0.35], GOLD, 0.4);
      for (const a of [Math.PI / 6, -Math.PI / 6 - Math.PI / 3]) {
        const c = Math.cos(a + Math.PI), s = Math.sin(a + Math.PI);
        k.rod([0.7 * c, 0.7 * s, -0.35], [3 * c, 3 * s, -0.35], 0.04);
        for (const r of [2.3, 2.9]) k.rtg([r * c, r * s, -0.35], 'y', 0.6, 0.18);
      }
      k.rod([0.6, 0, -0.35], [7.2, 0, -0.35], 0.03, SILVER);
      break;
    case 'galileo':
      // 4.8 m umbrella antenna (drawn open: in flight it never fully unfurled), spun
      // section, RTG booms and an 11 m magnetometer boom.
      k.dish(2.4, 0.7, -0.2, '#d8d4c8');
      k.prism(10, 1.0, 1.4, [0, 0, -1.0], FOIL_BLACK);
      k.prism(16, 0.7, 1.2, [0, 0, -2.3], GOLD, 0.4);
      for (const a of [0.4, 0.4 + Math.PI]) {
        const c = Math.cos(a), s = Math.sin(a);
        k.rod([c, s, -1.0], [4.4 * c, 4.4 * s, -1.0], 0.05);
        k.rtg([3.8 * c, 3.8 * s, -1.0], 'x', 1.1, 0.22);
      }
      k.rod([0, 1, -1.0], [0, 11, -1.2], 0.03, SILVER);
      break;
    case 'cassini':
      // 6.7 m tall: the 4 m dish on top of the electronics bus and the gold propulsion
      // module; Huygens on the side; three RTGs at the base; the 11 m magnetometer boom.
      k.dish(2.0, 0.55, -0.3);
      k.prism(12, 1.0, 0.8, [0, 0, -0.8], FOIL_BLACK);
      k.prism(24, 1.3, 3.6, [0, 0, -3.0], GOLD, 0.45);
      k.prism(12, 0.9, 0.5, [0, 0, -5.0], FOIL_BLACK);
      for (const x of [-0.45, 0.45]) {
        const g = new THREE.ConeGeometry(0.4, 1.0, 16, 1, true);
        g.rotateX(-Math.PI / 2);
        k.add(g, '#5a5a58', [x, 0, -5.7]);
      }
      for (const a of [0, 2.1, 4.2]) k.rtg([1.25 * Math.cos(a), 1.25 * Math.sin(a), -4.8], 'y', 1.1, 0.22);
      {
        const huygens = k.prism(32, 1.35, 0.6, [1.65, 0, -2.0], WHITE, 0.2);
        huygens.rotation.y = Math.PI / 2;
        huygens.name = 'huygens';
      }
      k.rod([0, 1.1, -1.0], [0, 11, -1.3], 0.03, SILVER);
      k.box(0.6, 0.8, 1.1, [-1.1, 0.5, -1.4], GREY);
      break;
    case 'newhorizons':
      // A triangular body 2.1 m across, the 2.1 m dish and one RTG.
      k.prism(3, 1.25, 0.7, [0, 0, -0.55], GOLD, 0.4);
      k.dish(1.05, 0.3, -0.18);
      k.rtg([-1.7, -0.3, -0.55], 'x', 1.1, 0.22);
      k.box(0.4, 0.3, 0.3, [0.6, 0.7, -0.4], FOIL_BLACK);
      break;
    case 'juno':
      // Hexagonal body; three solar wings 8.9 m long (20 m tip to tip), cells facing the
      // Sun and Earth along the spin axis; 2.5 m dish.
      k.prism(6, 1.75, 1.5, [0, 0, -0.9], FOIL_BLACK);
      k.dish(1.25, 0.35, 0.0);
      for (const a of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) k.wing(a, 1.9, 4, 2.0, 2.65);
      break;
    case 'rosetta':
      // A 2.8 x 2.1 x 2.0 m box, the 2.2 m dish on its side and two 14 m solar wings.
      k.box(2.0, 2.1, 2.8, [0, 0, -1.2], GOLD, 0.4);
      k.dish(1.1, 0.3, 0.2);
      k.wing(Math.PI / 2, 1.1, 5, 2.6, 2.25);
      k.wing(-Math.PI / 2, 1.1, 5, 2.6, 2.25);
      k.box(0.8, 0.8, 0.6, [1.2, 0, -2.2], GREY);
      break;
    case 'parker':
      // The 2.3 m carbon heat shield, white face to the Sun; the bus in its shadow; two
      // small water-cooled solar arrays; a magnetometer boom trailing behind.
      k.prism(48, 1.15, 0.115, [0, 0, 0], WHITE, 0.1);
      k.prism(6, 0.55, 1.0, [0, 0, -1.3], GOLD, 0.4);
      for (const s of [-1, 1]) {
        k.rod([0, 0, -0.06], [s * 0.5, 0, -0.8], 0.04);
        k.panel(0.7, 1.55, [s * 0.85, 0, -1.1], 0).rotation.y = s * 1.2;
      }
      k.rod([0, 0, -1.8], [0, 0, -5.3], 0.03, SILVER);
      break;
    case 'osirisrex':
      // A 2.4 m box, 2 m dish, solar panels 6.2 m tip to tip and the sampling arm.
      k.box(2.4, 2.4, 3.1, [0, 0, -1.6], GOLD, 0.4);
      k.dish(1.0, 0.28, 0.0);
      k.panel(2.0, 1.9, [-2.3, 0, -1.2]);
      k.panel(2.0, 1.9, [2.3, 0, -1.2]);
      k.rod([0, -1.2, -3.2], [0, -1.2, -6.4], 0.05);
      k.prism(16, 0.15, 0.3, [0, -1.2, -6.5], GREY);
      break;
    case 'orion': {
      // The 5 m crew module (nose forward), service module and four solar wings 7 m long.
      const cm = new THREE.CylinderGeometry(0.8, 2.5, 3.3, 32);
      cm.rotateX(Math.PI / 2);
      k.add(cm, '#d9d9d6', [0, 0, 0], 0.2);
      k.prism(32, 2.05, 4.0, [0, 0, -3.65], '#cfcfcf', 0.2);
      const nozzle = new THREE.ConeGeometry(0.6, 1.2, 16, 1, true);
      nozzle.rotateX(-Math.PI / 2);
      k.add(nozzle, '#4a4a48', [0, 0, -6.2]);
      for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
        const c = Math.cos(a), s = Math.sin(a);
        k.rod([2.0 * c, 2.0 * s, -4.5], [2.6 * c, 2.6 * s, -4.5], 0.06);
        const p = k.panel(7.0, 2.0, [6.1 * c, 6.1 * s, -4.5], a);
        p.rotateX(0.35);
      }
      break;
    }
    case 'juice':
      // A 4 m tall box, 2.5 m dish, solar wings 27 m tip to tip (85 square metres), the
      // 10.6 m magnetometer boom and the 16 m radar antenna.
      k.box(2.5, 2.5, 4.0, [0, 0, -2.2], GOLD, 0.4);
      k.dish(1.25, 0.35, 0.0);
      k.wing(0, 1.3, 5, 2.4, 3.4);
      k.wing(Math.PI, 1.3, 5, 2.4, 3.4);
      k.rod([0, -1.3, -2.5], [0, -11.9, -2.5], 0.03, SILVER);
      k.rod([-8, 1.3, -3.6], [8, 1.3, -3.6], 0.02, SILVER);
      break;
    case 'lucy': {
      // A 2 m box, 2 m dish, and two round solar arrays 7.3 m across (14.5 m tip to tip).
      k.box(2.0, 2.0, 2.4, [0, 0, -1.4], GOLD, 0.4);
      k.dish(1.0, 0.28, 0.0);
      for (const s of [-1, 1]) {
        k.rod([s * 1.0, 0, -1.2], [s * 1.6, 0, -1.2], 0.06);
        const disc = new THREE.CircleGeometry(3.65, 40);
        k.add(disc, '#1b2540', [s * 5.25, 0, -1.2], 0.8);
      }
      break;
    }
  }
  return k.root;
}

/** The parts that come off during the mission: Cassini's Huygens probe. */
export function detach(model: THREE.Group, name: string, attached: boolean): void {
  const part = model.getObjectByName(name);
  if (part) part.visible = attached;
}

/** Light for a model: Sun direction (unit, scene), intensity and a little ambient. */
export function lightModel(uniforms: Uniforms, sunDir: Vec3, intensity: number): void {
  uniforms.uSunDir.value.set(sunDir[0], sunDir[1], sunDir[2]);
  uniforms.uSunIntensity.value = intensity;
  // Earthshine and starlight are negligible; a trace keeps the night side from pure black.
  uniforms.uAmbient.value.setScalar(intensity * 0.015);
}
