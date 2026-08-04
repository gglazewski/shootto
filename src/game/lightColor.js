// lightColor.js — sample the world's baked LightField as a color multiplier,
// shared by dynamic game objects (mobs, smoke) so they darken in caves, glow
// warm near torchlight and follow the day/night cycle instead of being
// full-brightness sprites.
//
// Mirrors the chunk shader's lit term:
//   sky = skyAt/15 * skyIntensity, block = blockAt/15,
//   base = max(sky, block), tint = mix(skyTint, blockTint, block/base),
//   lit  = ambientMin + tint * base * lightScale
// The uniform values live on the Renderer's map-less lit material
// (Renderer.itemMaterial), so particles match chunks/mobs exactly.

import { CELL_SIZE } from '../engine/Space.js';

/**
 * Light multiplier {r,g,b} at a world-space position.
 * @param {object} lightField  LightField to sample (skyAt/blockAt)
 * @param {import('three').Material} material  map-less lit ShaderMaterial whose
 *   uniforms carry the lighting constants (Renderer.itemMaterial)
 * @param {number} x  world meters
 * @param {number} y
 * @param {number} z
 * @param {{r:number,g:number,b:number}} [out]  scratch object to fill
 * @returns {{r:number,g:number,b:number}} falls back to full brightness when
 *   there is no light field or material (unit tests / no world).
 */
export function lightColorAt(lightField, material, x, y, z, out = {}) {
  if (!lightField || !material) return { r: 1, g: 1, b: 1 };
  const cx = Math.floor(x / CELL_SIZE);
  const cy = Math.floor(y / CELL_SIZE);
  const cz = Math.floor(z / CELL_SIZE);
  const sky = (lightField.skyAt(cx, cy, cz) / 15) * material.uniforms.uSkyIntensity.value;
  const block = lightField.blockAt(cx, cy, cz) / 15;
  const base = Math.max(sky, block);
  const t = block / Math.max(base, 1e-4);
  const st = material.uniforms.uSkyTint.value;
  const bt = material.uniforms.uBlockTint.value;
  const amb = material.uniforms.uAmbientMin.value;
  const scale = material.uniforms.uLightScale.value;
  out.r = amb + (st.r + (bt.r - st.r) * t) * base * scale;
  out.g = amb + (st.g + (bt.g - st.g) * t) * base * scale;
  out.b = amb + (st.b + (bt.b - st.b) * t) * base * scale;
  return out;
}
