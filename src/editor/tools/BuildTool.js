// BuildTool.js — single-voxel placement/removal + shift-drag lines.
//
// LMB places (Shift+LMB draws a line from the last placed voxel), RMB removes
// the whole voxel under the cursor. Every edit goes through a Command pushed
// onto History so it can be undone.

import { Tool } from '../Tool.js';
import { placeCommand, removeCommand, multiPlaceCommand } from '../commands.js';
import { orthogonalLineAnchors } from './line.js';
import { spanFor } from '../../engine/VoxelShape.js';
import { Notice } from '../Notice.js';

export class BuildTool extends Tool {
  constructor(ctx) {
    super({ id: 'build', name: 'Build', ctx });
    this.lastPlaced = null;
    this.lastAction = '';
  }

  get type() {
    return this.ctx.state.get('blockId');
  }

  get size() {
    return this.ctx.state.get('size');
  }

  setType(type) {
    this.ctx.state.set('blockId', type);
  }

  setSize(size) {
    this.ctx.state.set('size', size);
  }

  toggleSize() {
    const next = this.size === 'small' ? 'big' : 'small';
    this.setSize(next);
    return next;
  }

  /** Place the selected block adjacent to the hovered face. */
  place() {
    if (!this.type) return { ok: false };
    const { world, history } = this.ctx;
    const hit = this.pick();
    if (!hit) return { ok: false };
    const anchor = this.placementAnchor(hit, this.size);

    if (this.isShift && this.lastPlaced) {
      const cells = orthogonalLineAnchors(this.lastPlaced, anchor, this.size);
      const cmd = multiPlaceCommand(world, cells, this.type, this.size);
      if (cmd.do() > 0) {
        history.push(cmd);
        this.lastPlaced = cells[cells.length - 1];
        this.lastAction = `Placed ${cells.length} ${this.type} (line)`;
        return { ok: true, anchor, size: this.size, type: this.type, count: cells.length };
      }
      return { ok: false, reason: 'Nothing could be placed on that line' };
    }

    const cmd = placeCommand(world, { type: this.type, size: this.size, anchor });
    if (cmd.do()) {
      history.push(cmd);
      this.lastPlaced = anchor;
      this.lastAction = `Placed ${this.type} (${this.size})`;
      return { ok: true, anchor, size: this.size, type: this.type };
    }
    Notice.warn('Cannot place there — overlaps another block');
    return { ok: false, reason: 'blocked' };
  }

  /** Remove the voxel under the cursor (whole voxel, incl. BIG). */
  remove() {
    const { world, history } = this.ctx;
    const hit = this.pick();
    if (!hit) return { ok: false };
    const voxel = world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!voxel) return { ok: false };
    const cmd = removeCommand(world, voxel);
    if (cmd.do()) {
      history.push(cmd);
      this.lastAction = `Removed ${voxel.type}`;
      return { ok: true, removed: voxel };
    }
    return { ok: false };
  }

  /** Refresh the placement/removal ghosts from the current aim. */
  updateGhost() {
    const { world, ghost } = this.ctx;
    const hit = this.pick();
    this._lastHit = hit;
    if (!hit) {
      ghost.hide();
      return;
    }
    // Nothing in hand: hide the placement preview but keep the removal
    // outline, so RMB can still pick up blocks.
    if (!this.type) {
      ghost.hide();
      ghost.hideCells();
      const voxel = world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
      if (voxel) ghost.showRemoval(voxel.anchor, voxel.size);
      return;
    }
    const anchor = this.placementAnchor(hit, this.size);
    const blocked = !world.isAreaFree(anchor[0], anchor[1], anchor[2], this.size);
    ghost.showPlacement(anchor, this.size, blocked);

    if (this.isShift && this.lastPlaced) {
      ghost.showCells(orthogonalLineAnchors(this.lastPlaced, anchor, this.size), this.size, false);
    }

    const voxel = world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (voxel) ghost.showRemoval(voxel.anchor, voxel.size);
  }

  onMouseDown(button) {
    if (button === 2) {
      // RMB cancels a pending line preview instead of removing a voxel.
      if (this.isShift && this.lastPlaced) {
        this.lastPlaced = null;
        this.ctx.ghost.hide();
        this.lastAction = 'Line cancelled';
        Notice.info('Line cancelled');
        return;
      }
      this.remove();
    } else if (button === 0) {
      this.place();
    }
  }

  update(dt) {
    this.updateGhost();
  }

  onActivate() {
    this.lastPlaced = null;
  }

  hide() {
    this.ctx.ghost.hide();
  }

  /** Edge length of the current size in cells (used by HUD/tests). */
  get span() {
    return spanFor(this.size);
  }
}
