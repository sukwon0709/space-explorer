import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { POLE_CAP, cartesianToBL, horizon, isco } from '../core/kerr';

/**
 * Ray-traced view near a black hole. The scene is first drawn as usual into a texture
 * (the view) and into a cube map around the camera (the whole sky). A full-screen pass
 * then follows each pixel's light ray back through the Kerr metric (the same equations
 * and step control as core/kerr.ts, in float32), and colours it with what it meets:
 * the horizon (black), a thin disc or hot flow, a companion star, or the sky it came
 * from, looked up in the direction it arrived from at infinity.
 */

/** Rays passing farther than this (M) are bent by the weak-field formula instead of integrated. */
const B_FAR = 100;
/** Rays from a distant camera are integrated from this radius in. */
const R_START = 1000;
/** Outbound rays beyond this radius are finished with the weak-field formula. */
const R_ESCAPE = 80;

const vertexShader = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
varying vec2 vNdc;
uniform vec2 uTan;
uniform mat3 uViewToBH;
uniform mat3 uBHToView;
uniform mat3 uBHToScene;
uniform vec3 uCam;
uniform float uCamR;
uniform float uA;
uniform float uRh;
uniform float uRisco;
uniform float uEps;
uniform int uMaxSteps;
uniform int uFlow;          // 0 none, 1 thin disc, 2 hot flow (230 GHz)
uniform float uDiscOuter;
uniform float uTstar;       // thin disc temperature scale (K)
uniform float uDiscExposure;
uniform float uFlowExposure;
uniform float uBackground;  // sky brightness (dimmed in the radio view)
uniform vec4 uComp;         // companion centre (BH frame, M) and radius (M); radius 0 = none
uniform float uCompTeff;
uniform float uCompExposure;
uniform sampler2D uView;
uniform samplerCube uSky;

const float PI = 3.14159265358979;
const float B_FAR = ${B_FAR.toFixed(1)};
const float R_START = ${R_START.toFixed(1)};
const float R_ESCAPE = ${R_ESCAPE.toFixed(1)};
const float POLE_CAP = ${POLE_CAP.toFixed(4)};

vec3 kelvinToRgb(float kelvin) {
  float t = clamp(kelvin, 1000.0, 40000.0) / 100.0;
  float r = t <= 66.0 ? 255.0 : 329.698727446 * pow(t - 60.0, -0.1332047592);
  float g = t <= 66.0 ? 99.4708025861 * log(t) - 161.1195681661 : 288.1221695283 * pow(t - 60.0, -0.0755148492);
  float b = t >= 66.0 ? 255.0 : (t <= 19.0 ? 0.0 : 138.5177312231 * log(t - 10.0) - 305.0447927307);
  vec3 srgb = clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
  vec3 lin = mix(srgb / 12.92, pow((srgb + 0.055) / 1.055, vec3(2.4)), step(0.04045, srgb));
  return lin / dot(lin, vec3(0.2126, 0.7152, 0.0722));
}

// Blackbody radiance at 555 nm (V band), relative: 1 / (exp(hc / lambda k T) - 1).
float radianceV(float t) { return 1.0 / (exp(min(25924.0 / max(t, 1.0), 80.0)) - 1.0); }

vec3 decode(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 encode(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
// A filmic curve for the light of the disc and flow (ACES fit, Narkowicz 2015).
vec3 film(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

// The EHT's false-colour scale (black, red, orange, yellow, white).
vec3 afmhot(float x) { return clamp(vec3(2.0 * x, 2.0 * x - 0.5, 2.0 * x - 1.0), 0.0, 1.0); }

float phiShift(float r) {
  float q = sqrt(max(1.0 - uA * uA, 1e-6));
  if (abs(uA) < 1e-6) return 0.0;
  return uA / (2.0 * q) * log((r - 1.0 - q) / (r - 1.0 + q));
}

vec3 toCartesian(float r, float th, float ph) {
  float p = ph - phiShift(r);
  float s = sin(th);
  return vec3(s * (r * cos(p) - uA * sin(p)), s * (r * sin(p) + uA * cos(p)), r * cos(th));
}

// Hamilton's equations, forward in affine parameter: (r, theta, phi) and (p_r, p_theta).
void deriv(float L, vec3 x, vec2 p, out vec3 dx, out vec2 dp) {
  float r = x.x;
  float s = sin(x.y), c = cos(x.y);
  float s2 = max(s * s, 1e-8);
  float a2 = uA * uA;
  float sigma = r * r + a2 * c * c;
  float delta = r * r - 2.0 * r + a2;
  float P = r * r + a2 - uA * L;
  float F = delta * p.x * p.x + p.y * p.y + L * L / s2 + a2 * s2 - 2.0 * uA * L - P * P / delta;
  float Fr = 2.0 * (r - 1.0) * p.x * p.x - 4.0 * r * P / delta + 2.0 * (r - 1.0) * P * P / (delta * delta);
  float Ft = 2.0 * s * c * (a2 - L * L / (s2 * s2));
  float is = 1.0 / sigma;
  dx = vec3(delta * p.x * is, p.y * is, (L / s2 - uA + uA * P / delta) * is);
  dp = vec2(-0.5 * Fr * is + F * r * is * is, -0.5 * Ft * is - F * a2 * s * c * is * is);
}

// Over the poles a photon moves as if L were 0 (see POLE_CAP in core/kerr.ts): entering
// and leaving the cap, p_theta and phi are adjusted as poleCapMomentum does.
void poleCap(float L, inout vec3 x, inout vec2 q, bool entering) {
  float r = x.x;
  float s2 = max(sin(x.y) * sin(x.y), 1e-12);
  float a2 = uA * uA;
  float delta = r * r - 2.0 * r + a2;
  float P0 = r * r + a2;
  float extra = L * L / s2 - 2.0 * uA * L + (2.0 * uA * L * P0 - a2 * L * L) / delta;
  if (entering) x.z += sign(L) * asin(min(1.0, abs(L) / sqrt(s2 * q.y * q.y + L * L)));
  float p2 = q.y * q.y + (entering ? extra : -extra);
  q.y = (q.y < 0.0 ? -1.0 : 1.0) * sqrt(max(p2, 0.0));
  if (!entering) x.z += sign(L) * asin(min(1.0, abs(L) / sqrt(s2 * q.y * q.y + L * L)));
}

// Page and Thorne's thin disc flux (units of 3 Mdot / 8 pi, M = 1).
float discFlux(float r) {
  if (r <= uRisco) return 0.0;
  float a = uA;
  float x = sqrt(r), x0 = sqrt(uRisco);
  float t = acos(clamp(a, -1.0, 1.0));
  float x1 = 2.0 * cos((t - PI) / 3.0), x2 = 2.0 * cos((t + PI) / 3.0), x3 = -2.0 * cos(t / 3.0);
  float b = x - x0 - 1.5 * a * log(x / x0)
    - 3.0 * (x1 - a) * (x1 - a) / (x1 * (x1 - x2) * (x1 - x3)) * log((x - x1) / (x0 - x1))
    - 3.0 * (x2 - a) * (x2 - a) / (x2 * (x2 - x1) * (x2 - x3)) * log((x - x2) / (x0 - x2))
    - 3.0 * (x3 - a) * (x3 - a) / (x3 * (x3 - x1) * (x3 - x2)) * log((x - x3) / (x0 - x3));
  return 3.0 / (8.0 * PI) * b / (x * x * x * x * (x * x * x - 3.0 * x + 2.0 * a));
}

// nu_obs / nu_emit for gas circling at angular velocity omega at (r, theta).
float redshift(float r, float th, float omega, float L, float eCam) {
  float s = sin(th), c = cos(th);
  float s2 = s * s, a2 = uA * uA;
  float sigma = r * r + a2 * c * c;
  float A = (r * r + a2) * (r * r + a2) - a2 * (r * r - 2.0 * r + a2) * s2;
  float gtt = -(1.0 - 2.0 * r / sigma), gtp = -2.0 * uA * r * s2 / sigma, gpp = A * s2 / sigma;
  float norm = -(gtt + 2.0 * omega * gtp + omega * omega * gpp);
  if (norm <= 1e-6) {
    omega = 2.0 * uA * r / A;
    norm = -(gtt + 2.0 * omega * gtp + omega * omega * gpp);
  }
  float ut = 1.0 / sqrt(max(norm, 1e-8));
  return eCam / (ut * (1.0 - omega * L));
}

float flowEmissivity(float r, float th) {
  if (r < uRh) return 0.0;
  float c = cos(th);
  float x = (r - uRh) / 0.5;
  float k = -1.5 + log(x + sqrt(x * x + 1.0));
  return exp(-0.5 * k * k) / sqrt(x * x + 1.0) * exp(-c * c / (2.0 * 0.35 * 0.35));
}

// A thin disc's colour where the ray crosses it at radius r (linear, scaled for display).
vec3 discColour(float r, float th, float L, float eCam) {
  float f = discFlux(r);
  if (f <= 0.0) return vec3(0.0);
  float g = redshift(r, th, 1.0 / (pow(r, 1.5) + uA), L, eCam);
  float t = g * uTstar * pow(f, 0.25);
  return kelvinToRgb(t) * radianceV(t) * uDiscExposure;
}

// The first hit of a straight segment with the companion's sphere: distance along it, or -1.
float hitSphere(vec3 o, vec3 d, float len) {
  if (uComp.w <= 0.0) return -1.0;
  vec3 oc = o - uComp.xyz;
  float b = dot(oc, d);
  float c = dot(oc, oc) - uComp.w * uComp.w;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  float t = -b - sqrt(disc);
  return t >= 0.0 && t <= len ? t : -1.0;
}

vec3 starColour(vec3 hit, vec3 d) {
  vec3 n = normalize(hit - uComp.xyz);
  float mu = max(dot(n, -d), 0.0);
  float limb = 0.3 + 0.93 * mu - 0.23 * mu * mu;
  return kelvinToRgb(uCompTeff) * radianceV(uCompTeff) * uCompExposure * limb;
}

vec3 sky(vec3 dirBH) {
  vec3 v = uBHToView * dirBH;
  if (v.z < 0.0) {
    vec2 ndc = v.xy / (-v.z) / uTan;
    if (max(abs(ndc.x), abs(ndc.y)) < 0.985) return texture2D(uView, ndc * 0.5 + 0.5).rgb;
  }
  return textureCube(uSky, uBHToScene * dirBH).rgb;
}

void main() {
  vec3 d = normalize(uViewToBH * vec3(vNdc * uTan, -1.0));
  vec3 p = uCam;
  vec3 emit = vec3(0.0);      // linear light from the disc, flow or companion
  float flow = 0.0;           // integrated 230 GHz intensity
  bool blocked = false;       // the horizon, or an opaque disc or star
  vec3 dirOut = d;
  float bFar = length(cross(p, d));
  float eCam = sqrt(max(1.0 - 2.0 / uCamR, 0.0));
  bool far = uCamR > R_START;
  float rDisc = uRisco; // a disc crossing on the straight remainder of the ray must lie beyond this

  if (bFar < B_FAR && !(far && dot(p, d) > 0.0)) {
    // Start the integration at the camera, or where the ray first comes within R_START.
    if (far) {
      float b0 = dot(p, d);
      float t = -b0 - sqrt(max(b0 * b0 - dot(p, p) + R_START * R_START, 0.0));
      float hs = hitSphere(p, d, t);
      if (hs >= 0.0) { emit = starColour(p + d * hs, d); blocked = true; }
      p += d * t;
    }
    if (!blocked) {
      // The photon reaching the camera along -d, normalised to unit energy at infinity.
      float r0 = sqrt(0.5 * (dot(p, p) - uA * uA + sqrt(pow(dot(p, p) - uA * uA, 2.0) + 4.0 * uA * uA * p.z * p.z)));
      float th0 = acos(clamp(p.z / r0, -1.0, 1.0));
      float az = atan(p.y, p.x);
      float ph0 = az - atan(uA, r0) + phiShift(r0);
      float s = sin(th0), c = cos(th0);
      vec3 er = vec3(s * cos(az), s * sin(az), c);
      vec3 et = vec3(c * cos(az), c * sin(az), -s);
      vec3 ef = vec3(-sin(az), cos(az), 0.0);
      float nr = -dot(d, er), nt = -dot(d, et), nf = -dot(d, ef);
      float a2 = uA * uA;
      float sigma = r0 * r0 + a2 * c * c;
      float delta = r0 * r0 - 2.0 * r0 + a2;
      float A = (r0 * r0 + a2) * (r0 * r0 + a2) - a2 * delta * s * s;
      float E = sqrt(sigma * delta / A) + 2.0 * uA * r0 / A * sqrt(A / sigma) * s * nf;
      float L = sqrt(A / sigma) * s * nf / E;
      if (!far) eCam = 1.0 / E;
      vec3 x = vec3(r0, th0, ph0);
      vec2 q = vec2(sqrt(sigma / delta) * nr, sqrt(sigma) * nt) / E;
      vec3 prev = p;
      bool done = false;
      bool inCap = false;
      for (int i = 0; i < 600; i++) {
        if (i >= uMaxSteps) break;
        if (x.x < uRh * 1.01 + 0.02) { blocked = true; done = true; break; }
        float sn = abs(sin(x.y));
        if (L != 0.0 && (inCap ? sn >= POLE_CAP : sn < POLE_CAP && abs(L) < 0.3 * sqrt(sn * sn * q.y * q.y + L * L))) {
          inCap = !inCap;
          poleCap(L, x, q, inCap);
        }
        float Le = inCap ? 0.0 : L;
        vec3 k1x, k2x, k3x, k4x; vec2 k1p, k2p, k3p, k4p;
        deriv(Le, x, q, k1x, k1p);
        // Step control as stepSize in core/kerr.ts.
        float rScale = min(x.x, max(x.x - uRh, 0.05) * 2.0);
        float thetaRate = abs(k1x.y) * max(1.0, 0.25 / max(sn, 0.2 * POLE_CAP));
        float rate = max(max(abs(k1x.x) / rScale, thetaRate), max(abs(k1x.z) * max(sn, 0.25), 1e-6));
        float h = uEps / rate;
        deriv(Le, x - 0.5 * h * k1x, q - 0.5 * h * k1p, k2x, k2p);
        deriv(Le, x - 0.5 * h * k2x, q - 0.5 * h * k2p, k3x, k3p);
        deriv(Le, x - h * k3x, q - h * k3p, k4x, k4p);
        vec3 nx = x - h / 6.0 * (k1x + 2.0 * k2x + 2.0 * k3x + k4x);
        vec2 nq = q - h / 6.0 * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);
        vec3 next = toCartesian(nx.x, nx.y, nx.z);
        // The companion, along this step's chord.
        vec3 chord = next - prev;
        float len = length(chord);
        float hs = hitSphere(prev, chord / max(len, 1e-9), len);
        if (hs >= 0.0) { emit += starColour(prev + chord / len * hs, chord / len); blocked = true; done = true; break; }
        if (uFlow == 1) {
          float c0 = cos(x.y), c1 = cos(nx.y);
          if (c0 * c1 <= 0.0 && c0 != c1) {
            float rc = mix(x.x, nx.x, c0 / (c0 - c1));
            if (rc >= uRisco && rc <= uDiscOuter) { emit += discColour(rc, 0.5 * PI, L, eCam); blocked = true; done = true; break; }
          }
        } else if (uFlow == 2) {
          float rm = 0.5 * (x.x + nx.x);
          if (rm < 50.0) {
            float tm = 0.5 * (x.y + nx.y);
            float j = flowEmissivity(rm, tm);
            if (j > 0.0) {
              float g = redshift(rm, tm, 1.0 / (pow(max(rm * abs(sin(tm)), uRisco), 1.5) + uA), L, eCam);
              flow += g * g * g * j * h;
            }
          }
        }
        if (nx.x > max(R_ESCAPE, uCamR * 1.01) && nx.x > x.x) {
          // Escaped: the tangent, plus the bending still to come (weak field).
          vec3 dir = normalize(next - prev);
          float bImp = length(cross(next, dir));
          float sAlong = dot(next, dir);
          float rest = 2.0 / max(bImp, 1e-3) * (1.0 - sAlong / sqrt(sAlong * sAlong + bImp * bImp));
          vec3 toward = -(next - dir * sAlong);
          if (length(toward) > 1e-6) dir = normalize(dir + normalize(toward) * rest);
          dirOut = dir;
          p = next;
          rDisc = length(next) * 0.99;
          done = true;
          break;
        }
        x = nx; q = nq; prev = next;
      }
      if (!done) blocked = true; // still circling after the step budget: as good as captured
    }
  } else {
    // Weak field: bend the straight ray toward the hole by the deflection still ahead of it,
    // alpha = (2/b)(1 - s/sqrt(s^2 + b^2)) (1 + 15 pi / 16 b), with s its distance past closest approach.
    float s0 = dot(p, d);
    float alpha = 2.0 / bFar * (1.0 - s0 / sqrt(s0 * s0 + bFar * bFar)) * (1.0 + 15.0 * PI / (16.0 * bFar));
    vec3 toward = -normalize(p - d * s0);
    dirOut = normalize(d + toward * tan(min(alpha, 1.5)));
    float hs = hitSphere(p, d, 1e12);
    if (hs >= 0.0) { emit = starColour(p + d * hs, d); blocked = true; }
  }

  // A thin disc extending beyond where the ray was integrated (far out it is straight).
  if (!blocked && uFlow == 1 && abs(dirOut.z) > 1e-6) {
    float t = -p.z / dirOut.z;
    if (t > 0.0) {
      vec3 hit = p + dirOut * t;
      float rc = length(hit.xy);
      if (rc >= rDisc && rc <= uDiscOuter) {
        // Seen from far, the camera's frame is static (e = 1) and L from the straight ray.
        float L = cross(hit, -dirOut).z;
        emit += discColour(rc, 0.5 * PI, L, eCam);
        blocked = true;
      }
    }
  }
  if (!blocked && uComp.w > 0.0 && length(p - uCam) > 0.0) {
    float hs = hitSphere(p, dirOut, 1e12);
    if (hs >= 0.0) { emit += starColour(p + dirOut * hs, dirOut); blocked = true; }
  }

  vec3 colour = blocked ? vec3(0.0) : decode(sky(dirOut)) * uBackground;
  if (uFlow == 2) colour += decode(afmhot(film(vec3(flow * uFlowExposure)).r));
  colour += film(emit);
  gl_FragColor = vec4(encode(colour), 1.0);
}
`;

export interface BlackHoleParams {
  spin: number;
  flow: 0 | 1 | 2;
  discOuter: number;
  tStar: number;
  discExposure: number;
  flowExposure: number;
  background: number;
  /** Companion centre in the black hole's frame (M) and radius (M); radius 0 for none. */
  companion: [number, number, number, number];
  companionTeff: number;
  companionExposure: number;
}

export class BlackHoleView {
  readonly view: THREE.WebGLRenderTarget;
  readonly sky: THREE.WebGLCubeRenderTarget;
  readonly faces: THREE.PerspectiveCamera[];
  private readonly material: THREE.ShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** Camera position when the sky was last drawn (scene km), and when. */
  private skyAt: Vec3 | undefined;
  private skyFrame = -1e9;
  resolution = 1;

  constructor(skySize = 512) {
    this.view = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
    this.sky = new THREE.WebGLCubeRenderTarget(skySize, { depthBuffer: true, generateMipmaps: false });
    const cube = new THREE.CubeCamera(1e-5, 1e13, this.sky);
    cube.coordinateSystem = THREE.WebGLCoordinateSystem;
    cube.updateCoordinateSystem();
    this.faces = cube.children as THREE.PerspectiveCamera[];
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTan: { value: new THREE.Vector2(1, 1) },
        uViewToBH: { value: new THREE.Matrix3() },
        uBHToView: { value: new THREE.Matrix3() },
        uBHToScene: { value: new THREE.Matrix3() },
        uCam: { value: new THREE.Vector3() },
        uCamR: { value: 30 },
        uA: { value: 0 },
        uRh: { value: 2 },
        uRisco: { value: 6 },
        uEps: { value: 0.07 },
        uMaxSteps: { value: 400 },
        uFlow: { value: 0 },
        uDiscOuter: { value: 1000 },
        uTstar: { value: 1e7 },
        uDiscExposure: { value: 1 },
        uFlowExposure: { value: 1 },
        uBackground: { value: 1 },
        uComp: { value: new THREE.Vector4() },
        uCompTeff: { value: 5800 },
        uCompExposure: { value: 1 },
        uView: { value: this.view.texture },
        uSky: { value: this.sky.texture },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  get uniforms() {
    return this.material.uniforms;
  }

  /** Quality: the integration's step size and step budget. */
  setQuality(level: 'high' | 'normal' | 'low'): void {
    const u = this.material.uniforms;
    u.uEps.value = level === 'high' ? 0.04 : level === 'normal' ? 0.07 : 0.12;
    u.uMaxSteps.value = level === 'high' ? 600 : level === 'normal' ? 400 : 200;
  }

  /** Does the sky cube need redrawing? (It is the same in every direction the camera turns.) */
  skyStale(eye: Vec3, nearestKm: number, frame: number): boolean {
    if (!this.skyAt) return true;
    const moved = Math.hypot(eye[0] - this.skyAt[0], eye[1] - this.skyAt[1], eye[2] - this.skyAt[2]);
    return moved > nearestKm * 0.002 || frame - this.skyFrame > 30;
  }

  /**
   * Draw the sky cube around the camera (at the scene origin). `prepare` is called
   * before each face so camera-dependent layers can set up for it.
   */
  renderSky(renderer: THREE.WebGLRenderer, scene: THREE.Scene, eye: Vec3, frame: number, prepare: (camera: THREE.PerspectiveCamera, size: number) => void): void {
    const previous = renderer.getRenderTarget();
    this.faces.forEach((face, k) => {
      face.position.set(0, 0, 0);
      face.updateMatrixWorld();
      prepare(face, this.sky.width);
      renderer.setRenderTarget(this.sky, k);
      renderer.clear();
      renderer.render(scene, face);
    });
    renderer.setRenderTarget(previous);
    this.skyAt = [eye[0], eye[1], eye[2]];
    this.skyFrame = frame;
  }

  /** Draw the scene as the camera sees it, into the view texture. */
  renderView(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.view.width !== size.x || this.view.height !== size.y) this.view.setSize(size.x, size.y);
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.view);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(previous);
  }

  /**
   * The ray-traced frame, to the screen.
   * @param camBH camera position in the hole's frame (Kerr-Schild Cartesian, units of M)
   * @param sceneToBH rotation from scene axes to the hole's frame (z = spin axis)
   */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, camBH: Vec3, sceneToBH: THREE.Matrix3, p: BlackHoleParams): void {
    const u = this.material.uniforms;
    const tanY = Math.tan((camera.fov * Math.PI) / 360);
    u.uTan.value.set(tanY * camera.aspect, tanY);
    const viewToScene = new THREE.Matrix3().setFromMatrix4(camera.matrixWorld);
    (u.uViewToBH.value as THREE.Matrix3).multiplyMatrices(sceneToBH, viewToScene);
    (u.uBHToView.value as THREE.Matrix3).copy(u.uViewToBH.value).transpose();
    (u.uBHToScene.value as THREE.Matrix3).copy(sceneToBH).transpose();
    u.uCam.value.set(camBH[0], camBH[1], camBH[2]);
    u.uCamR.value = cartesianToBL(p.spin, camBH)[0];
    u.uA.value = p.spin;
    u.uRh.value = horizon(p.spin);
    u.uRisco.value = isco(p.spin);
    u.uFlow.value = p.flow;
    u.uDiscOuter.value = p.discOuter;
    u.uTstar.value = p.tStar;
    u.uDiscExposure.value = p.discExposure;
    u.uFlowExposure.value = p.flowExposure;
    u.uBackground.value = p.background;
    u.uComp.value.set(...p.companion);
    u.uCompTeff.value = p.companionTeff;
    u.uCompExposure.value = p.companionExposure;
    renderer.render(this.scene, this.quadCamera);
  }
}
