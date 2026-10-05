import * as THREE from 'three';

/** Uniforms this layer sets itself instead of sharing with the star field. */
const OWN = new Set(['uCamHigh', 'uCamLow', 'uHideWithin', 'uDustBlend', 'uYears']);

/**
 * Stars placed by the app rather than the catalogue (the S-stars around Sgr A*, the
 * companions of black holes), drawn with the star field's shader. Their positions are
 * handed over camera-relative every frame, in float64 on the CPU, so stars a few AU
 * apart 8 kpc away stay exactly where their orbits put them.
 */
export class ExtraStars {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly position: THREE.BufferAttribute;
  private readonly absMag: THREE.BufferAttribute;
  private readonly base: Float32Array;

  constructor(source: THREE.ShaderMaterial, stars: Array<{ absMag: number; teffCode: number }>) {
    this.material = source.clone();
    // Share the star field's uniforms (exposure, pixel scale), except those set here.
    for (const key of Object.keys(source.uniforms)) if (!OWN.has(key)) this.material.uniforms[key] = source.uniforms[key];
    this.material.uniforms.uDustBlend.value = 0;
    const n = stars.length;
    const g = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.position.setUsage(THREE.DynamicDrawUsage);
    this.base = new Float32Array(stars.map((s) => s.absMag));
    this.absMag = new THREE.BufferAttribute(new Int16Array(stars.map((s) => Math.round(s.absMag * 1000))), 1);
    this.absMag.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.position);
    g.setAttribute('velocity', new THREE.Float16BufferAttribute(new Uint16Array(n * 3), 3));
    g.setAttribute('absMag', this.absMag);
    g.setAttribute('teffCode', new THREE.BufferAttribute(new Uint8Array(stars.map((s) => s.teffCode)), 1));
    g.setAttribute('avCode', new THREE.BufferAttribute(new Uint8Array(n), 1));
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = -10;
  }

  /**
   * @param rel camera-relative ICRS positions, parsecs (3 per star)
   * @param dim magnitudes added to each star (extinction; Infinity hides it)
   */
  update(rel: Float64Array, dim: Float64Array): void {
    const p = this.position.array as Float32Array;
    for (let k = 0; k < rel.length; k++) p[k] = rel[k];
    const m = this.absMag.array as Int16Array;
    for (let k = 0; k < this.base.length; k++) m[k] = Math.round(Math.min(30, this.base[k] + dim[k]) * 1000);
    this.position.needsUpdate = true;
    this.absMag.needsUpdate = true;
  }
}
