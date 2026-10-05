import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import type { Globe, GlobeFrame } from './globe';
import { ATMOSPHERE, ATMOSPHERE_GLSL } from './atmosphere';

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

const shellVertex = /* glsl */ `
varying vec3 vRel;
varying vec2 vUv;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vUv = uv;
  vRel = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const skyFragment = /* glsl */ `
uniform vec3 uSun;
uniform mat3 uSceneToBody;
uniform vec3 uCamBody;
uniform float uFlatten;
uniform float uSunIntensity;
varying vec3 vRel;
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  vec3 cam = vec3(uCamBody.xy, uCamBody.z * uFlatten);
  vec3 rel = uSceneToBody * vRel;
  vec3 rd = normalize(vec3(rel.xy, rel.z * uFlatten));
  vec2 top = atmSphere(cam, rd, ATM_TOP);
  if (top.y <= 0.0) discard;
  float t0 = max(top.x, 0.0);
  float t1 = top.y;
  vec2 ground = atmSphere(cam, rd, ATM_BOTTOM);
  if (ground.x > 0.0) t1 = ground.x;
  vec3 inscatter, transmittance;
  atmScatter(cam, rd, t0, t1, uSun, inscatter, transmittance);
  // Premultiplied: add the scattered light, dim what is behind by the transmittance.
  gl_FragColor = vec4(inscatter * uSunIntensity, dot(transmittance, vec3(0.2126, 0.7152, 0.0722)));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const cloudFragment = /* glsl */ `
uniform sampler2D uClouds;
uniform vec3 uSun;
uniform mat3 uSceneToBody;
uniform vec3 uCamBody;
uniform float uFlatten;
uniform float uSunIntensity;
varying vec3 vRel;
varying vec2 vUv;
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  float cover = texture2D(uClouds, vUv).r;
  if (cover < 0.01) discard;
  vec3 cam = vec3(uCamBody.xy, uCamBody.z * uFlatten);
  vec3 rel = uSceneToBody * vRel;
  vec3 p = cam + vec3(rel.xy, rel.z * uFlatten);
  vec3 up = normalize(p);
  float ndl = dot(up, uSun);
  vec3 sunT = atmSunTransmittance(p, uSun);
  // Thick cloud scatters sunlight in all directions: bright on the sunlit side,
  // a little light through from above when seen from below.
  vec3 color = sunT * (0.12 + 0.88 * max(ndl, 0.0)) * 0.75 * uSunIntensity * eclipseVisibility(uCamBody + rel);
  vec3 inscatter, transmittance;
  atmBetween(cam, p, uSun, inscatter, transmittance);
  float alpha = cover * 0.92;
  color = color * transmittance;
  gl_FragColor = vec4(color * alpha + inscatter * uSunIntensity * alpha, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Earth's sky shell and cloud layer, placed relative to the camera every frame. */
export class EarthSky {
  readonly group = new THREE.Group();
  private readonly shell: THREE.Mesh;
  private readonly clouds?: THREE.Mesh;
  private readonly quaternion = new THREE.Quaternion();

  constructor(globe: Globe, clouds?: THREE.Texture, cloudAltitude = 6) {
    const uniforms = globe.uniforms;
    const top = ATMOSPHERE.top;
    this.shell = new THREE.Mesh(
      latLonSphere(128, 64),
      new THREE.ShaderMaterial({
        vertexShader: shellVertex,
        fragmentShader: skyFragment,
        uniforms,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.SrcAlphaFactor,
      }),
    );
    this.shell.userData.radius = [top, top, top / globe.uniforms.uFlatten.value];
    this.shell.renderOrder = 10;
    this.shell.frustumCulled = false;
    this.group.add(this.shell);

    if (clouds) {
      clouds.flipY = false;
      clouds.colorSpace = THREE.NoColorSpace;
      clouds.anisotropy = 8;
      const a = globe.shape.a + cloudAltitude;
      const b = globe.shape.b + cloudAltitude;
      this.clouds = new THREE.Mesh(
        latLonSphere(512, 256),
        new THREE.ShaderMaterial({
          vertexShader: shellVertex,
          fragmentShader: cloudFragment,
          uniforms: { ...uniforms, uClouds: { value: clouds } },
          side: THREE.DoubleSide,
          transparent: true,
          depthWrite: false,
          blending: THREE.CustomBlending,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneMinusSrcAlphaFactor,
        }),
      );
      this.clouds.userData.radius = [a, a, b];
      this.clouds.renderOrder = 5;
      this.clouds.frustumCulled = false;
      this.group.add(this.clouds);
    }
  }

  update(f: GlobeFrame): void {
    const b = f.bodyToScene;
    this.quaternion.setFromRotationMatrix(new THREE.Matrix4().set(b[0], b[1], b[2], 0, b[3], b[4], b[5], 0, b[6], b[7], b[8], 0, 0, 0, 0, 1));
    for (const mesh of [this.shell, this.clouds]) {
      if (!mesh) continue;
      const r = mesh.userData.radius as Vec3;
      mesh.position.set(f.centerRel[0], f.centerRel[1], f.centerRel[2]);
      mesh.quaternion.copy(this.quaternion);
      mesh.scale.set(r[0], r[1], r[2]);
    }
  }
}
