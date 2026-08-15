// CubeDeleteTool.js — delete a whole cuboid picked by two corner voxels.
//
// LMB on a voxel pins the first corner, LMB on a second voxel deletes the
// axis-aligned box those two cells span diagonally (both corners included).
// RMB (or losing the pointer lock) drops a pending corner.
//
// Everything whose footprint touches the box goes: voxels (a BIG voxel or a
// door poking into the box leaves entirely — the box is a region, not a
// slicer), their face decals, and placed items. Mob/NPC spawns and splash
// cameras are markers, not world content, and stay put. The whole cuboid
// lands as ONE history entry.
//
// The preview ghosts every cell for small boxes; past SOLID_PREVIEW_CELLS it
// ghosts only the box edges, so aiming a 60x60x60 region stays cheap and the
// wireframe still reads as a cube.

import { Tool } from '../Tool.js';
import { cubeDeleteCommand } from '../commands.js';
import { itemAwarePick } from '../itemPick.js';
import { cellsFor } from '../../engine/VoxelShape.js';
import { footprintCells, quarterTurns } from '../../engine/ItemTypes.js';
import { SIZE } from '../../engine/VoxelTypes.js';
import { Notice } from '../Notice.js';

/** Above this cell count the preview shows edges only, not the filled box. */
export const SOLID_PREVIEW_CELLS = 1024;

/** Inclusive min/max cell corners of the box two cells span diagonally. */
export function boxBetween(a, b) {
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

/**
 * Cells to ghost for a box: every cell while the box is small, else only the
 * cells along its 12 edges (O(w+h+d)) so an enormous region still previews
 * instantly.
 */
export function previewCells(min, max, maxSolid = SOLID_PREVIEW_CELLS) {
  const dims = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
  const out = [];
  if (dims[0] * dims[1] * dims[2] <= maxSolid) {
    for (let x = min[0]; x <= max[0]; x++) {
      for (let y = min[1]; y <= max[1]; y++) {
        for (let z = min[2]; z <= max[2]; z++) out.push([x, y, z]);
      }
    }
    return out;
  }
  // Walk each axis with the other two pinned to their extremes (deduped,
  // since a 1-thick box has both extremes on the same coordinate).
  const seen = new Set();
  for (let axis = 0; axis < 3; axis++) {
    const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    for (const a of new Set([min[u], max[u]])) {
      for (const b of new Set([min[v], max[v]])) {
        for (let t = min[axis]; t <= max[axis]; t++) {
          const c = [0, 0, 0];
          c[axis] = t;
          c[u] = a;
          c[v] = b;
          const k = c.join(',');
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(c);
        }
      }
    }
  }
  return out;
}

/** True when any cell of the footprint lies inside the inclusive box. */
function touchesBox(cells, min, max) {
  for (const [x, y, z] of cells) {
    if (x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2]) return true;
  }
  return false;
}

/**
 * Voxels and items whose footprint overlaps the box. Walks the world's own
 * indexes (O(#voxels + #items)), so a huge box costs no more than a small one.
 * @returns {{voxels: object[], items: object[]}}
 */
export function contentInBox(world, min, max) {
  const voxels = [];
  const items = [];
  world.forEachVoxel((v) => {
    if (touchesBox(cellsFor(v.anchor[0], v.anchor[1], v.anchor[2], v.size, v.rotation ?? 0), min, max)) voxels.push(v);
  });
  world.forEachItem((it) => {
    const span = footprintCells(it.cells);
    const turns = quarterTurns(it.rotation ?? 0);
    if (touchesBox(cellsFor(it.anchor[0], it.anchor[1], it.anchor[2], span, turns), min, max)) items.push(it);
  });
  return { voxels, items };
}

export class CubeDeleteTool extends Tool {
  constructor(ctx) {
    super({ id: 'cubedelete', name: 'Cube Delete', ctx });
    this._corner = null; // first picked cell, or null while nothing is pinned
    this._aim = null; // last aimed cell, so the preview survives a miss
    this.lastAction = '';
  }

  /** Item-aware pick: a placed object's face is a valid corner too. */
  pick() {
    return itemAwarePick(this.ctx.world, this.ctx.THREE, this.ctx.camera);
  }

  onMouseDown(button) {
    if (button === 2) {
      if (!this._corner) return;
      this._reset();
      this.lastAction = 'Cube delete cancelled';
      Notice.info('Cube delete cancelled');
      return;
    }
    if (button !== 0) return;
    const hit = this.pick();
    if (!hit) {
      Notice.warn('Aim at a voxel to pick a corner');
      return;
    }
    if (!this._corner) {
      this._corner = [...hit.cell];
      this._aim = [...hit.cell];
      this.lastAction = 'Cube delete: first corner';
      Notice.info('First corner set — click the opposite corner');
      return;
    }
    this._commit(hit.cell);
  }

  /** Delete everything in the box between the pinned corner and `end`. */
  _commit(end) {
    const { world, history } = this.ctx;
    const { min, max } = boxBetween(this._corner, end);
    this._reset();
    const { voxels, items } = contentInBox(world, min, max);
    if (voxels.length === 0 && items.length === 0) {
      Notice.warn('Nothing inside that cube');
      return;
    }
    const cmd = cubeDeleteCommand(world, { voxels, items }, () => this.ctx.onItemChange?.());
    const n = cmd.do();
    if (n === 0) return;
    history.push(cmd);
    const dims = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
    this.lastAction = `Cube deleted ${n} (${dims.join('×')})`;
    Notice.info(`Deleted ${n} in a ${dims.join('×')} cube`);
  }

  update() {
    const { ghost, world } = this.ctx;
    const hit = this.pick();
    if (!this._corner) {
      // Nothing pinned yet: highlight the voxel that would become corner one.
      ghost.hideCells();
      const voxel = hit && world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
      if (voxel) ghost.showRemoval(voxel.anchor, voxel.size);
      else ghost.hide();
      return;
    }
    if (hit) this._aim = [...hit.cell];
    const { min, max } = boxBetween(this._corner, this._aim);
    ghost.hide();
    ghost.showCells(previewCells(min, max), SIZE.SMALL, true);
  }

  _reset() {
    this._corner = null;
    this._aim = null;
    this.hide();
  }

  onDeactivate() {
    this._reset();
  }

  /** Pointer lock lost / overlay opened — drop the pending corner. */
  cancel() {
    this._reset();
  }

  hide() {
    this.ctx.ghost.hideCells();
    this.ctx.ghost.hide();
  }
}
