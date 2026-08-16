// Swatches.js — small canvas previews of atlas tiles, shared by the
// Toolbar and Inventory. Uses the pure pixel generator, so it needs only
// a DOM canvas (browser).

import { generateTilePixels, tilePixelDims, TILE_SIZE } from '../textures/TextureAtlas.js';
import { tileFor, getBlock, getDecal } from '../engine/VoxelTypes.js';

/**
 * Build an HTMLCanvasElement preview for a block's tile: an explicit icon
 * tile when the def names one (car parts, whose top face is plain paint),
 * else the top tile.
 * @param {string} blockId
 * @param {number} [scale]
 */
export function buildSwatch(blockId, scale = 4) {
  const tile = getBlock(blockId)?.icon ?? tileFor(blockId, 'py') ?? tileFor(blockId, 'px');
  const [w, h] = tilePixelDims(tile);
  const pixels = generateTilePixels(tile);
  const canvas = document.createElement('canvas');
  canvas.width = TILE_SIZE * scale;
  canvas.height = TILE_SIZE * scale;
  const ctx = canvas.getContext('2d');
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  tmp.getContext('2d').putImageData(new ImageData(pixels, w, h), 0, 0);
  ctx.imageSmoothingEnabled = false;
  // Multi-slot art (doors, 32x64) letterboxes into the square swatch,
  // keeping its aspect so the leaf stays recognizable.
  const fit = Math.min(canvas.width / w, canvas.height / h);
  const dw = w * fit;
  const dh = h * fit;
  ctx.drawImage(tmp, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  return canvas;
}

/**
 * @param {{id:string, name:string}[]} items
 * @returns {{id:string, name:string, canvas:HTMLCanvasElement}[]}
 */
export function buildSwatchList(items) {
  return items.map((it) => ({ ...it, canvas: buildSwatch(it.id) }));
}

/**
 * Preview canvas for a decal tile — drawn over a neutral gray so the alpha
 * cutout reads like it would on a concrete face.
 * @param {string} decalId
 * @param {number} [scale]
 */
export function buildDecalSwatch(decalId) {
  const tile = getDecal(decalId)?.tile;
  const [w, h] = tilePixelDims(tile);
  // Scale so the longest edge lands near 64px (4x for 16px art, 1x for 64px).
  const scale = Math.max(1, Math.floor(64 / Math.max(w, h)));
  const pixels = generateTilePixels(tile);
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#8f8f8f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  tmp.getContext('2d').putImageData(new ImageData(pixels, w, h), 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, w * scale, h * scale);
  return canvas;
}

/**
 * @param {{id:string, name:string}[]} decals
 * @returns {{id:string, name:string, canvas:HTMLCanvasElement}[]}
 */
export function buildDecalSwatchList(decals) {
  return decals.map((it) => ({ ...it, canvas: buildDecalSwatch(it.id) }));
}
