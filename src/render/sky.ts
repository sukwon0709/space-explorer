import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import type { Globe, GlobeFrame } from './globe';
import { ATMOSPHERE, atmosphereGlsl } from './atmosphere';
import { applySphereLod, latLonSphere, sphereLevels } from './lod';
import { CLOUD_GLSL } from './clouds';

export { latLonSphere };

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

const skyFragment = (atmosphere: string) => /* glsl */ `
uniform vec3 uSun;
uniform mat3 uSceneToBody;
uniform vec3 uCamBody;
uniform float uFlatten;
uniform float uSunIntensity;
varying vec3 vRel;
#include <common>
#include <logdepthbuf_pars_fragment>
${atmosphere}
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

const cloudFragment = (atmosphere: string) => /* glsl */ `
uniform vec3 uSun;
uniform mat3 uSceneToBody;
uniform vec3 uCamBody;
uniform float uFlatten;
uniform float uSunIntensity;
uniform vec2 uCloudTexel;
varying vec3 vRel;
varying vec2 vUv;
#include <common>
#include <logdepthbuf_pars_fragment>
${atmosphere}
${CLOUD_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  float cover = texture2D(uClouds, vUv).r;
  if (cover < 0.01) discard;
  vec3 cam = vec3(uCamBody.xy, uCamBody.z * uFlatten);
  vec3 rel = uSceneToBody * vRel;
  vec3 p = cam + vec3(rel.xy, rel.z * uFlatten);
  vec3 up = normalize(p);
  vec3 viewDir = normalize(rel);
  float tau = cloudTau(cover);
  // Relief: deeper cloud has higher, colder tops (up to ~10 km above the thinnest), so
  // the cover's slope tilts the top's normal and towers get a lit and a shadowed side.
  float cosLat = max(length(up.xy), 0.05);
  float de = texture2D(uClouds, vUv + vec2(uCloudTexel.x, 0.0)).r - texture2D(uClouds, vUv - vec2(uCloudTexel.x, 0.0)).r;
  float dn = texture2D(uClouds, vUv - vec2(0.0, uCloudTexel.y)).r - texture2D(uClouds, vUv + vec2(0.0, uCloudTexel.y)).r;
  float spacing = PI * ATM_BOTTOM * uCloudTexel.y; // km per texel north-south
  vec3 east = normalize(vec3(-up.y, up.x, 0.0) + vec3(1e-6, 0.0, 0.0));
  vec3 north = cross(up, east);
  vec3 n = normalize(up - east * (10.0 * de / (2.0 * spacing * cosLat)) - north * (10.0 * dn / (2.0 * spacing)));
  float ndl = dot(n, uSun);
  vec3 sunT = atmSunTransmittance(p, uSun);
  // Sunlight scattered back up (two-stream reflectance of this optical depth), brighter on
  // the sunlit side of the tops; a little light through from above when seen from below.
  float lit = mix(max(dot(up, uSun), 0.0), max(ndl, 0.0), 0.7);
  vec3 color = sunT * (0.12 + 0.88 * lit) * cloudReflectance(tau) * uSunIntensity * eclipseVisibility(uCamBody + rel);
  vec3 inscatter, transmittance;
  atmBetween(cam, p, uSun, inscatter, transmittance);
  // What is behind shows through by the direct transmission along the line of sight;
  // the light the cloud scatters forward is the ground's own, blurred, so half the
  // optical depth is counted.
  float mu = max(abs(dot(up, viewDir)), 0.05);
  float alpha = min(1.0 - exp(-0.5 * tau / mu), 0.97);
  gl_FragColor = vec4(color * transmittance + inscatter * uSunIntensity * alpha, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** A planet's sky shell (and Earth's cloud layer), placed relative to the camera every frame. */
export class EarthSky {
  readonly group = new THREE.Group();
  private readonly shell: THREE.Mesh;
  private readonly clouds?: THREE.Mesh;
  private readonly quaternion = new THREE.Quaternion();

  constructor(globe: Globe, clouds?: THREE.Texture, cloudAltitude = 6) {
    const uniforms = globe.uniforms;
    const atmosphere = globe.atmosphere ?? ATMOSPHERE;
    const glsl = atmosphereGlsl(atmosphere);
    const top = atmosphere.top;
    this.shell = new THREE.Mesh(
      sphereLevels(128, 64)[0],
      new THREE.ShaderMaterial({
        vertexShader: shellVertex,
        fragmentShader: skyFragment(glsl),
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
      // The ground under the deck gets its shadows from the same map.
      uniforms.uClouds.value = clouds;
      uniforms.uHasClouds.value = 1;
      const a = globe.shape.a + cloudAltitude;
      const b = globe.shape.b + cloudAltitude;
      this.clouds = new THREE.Mesh(
        sphereLevels(512, 256)[0],
        new THREE.ShaderMaterial({
          vertexShader: shellVertex,
          fragmentShader: cloudFragment(glsl),
          uniforms: { ...uniforms, uCloudTexel: { value: new THREE.Vector2(1 / (clouds.image as HTMLImageElement).width, 1 / (clouds.image as HTMLImageElement).height) } },
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
      // The sky shell gets a coarser grid from afar (see lod.ts). The cloud deck keeps its
      // full grid: a coarser one sags below the highest terrain (Tibet) and is hidden there.
      if (mesh === this.shell) applySphereLod(mesh, sphereLevels(128, 64), 128, Math.max(r[0], r[2]), Math.hypot(f.centerRel[0], f.centerRel[1], f.centerRel[2]), 2);
    }
  }
}
