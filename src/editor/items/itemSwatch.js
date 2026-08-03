// itemSwatch.js — 2D isometric preview of a registered item, used by the
// inventory so placeable objects look like what you place.

import { MICRO_GRID } from '../../engine/ItemTypes.js';

/**
 * @param {object} item ItemDef
 * @param {number} [size] output canvas edge, px
 * @returns {HTMLCanvasElement}
 */
export function buildItemSwatch(item, size = 48) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const vox = item.microVoxels ?? [];
  if (!vox.length) {
    ctx.fillStyle = '#262a33';
    ctx.fillRect(0, 0, size, size);
    return canvas;
  }
  // Isometric projection of grid coords; y is height.
  const cs = size / (MICRO_GRID * 2.4);
  const pts = vox.map((v) => ({
    px: (v.x - v.z) * cs,
    py: ((v.x + v.z) * 0.5 - v.y) * cs,
    c: v.color,
  }));
  const xs = pts.map((p) => p.px);
  const ys = pts.map((p) => p.py);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const ox = (size - (minX + maxX)) / 2 - cs / 2;
  const oy = (size - (minY + maxY)) / 2 - cs / 2;
  // Back-to-front: low screen-y first (they are "deeper").
  const sorted = [...pts].sort((a, b) => a.py - b.py);
  const s = cs * 0.92;
  for (const p of sorted) {
    ctx.fillStyle = `rgb(${p.c[0]},${p.c[1]},${p.c[2]})`;
    ctx.fillRect(p.px + ox, p.py + oy, s, s);
  }
  return canvas;
}
