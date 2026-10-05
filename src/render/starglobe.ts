import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { kelvinToRgb, type Exoplanet } from '../core/stars';
import { latLonSphere } from './sky';

const AU = 149597870.7;

const vertexShader = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vNormal = normalize(normalMatrix * position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uColor;
varying vec3 vNormal;
varying vec3 vView;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float mu = clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0);
  // The Sun's limb darkening (Neckel and Labs, 550 nm), as a stand-in for other stars.
  float limb = 0.30 + 0.93 * mu - 0.23 * mu * mu;
  gl_FragColor = vec4(uColor * limb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * A star seen up close: a limb-darkened sphere of the star's radius and colour, and
 * the orbits of its known planets. Orbit sizes and shapes are measured; their
 * orientation is mostly not, so every orbit is drawn edge-on as seen from Earth, which
 * is true for transiting planets and close for most others.
 */
export class StarGlobe {
  readonly group = new THREE.Group();
  private readonly sphere: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly orbits = new THREE.Group();
  private key = '';

  constructor() {
    this.material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: { uColor: { value: new THREE.Color() } } });
    this.sphere = new THREE.Mesh(latLonSphere(96, 48), this.material);
    this.group.add(this.sphere, this.orbits);
    this.group.visible = false;
  }

  /**
   * @param rel star centre minus camera, scene axes, km.
   * @param fromEarth unit vector from Earth toward the star, scene axes.
   */
  update(key: string, rel: Vec3, radiusKm: number, teff: number, planets: Exoplanet[] | undefined, fromEarth: Vec3): void {
    this.group.visible = true;
    this.group.position.set(rel[0], rel[1], rel[2]);
    this.sphere.scale.setScalar(radiusKm);
    const rgb = kelvinToRgb(teff);
    // Far brighter than the display can show: the tone mapper rolls it off to the colour.
    this.material.uniforms.uColor.value.setRGB(rgb[0] * 2, rgb[1] * 2, rgb[2] * 2);
    if (key !== this.key) {
      this.key = key;
      this.buildOrbits(planets ?? [], fromEarth);
    }
  }

  hide(): void {
    this.group.visible = false;
  }

  private buildOrbits(planets: Exoplanet[], fromEarth: Vec3): void {
    for (const child of [...this.orbits.children]) {
      this.orbits.remove(child);
      (child as THREE.Line).geometry.dispose();
    }
    // Orbit plane: contains the line of sight from Earth (edge-on), tilted to the ecliptic up axis.
    const los = new THREE.Vector3(...fromEarth).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const across = new THREE.Vector3().crossVectors(los, up).normalize();
    if (across.lengthSq() < 1e-6) across.set(1, 0, 0);
    const material = new THREE.LineBasicMaterial({ color: '#7fb0ff', transparent: true, opacity: 0.55, depthWrite: false });
    for (const p of planets) {
      if (!p.a) continue;
      const a = p.a * AU;
      const e = Math.min(0.95, p.e ?? 0);
      const pts: number[] = [];
      for (let k = 0; k <= 256; k++) {
        const nu = (k / 256) * 2 * Math.PI;
        const r = (a * (1 - e * e)) / (1 + e * Math.cos(nu));
        const x = r * Math.cos(nu), y = r * Math.sin(nu);
        pts.push(across.x * x + los.x * y, across.y * x + los.y * y, across.z * x + los.z * y);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const line = new THREE.Line(g, material);
      line.frustumCulled = false;
      this.orbits.add(line);
    }
  }
}
