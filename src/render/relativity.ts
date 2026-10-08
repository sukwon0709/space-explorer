import * as THREE from 'three';
import type { Vec3 } from '../core/ephemeris';
import { gammaOf } from '../core/relativity';

export { RELATIVITY_GLSL } from '../core/relativity';

/**
 * The ship's velocity for every shader that draws the sky (core/relativity.ts): shared
 * uniform objects, so one update reaches them all. Spread into a material's uniforms.
 */
export const relativityUniforms = {
  uBetaView: { value: new THREE.Vector3() },
  uGamma: { value: 1 },
};

const v = new THREE.Vector3();

/**
 * Set the observer's velocity (fraction of c, scene axes) for a camera: the shaders take
 * it in view axes. Zero turns every effect off.
 */
export function setRelativity(betaScene: Vec3, camera: THREE.Camera): void {
  const b = Math.hypot(betaScene[0], betaScene[1], betaScene[2]);
  if (b < 1e-7) {
    relativityUniforms.uBetaView.value.set(0, 0, 0);
    relativityUniforms.uGamma.value = 1;
    return;
  }
  camera.updateMatrixWorld();
  v.set(betaScene[0], betaScene[1], betaScene[2]).transformDirection(camera.matrixWorldInverse).multiplyScalar(b);
  relativityUniforms.uBetaView.value.copy(v);
  // Kept just above 1 for tiny speeds, so the shaders' "at rest" test still sees motion.
  relativityUniforms.uGamma.value = Math.max(gammaOf(b), 1 + 1e-6);
}
