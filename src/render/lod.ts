import * as THREE from 'three';

/**
 * Level of detail for the lat/lon spheres (planets, moons, the Sun, stars, exoplanets,
 * a planet's sky shell). A globe a few pixels across was drawn with the same 37 000 triangles
 * as one filling the screen; now it gets the coarsest grid whose outline stays within
 * a fraction of a pixel of a true ellipse.
 */

/** Pixels per radian of the current view, set by the app once per frame. */
export const lodView = { pixelsPerRadian: 1000 };

const cache = new Map<string, THREE.BufferGeometry[]>();

/**
 * The grid at full resolution and at halvings down to 16 segments around (shared
 * between all meshes that ask for the same size). Index 0 is the full grid.
 */
export function sphereLevels(segLon: number, segLat: number): THREE.BufferGeometry[] {
  const key = `${segLon}x${segLat}`;
  let levels = cache.get(key);
  if (!levels) {
    levels = [];
    for (let lon = segLon, lat = segLat; lon >= 16 && lat >= 8; lon /= 2, lat /= 2) levels.push(latLonSphere(lon, lat));
    cache.set(key, levels);
  }
  return levels;
}

/**
 * Segments around a sphere `radiusPx` pixels across needs: the outline of an N-gon
 * sits R (1 - cos(pi/N)) ~ R pi^2 / 2N^2 inside the circle, so N = 6 sqrt(R) keeps that
 * under 0.14 px at any size.
 */
export function segmentsFor(radiusPx: number): number {
  return 6 * Math.sqrt(Math.max(radiusPx, 0));
}

/**
 * Give `mesh` the coarsest level of `levels` fine enough for a sphere of `radiusKm`
 * whose centre is `distanceKm` from the camera. Within `fullWithin` radii of the centre
 * the full grid is always used (near the surface the facets are close to the eye).
 */
export function applySphereLod(mesh: THREE.Mesh, levels: THREE.BufferGeometry[], segLon: number, radiusKm: number, distanceKm: number, fullWithin = 0): void {
  let k = 0;
  if (distanceKm > radiusKm * fullWithin) {
    const need = segmentsFor((radiusKm / Math.max(distanceKm, radiusKm)) * lodView.pixelsPerRadian);
    while (k + 1 < levels.length && segLon / 2 ** (k + 1) >= need) k++;
  }
  if (mesh.geometry !== levels[k]) mesh.geometry = levels[k];
}

/**
 * A latitude/longitude grid on the unit sphere in body-fixed axes (z = north pole),
 * with uv = ((lon + 180) / 360, (90 - lat) / 180) to match equirectangular maps.
 */
export function latLonSphere(segLon: number, segLat: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= segLat; j++) {
    const lat = Math.PI / 2 - (Math.PI * j) / segLat;
    for (let i = 0; i <= segLon; i++) {
      const lon = -Math.PI + (2 * Math.PI * i) / segLon;
      positions.push(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
      uvs.push(i / segLon, j / segLat);
    }
  }
  for (let j = 0; j < segLat; j++) {
    for (let i = 0; i < segLon; i++) {
      const a = j * (segLon + 1) + i, b = a + 1, c = a + segLon + 1, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeBoundingSphere();
  return g;
}
