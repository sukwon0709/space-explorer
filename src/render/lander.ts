import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';

/**
 * A lander on the ground, after the Apollo lunar module: an octagonal descent stage
 * wrapped in gold foil on four legs (9.4 m across the footpads), and optionally the
 * ascent stage on top. The player's parked ship uses the whole thing; Eagle's descent
 * stage stands alone at Tranquility Base, where LRO photographed it.
 *
 * Lit by the Sun and a little skylight with the same intensity scale as the terrain.
 * Placed every frame relative to the camera, like everything else.
 */

export const LIT_VERTEX = /* glsl */ `
varying vec3 vNormal;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

export const LIT_FRAGMENT = /* glsl */ `
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
  vec3 n = normalize(vNormal);
  float ndl = max(dot(n, uSunDir), 0.0);
  // Crinkled foil glints: a broad highlight on top of the diffuse light.
  float glint = uShine * pow(max(dot(n, uSunDir), 0.0), 8.0);
  vec3 color = uColor * (ndl * uSunIntensity + uAmbient) + uColor * glint * uSunIntensity;
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Lander {
  readonly group = new THREE.Group();
  private readonly uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunIntensity: { value: 7 },
    uAmbient: { value: new THREE.Vector3() },
  };
  private readonly basis = new THREE.Matrix4();

  constructor(ascent: boolean) {
    const material = (hex: string, shine = 0) => new THREE.ShaderMaterial({
      vertexShader: LIT_VERTEX,
      fragmentShader: LIT_FRAGMENT,
      uniforms: { ...this.uniforms, uColor: { value: linear(hex) }, uShine: { value: shine } },
    });
    const gold = material('#b8892e', 0.5);
    const dark = material('#2a2a2a');
    const grey = material('#9a9a96', 0.2);
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    };
    // Metres, y up, the ground at y = 0.
    add(new THREE.CylinderGeometry(2.1, 2.1, 1.65, 8), gold, 0, 1.9, 0).rotation.y = Math.PI / 8;
    add(new THREE.CylinderGeometry(0.75, 0.95, 0.9, 16, 1, true), dark, 0, 0.75, 0);
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 + Math.PI / 4;
      const foot = new THREE.Vector3(Math.cos(a) * 4.7, 0.1, Math.sin(a) * 4.7);
      const top = new THREE.Vector3(Math.cos(a) * 2.0, 2.4, Math.sin(a) * 2.0);
      const knee = new THREE.Vector3(Math.cos(a) * 1.8, 1.3, Math.sin(a) * 1.8);
      strut(add, top, foot, 0.11, grey);
      strut(add, knee, foot, 0.06, grey);
      add(new THREE.CylinderGeometry(0.47, 0.47, 0.18, 16), grey, foot.x, 0.09, foot.z);
    }
    if (ascent) {
      add(new THREE.BoxGeometry(2.8, 2.2, 2.6), grey, 0, 3.85, 0);
      add(new THREE.CylinderGeometry(0.9, 0.9, 0.6, 12), grey, 0, 5.2, 0);
      add(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6), grey, 0.8, 5.7, -0.6);
    }
    this.group.visible = false;
  }

  /**
   * Place the lander: `rel` is its foot centre relative to the camera, `up` and
   * `north` its local axes (scene), `heading` its turn about up (radians).
   */
  update(rel: Vec3, up: Vec3, north: Vec3, heading: number, sunDir: Vec3, sunIntensity: number, ambient: Vec3): void {
    const u = new THREE.Vector3(...up).normalize();
    const n = new THREE.Vector3(...north).normalize();
    const e = new THREE.Vector3().crossVectors(n, u).normalize();
    // Model axes: x east, y up, z south; turned by heading about up.
    const c = Math.cos(heading), s = Math.sin(heading);
    const x = e.clone().multiplyScalar(c).addScaledVector(n, -s);
    const z = n.clone().multiplyScalar(-c).addScaledVector(e, -s);
    this.basis.makeBasis(x, u, z);
    this.group.quaternion.setFromRotationMatrix(this.basis);
    // Kilometres in the scene: the model is in metres.
    this.group.scale.setScalar(0.001);
    this.group.position.set(rel[0], rel[1], rel[2]);
    this.uniforms.uSunDir.value.set(...sunDir);
    this.uniforms.uSunIntensity.value = sunIntensity;
    this.uniforms.uAmbient.value.set(...ambient);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }
}

function strut(add: (g: THREE.BufferGeometry, m: THREE.Material, x?: number, y?: number, z?: number) => THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material): void {
  const d = new THREE.Vector3().subVectors(b, a);
  const mesh = add(new THREE.CylinderGeometry(r, r, d.length(), 6), m, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
}

export function linear(hex: string): THREE.Vector3 {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b).multiplyScalar(0.6);
}
