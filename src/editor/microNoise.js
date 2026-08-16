// microNoise.js — WYSIWYG grain for editor preview materials.
//
// The game draws micro-voxel objects with the untextured chunk material
// (chunkShader.js), which jitters luminance per object-local micro-cell so
// single-color voxels don't read flat. Editor previews (the F2 item editor
// viewport, the placement ghost) use plain MeshBasicMaterial instead, so this
// injects the SAME hash into those materials via onBeforeCompile — identical
// cell addressing (position - normal * 0.5, object-local units) and identical
// hash constants, so the grain painted in the editor is the grain placed in
// the world. Keep the GLSL in lockstep with chunkShader.js.

import { CONFIG } from '../config.js';

/**
 * Patch a MeshBasicMaterial (vertexColors) so it applies the micro-voxel
 * luminance grain. Returns the material for inline use.
 * @param {import('three').Material} material
 * @returns {import('three').Material}
 */
export function applyMicroNoise(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNoiseAmp = { value: CONFIG.lighting.itemNoiseAmp ?? 0.05 };
    shader.uniforms.uNoiseScale = { value: CONFIG.lighting.itemNoiseScale ?? 1 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNoisePos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNoisePos = position - normal * 0.5;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vNoisePos;
uniform float uNoiseAmp;
uniform float uNoiseScale;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 noiseCell = floor(vNoisePos * uNoiseScale);
  float grain = fract(sin(dot(noiseCell, vec3(127.1, 311.7, 74.7))) * 43758.5453);
  diffuseColor.rgb = clamp(diffuseColor.rgb * (1.0 + uNoiseAmp * (grain * 2.0 - 1.0)), 0.0, 1.0);
}`);
  };
  // Patched and unpatched MeshBasicMaterials must not share a compiled program.
  material.customProgramCacheKey = () => 'micro-noise';
  return material;
}
