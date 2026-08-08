// itemSwatch.js — 2D isometric preview canvas for a micro-voxel item.
// Used by the inventory, the catalogues and the editors' live thumbnail.

import { MICRO_GRID } from '../../engine/ItemTypes.js';

/** Draw a small isometric swatch of the item's micro-voxels. The projection is
 *  scaled from the voxels' actual bounds, so long items (16+ cell weapons) fit
 *  the canvas instead of clipping, while a compact 8^3 prop still fills it. */
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
  // Isometric projection of grid coords at unit scale; y is height.
  const pts = vox.map((v) => ({
    px: (v.x - v.z),
    py: ((v.x + v.z) * 0.5 - v.y),
    c: v.color,
  }));
  const xs = pts.map((p) => p.px);
  const ys = pts.map((p) => p.py);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // Fit the projected extent (+1 unit for the voxel squares themselves) into
  // the canvas; cap the cell size so a lone voxel doesn't become a giant blob.
  const extent = Math.max(maxX - minX + 1, maxY - minY + 1);
  const cs = Math.min(size * 0.92 / extent, size / (MICRO_GRID * 1.2));
  const ox = (size - (minX + maxX) * cs) / 2 - cs / 2;
  const oy = (size - (minY + maxY) * cs) / 2 - cs / 2;
  // Back-to-front: low screen-y first (they are "deeper").
  const sorted = [...pts].sort((a, b) => a.py - b.py);
  const s = cs * 0.92;
  for (const p of sorted) {
    ctx.fillStyle = `rgb(${p.c[0]},${p.c[1]},${p.c[2]})`;
    ctx.fillRect(p.px * cs + ox, p.py * cs + oy, s, s);
  }
  return canvas;
}
