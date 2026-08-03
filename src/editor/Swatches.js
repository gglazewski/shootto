// Swatches.js — small canvas previews of atlas tiles, shared by the
// Toolbar and Inventory. Uses the pure pixel generator, so it needs only
// a DOM canvas (browser).

import { generateTilePixels, TILE_SIZE } from '../textures/TextureAtlas.js';
import { tileFor } from '../engine/VoxelTypes.js';

/**
 * Build an HTMLCanvasElement preview for a block's side tile.
 * @param {string} blockId
 * @param {number} [scale]
 */
export function buildSwatch(blockId, scale = 4) {
  const tile = tileFor(blockId, 'py') ?? tileFor(blockId, 'px');
  const pixels = generateTilePixels(tile);
  const canvas = document.createElement('canvas');
  canvas.width = TILE_SIZE * scale;
  canvas.height = TILE_SIZE * scale;
  const ctx = canvas.getContext('2d');
  const tmp = document.createElement('canvas');
  tmp.width = TILE_SIZE;
  tmp.height = TILE_SIZE;
  tmp.getContext('2d').putImageData(new ImageData(pixels, TILE_SIZE, TILE_SIZE), 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, TILE_SIZE * scale, TILE_SIZE * scale);
  return canvas;
}

/**
 * @param {{id:string, name:string}[]} items
 * @returns {{id:string, name:string, canvas:HTMLCanvasElement}[]}
 */
export function buildSwatchList(items) {
  return items.map((it) => ({ ...it, canvas: buildSwatch(it.id) }));
}
