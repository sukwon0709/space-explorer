import * as THREE from 'three';
import { SUN_SURFACE_BRIGHTNESS } from './sun';

/**
 * Glowing gas drawn as soft points: each a small ball of light with a luminosity (V band,
 * in Suns) and a radius (km). Up close it is a blob of its surface brightness, exposed
 * like the planets and stars (render/sun.ts); far off, its light is kept in a pixel-sized
 * spot. Positions are relative to the group (the object's centre, placed camera-relative
 * each frame), times `uScale` (homologous expansion: velocity times time).
 *
 * `light` is GLSL returning each point's brightness factor; it may use the attributes
 * aParam (vec4) and the uniforms declared in `uniforms`.
 */
export interface GlowOptions {
  count: number;
  light?: string;
  /** GLSL body of `vec3 placeOf(vec3 p)`: where a point is (default: position times uScale). */
  place?: string;
  declarations?: string;
  uniforms?: Record<string, THREE.IUniform>;
  /** Ignore depth (gas in front of and behind solid bodies alike). */
  depthTest?: boolean;
}

const vertex = (light: string, place: string, declarations: string) => /* glsl */ `
attribute vec3 aColor;
attribute float aLum;
attribute float aSize;
attribute vec4 aParam;
uniform float uScale;
uniform float uSizeScale;
uniform float uLum;
uniform float uExposure;
uniform float uPixelsPerRadian;
uniform float uPixelRatio;
${declarations}
varying vec3 vColor;
varying float vSize;
#include <common>
#include <logdepthbuf_pars_vertex>

float lightOf(vec3 p) { ${light} }
vec3 placeOf(vec3 p) { ${place} }

void main() {
  vec3 p = placeOf(position);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = max(length(mv.xyz), 1e-6);
  float r = aSize * uSizeScale;
  // Surface brightness relative to the Sun's: L / R^2 in solar units.
  float lum = aLum * uLum * lightOf(p);
  float surface = lum / max(pow(r / 695700.0, 2.0), 1e-30);
  float b = ${(7 * SUN_SURFACE_BRIGHTNESS).toExponential(6)} * uExposure * surface;
  float rPx = r / d * uPixelsPerRadian * uPixelRatio;
  float sigma = max(0.8 * uPixelRatio, 0.6 * rPx);
  // A disc of rPx pixels spread as a gaussian of sigma keeps its light.
  float peak = b * rPx * rPx / (2.0 * sigma * sigma);
  vColor = aColor * min(peak, 4.0);
  vSize = min(ceil(sigma * 6.0) + 1.0, 512.0);
  gl_PointSize = peak < 0.002 ? 0.0 : vSize;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const fragment = /* glsl */ `
varying vec3 vColor;
varying float vSize;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 q = (gl_PointCoord - 0.5) * vSize;
  float sigma = vSize / 6.0;
  float g = exp(-dot(q, q) / (2.0 * sigma * sigma));
  gl_FragColor = vec4(vColor * g, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class GlowPoints {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  readonly geometry: THREE.BufferGeometry;

  constructor(o: GlowOptions) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(o.count * 3), 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(o.count * 3), 3));
    g.setAttribute('aLum', new THREE.BufferAttribute(new Float32Array(o.count), 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(o.count), 1));
    g.setAttribute('aParam', new THREE.BufferAttribute(new Float32Array(o.count * 4), 4));
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertex(o.light ?? 'return 1.0;', o.place ?? 'return p * uScale;', o.declarations ?? ''),
      fragmentShader: fragment,
      uniforms: {
        uScale: { value: 1 },
        uSizeScale: { value: 1 },
        uLum: { value: 1 },
        uExposure: { value: 1 },
        uPixelsPerRadian: { value: 1000 },
        uPixelRatio: { value: 1 },
        ...(o.uniforms ?? {}),
      },
      transparent: true,
      depthWrite: false,
      depthTest: o.depthTest ?? true,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.material.uniforms;
  }

  /** Fill the attributes (positions km or km/s, colours linear RGB, luminosity shares, radii, params). */
  set(positions: ArrayLike<number>, colors: ArrayLike<number>, lum: ArrayLike<number>, size: ArrayLike<number>, param?: ArrayLike<number>): void {
    const g = this.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).set(positions);
    (g.getAttribute('aColor') as THREE.BufferAttribute).set(colors);
    (g.getAttribute('aLum') as THREE.BufferAttribute).set(lum);
    (g.getAttribute('aSize') as THREE.BufferAttribute).set(size);
    if (param) (g.getAttribute('aParam') as THREE.BufferAttribute).set(param);
    for (const name of ['position', 'aColor', 'aLum', 'aSize', 'aParam']) g.getAttribute(name).needsUpdate = true;
  }
}
