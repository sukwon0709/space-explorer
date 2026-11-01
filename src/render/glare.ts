import * as THREE from 'three';

/**
 * High dynamic range output with glare.
 *
 * The scene is drawn into a half-float target instead of straight to the screen. Every
 * material that tone-maps keeps doing so exactly as before (the target poses as the
 * screen), but the tone curve no longer throws away light brighter than white: it keeps
 * it as an "excess" on top of the displayed value. The excess is what the eye cannot show
 * and scatters instead: the Sun's disc, a star's surface, the glint of the sea, city
 * lights at night.
 *
 * That light is spread by the eye's point spread function (Spencer et al. 1995, "Physically
 * based glare effects for digital images"): a narrow core and wide wings that fall off
 * roughly as 1/theta^2..1/theta^3 out to tens of degrees. It is built as a sum of blurs
 * of doubling width (a downsampled pyramid), each weighted by its angular width so the
 * sum follows the power law whatever the field of view. A bright source blinds the view
 * around it in angle, not in pixels: a narrow field of view sees the glare large.
 *
 * Only the excess scatters; light within range keeps the look every layer was tuned for.
 */

/** Where the tone curve saturates (scene-linear, after exposure): above, light is excess. */
const KNEE = 4.0;
/**
 * The excess is compressed as excess^GAMMA: the Sun's disc is some 10^5 times brighter than
 * sunlit ground, and its glare at that strength would white out the whole view.
 */
const GAMMA = 0.6;

/**
 * The tone curve every tone-mapped material uses: ACES as before (AgX was tried and looked
 * flatter on these scenes) plus the light
 * above its knee, compressed, as excess. Installed as three.js's CustomToneMapping.
 */
export function installGlareToneMapping(): void {
  const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
  const replaced = chunk.replace(
    /vec3 CustomToneMapping\( vec3 color \) \{ return color; \}/,
    `vec3 CustomToneMapping( vec3 color ) {
	vec3 lin = max( color * toneMappingExposure, vec3( 0.0 ) );
	vec3 excess = max( lin - ${KNEE.toFixed(1)}, vec3( 0.0 ) );
	excess = pow( excess, vec3( ${GAMMA.toFixed(2)} ) );
	return ACESFilmicToneMapping( color ) + excess;
}`,
  );
  if (replaced === chunk) throw new Error('glare: three.js tone mapping chunk changed');
  THREE.ShaderChunk.tonemapping_pars_fragment = replaced;
}

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const SRGB = /* glsl */ `
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}`;

/** The light above white, at half resolution (a 4-tap box). */
const EXTRACT = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uTexel;
varying vec2 vUv;
${SRGB}
uniform float uVeil;
// The excess, plus the small part of all light that scatters (veiling glare).
vec3 over(vec2 uv) {
  vec3 c = toLinear(max(texture2D(tSource, uv).rgb, 0.0));
  return max(c - 1.0, 0.0) + uVeil * min(c, 1.0);
}
void main() {
  vec3 c = over(vUv + uTexel * vec2(-0.5, -0.5)) + over(vUv + uTexel * vec2(0.5, -0.5))
         + over(vUv + uTexel * vec2(-0.5, 0.5)) + over(vUv + uTexel * vec2(0.5, 0.5));
  gl_FragColor = vec4(0.25 * c, 1.0);
}`;

/** Halving with the 13-tap filter of Jimenez 2014 (no flicker from small bright sources). */
const DOWN = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uTexel;
varying vec2 vUv;
vec3 s(float x, float y) { return texture2D(tSource, vUv + uTexel * vec2(x, y)).rgb; }
void main() {
  vec3 c = s(0.0, 0.0) * 0.125;
  c += (s(-1.0, -1.0) + s(1.0, -1.0) + s(-1.0, 1.0) + s(1.0, 1.0)) * 0.125;
  c += (s(-2.0, -2.0) + s(2.0, -2.0) + s(-2.0, 2.0) + s(2.0, 2.0)) * 0.03125;
  c += (s(0.0, -2.0) + s(-2.0, 0.0) + s(2.0, 0.0) + s(0.0, 2.0)) * 0.0625;
  gl_FragColor = vec4(c, 1.0);
}`;

/** Doubling: this level's weight times its own light, plus the coarser sum (tent filter). */
const UP = /* glsl */ `
uniform sampler2D tSource;
uniform sampler2D tCoarse;
uniform vec2 uTexel;
uniform float uWeight;
uniform float uHasCoarse;
varying vec2 vUv;
vec3 s(float x, float y) { return texture2D(tCoarse, vUv + uTexel * vec2(x, y)).rgb; }
void main() {
  vec3 coarse = (s(0.0, 0.0) * 4.0 + (s(-1.0, 0.0) + s(1.0, 0.0) + s(0.0, -1.0) + s(0.0, 1.0)) * 2.0
              + s(-1.0, -1.0) + s(1.0, -1.0) + s(-1.0, 1.0) + s(1.0, 1.0)) / 16.0;
  gl_FragColor = vec4(uWeight * texture2D(tSource, vUv).rgb + uHasCoarse * coarse, 1.0);
}`;

/** The picture: the scene within range plus the scattered light, to the screen. */
const COMPOSITE = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tGlare;
uniform float uGlare;
varying vec2 vUv;
${SRGB}
void main() {
  vec3 scene = toLinear(max(texture2D(tScene, vUv).rgb, 0.0));
  vec3 c = min(scene, 1.0) + uGlare * texture2D(tGlare, vUv).rgb;
  // Light past white in one channel bleeds into the others, so a blinding orange star
  // still burns white at its centre (as film and the eye saturate).
  float peak = max(c.r, max(c.g, c.b));
  c += max(peak - 1.0, 0.0) * 0.35;
  gl_FragColor = vec4(toSrgb(clamp(c, 0.0, 1.0)), 1.0);
}`;

export class GlareOutput {
  /** The scene is drawn here (bound by `begin`). */
  readonly target: THREE.WebGLRenderTarget;
  private readonly levels: THREE.WebGLRenderTarget[] = [];
  private readonly ups: THREE.WebGLRenderTarget[] = [];
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly extract: THREE.ShaderMaterial;
  private readonly down: THREE.ShaderMaterial;
  private readonly up: THREE.ShaderMaterial;
  private readonly composite: THREE.ShaderMaterial;
  private width = 0;
  private height = 0;
  /** Strength of the glare: the fraction of the excess the eye scatters. */
  strength = 0.18;
  /**
   * Fraction of the light within range that also scatters, relative to the excess: the
   * eye and a lens scatter a few percent of all light into a veil around bright objects.
   */
  veil = 0.4;

  constructor(samples: number) {
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples, depthBuffer: true });
    // Pose as the screen, so every material tone-maps and encodes as it does there.
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
    (this.target as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const make = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
    this.extract = make(EXTRACT, { tSource: { value: null }, uTexel: { value: new THREE.Vector2() }, uVeil: { value: 0 } });
    this.down = make(DOWN, { tSource: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.up = make(UP, {
      tSource: { value: null }, tCoarse: { value: null }, uTexel: { value: new THREE.Vector2() },
      uWeight: { value: 1 }, uHasCoarse: { value: 0 },
    });
    this.composite = make(COMPOSITE, { tScene: { value: null }, tGlare: { value: null }, uGlare: { value: 0 } });
    this.quad = new THREE.Mesh(geometry, this.extract);
    this.quad.frustumCulled = false;
  }

  private resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.target.setSize(width, height);
    for (const t of [...this.levels, ...this.ups]) t.dispose();
    this.levels.length = 0;
    this.ups.length = 0;
    let w = Math.max(1, width >> 1);
    let h = Math.max(1, height >> 1);
    // Down to a few pixels: the widest level spans much of the view.
    while (this.levels.length < 9) {
      const opts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
      this.levels.push(new THREE.WebGLRenderTarget(w, h, opts));
      this.ups.push(new THREE.WebGLRenderTarget(w, h, opts));
      if (Math.min(w, h) <= 4) break;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
  }

  /** Binds the scene target, sized to the drawing buffer. */
  begin(renderer: THREE.WebGLRenderer): void {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.resize(size.x, size.y);
    renderer.setRenderTarget(this.target);
  }

  private pass(renderer: THREE.WebGLRenderer, material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.quad, this.camera);
  }

  /**
   * Spreads the excess and draws the picture to the screen.
   * @param pixelsPerRadian device pixels per radian at the centre of the view
   */
  end(renderer: THREE.WebGLRenderer, pixelsPerRadian: number): void {
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;

    this.extract.uniforms.tSource.value = this.target.texture;
    this.extract.uniforms.uVeil.value = this.veil;
    this.extract.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.pass(renderer, this.extract, this.levels[0]);
    for (let i = 1; i < this.levels.length; i++) {
      const src = this.levels[i - 1];
      this.down.uniforms.tSource.value = src.texture;
      this.down.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.pass(renderer, this.down, this.levels[i]);
    }

    // Level i is about 2^(i+1) device pixels wide. A 1/theta^n spread of the light
    // (n = 2.5, between the eye's 1/theta^2 and 1/theta^3 wings) weights each width as
    // sigma^(2 - n); the narrowest levels (within the eye's core, ~0.05 deg) and those
    // wider than 40 degrees get nothing.
    const weights = this.levels.map((_, i) => {
      const sigma = 2 ** (i + 1) / pixelsPerRadian;
      const deg = (sigma * 180) / Math.PI;
      const inside = smooth(0.03, 0.12, deg) * (1 - smooth(25, 40, deg));
      return inside * deg ** -0.5;
    });
    const total = weights.reduce((a, b) => a + b, 0) || 1;

    for (let i = this.levels.length - 1; i >= 0; i--) {
      const coarse = this.ups[i + 1];
      this.up.uniforms.tSource.value = this.levels[i].texture;
      this.up.uniforms.tCoarse.value = coarse?.texture ?? null;
      this.up.uniforms.uHasCoarse.value = coarse ? 1 : 0;
      this.up.uniforms.uWeight.value = weights[i] / total;
      if (coarse) this.up.uniforms.uTexel.value.set(1 / coarse.width, 1 / coarse.height);
      this.pass(renderer, this.up, this.ups[i]);
    }

    this.composite.uniforms.tScene.value = this.target.texture;
    this.composite.uniforms.tGlare.value = this.ups[0].texture;
    this.composite.uniforms.uGlare.value = this.strength;
    this.pass(renderer, this.composite, null);

    renderer.autoClear = autoClear;
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
