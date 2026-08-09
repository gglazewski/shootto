// BuildTool.js — single-voxel placement/removal + shift-drag lines.
//
// LMB places (Shift+LMB draws a line from the last placed voxel). RMB removes
// the voxel under the cursor; HOLDING RMB sweeps — every new voxel the
// crosshair moves onto is removed, and the whole stroke lands as ONE history
// entry. Shift+RMB erases an axis-aligned line from the last removed voxel
// (mirror of Shift+LMB). Every edit goes through a Command pushed onto
// History so it can be undone.

import { Tool } from '../Tool.js';
import { placeCommand, removeCommand, multiPlaceCommand, multiRemoveCommand } from '../commands.js';
import { orthogonalLineAnchors } from './line.js';
import { spanFor } from '../../engine/VoxelShape.js';
import { getBlock } from '../../engine/VoxelTypes.js';
import { worldToCell } from '../../engine/VoxelRaycaster.js';
import { itemAwarePick } from '../itemPick.js';
import { Notice } from '../Notice.js';

export class BuildTool extends Tool {
  constructor(ctx) {
    super({ id: 'build', name: 'Build', ctx });
    this.lastPlaced = null;
    this.lastRemoved = null;
    this._erase = null;
    this.lastAction = '';
  }

  get type() {
    return this.ctx.state.get('blockId');
  }

  /** Blocks with a pinned size (doors are always SIZE.DOOR) override the
   *  small/big toggle. */
  get size() {
    return getBlock(this.type)?.fixedSize ?? this.ctx.state.get('size');
  }

  /** Yaw of the pending placement in quarter turns (R cycles it). */
  get rotation() {
    return this.ctx.state.get('blockRotation') ?? 0;
  }

  /** Slab variant of the pending placement (V cycles it) — only cube-shaped
   *  blocks come in halves; panes and doors always place full. */
  get variant() {
    if ((getBlock(this.type)?.shape ?? 'cube') !== 'cube') return null;
    return this.ctx.state.get('blockVariant') ?? null;
  }

  /** Item-aware pick: placed objects stop the aim ray, so blocks can be
   *  built on top of a table the same as on top of another block. Removal
   *  still only touches voxels (world.get on an item cell is null). */
  pick() {
    return itemAwarePick(this.ctx.world, this.ctx.THREE, this.ctx.camera);
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
      const cmd = multiPlaceCommand(world, cells, this.type, this.size, this.rotation, this.variant);
      const placed = cmd.do();
      if (placed > 0) {
        history.push(cmd);
        this.lastPlaced = cells[cells.length - 1];
        this.lastAction = `Placed ${placed} ${this.type} (line)`;
        return { ok: true, anchor, size: this.size, type: this.type, count: placed };
      }
      Notice.warn('Nothing could be placed on that line');
      return { ok: false, reason: 'Nothing could be placed on that line' };
    }

    const cmd = placeCommand(world, { type: this.type, size: this.size, anchor, rotation: this.rotation, variant: this.variant });
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
      this.lastRemoved = voxel.anchor;
      this.lastAction = `Removed ${voxel.type}`;
      return { ok: true, removed: voxel };
    }
    return { ok: false };
  }

  /** Shift+RMB: erase an axis-aligned line from the last removed voxel. */
  eraseLine() {
    const { world, history } = this.ctx;
    const hit = this.pick();
    if (!hit) return { ok: false };
    const target = world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!target) return { ok: false };
    const cells = orthogonalLineAnchors(this.lastRemoved, target.anchor, this.size);
    const voxels = this.voxelsAt(cells, this.size);
    const cmd = multiRemoveCommand(world, voxels);
    const n = cmd.do();
    if (n === 0) return { ok: false };
    history.push(cmd);
    this.lastRemoved = cells[cells.length - 1];
    this.lastAction = `Removed ${n} (line)`;
    return { ok: true, count: n };
  }

  /** Start a hold-RMB erase stroke; removals batch into one undo entry. */
  _beginErase() {
    this._erase = { voxels: [], lastVoxel: null };
    this._eraseStep(true);
  }

  /**
   * Drill guard: while the aim ray still passes through the voxel we just
   * removed, the ray only reaches deeper blocks because that one is gone —
   * the crosshair has to move onto a new column before the sweep continues.
   */
  _aimsThroughLastRemoved(stroke) {
    const v = stroke.lastVoxel;
    if (!v) return false;
    const { camera, THREE } = this.ctx;
    const o = worldToCell(camera.position.toArray());
    const d = camera.getWorldDirection(new THREE.Vector3());
    const dir = [d.x, d.y, d.z];
    const span = spanFor(v.size);
    let tmin = 0;
    let tmax = Infinity;
    for (let i = 0; i < 3; i++) {
      const lo = v.anchor[i];
      const hi = v.anchor[i] + span;
      if (Math.abs(dir[i]) < 1e-9) {
        if (o[i] < lo || o[i] > hi) return false;
        continue;
      }
      const t1 = (lo - o[i]) / dir[i];
      const t2 = (hi - o[i]) / dir[i];
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
      if (tmin > tmax) return false;
    }
    return true;
  }

  /** Remove the voxel under the cursor once the aim leaves the last one. */
  _eraseStep(force = false) {
    const stroke = this._erase;
    if (!stroke) return;
    const hit = this.pick();
    if (!hit) return;
    if (!force && this._aimsThroughLastRemoved(stroke)) return;
    const { world } = this.ctx;
    const voxel = world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!voxel) return;
    if (!world.remove(voxel.anchor[0], voxel.anchor[1], voxel.anchor[2])) return;
    stroke.voxels.push(voxel);
    stroke.lastVoxel = voxel;
    this.lastRemoved = voxel.anchor;
    this.lastAction = stroke.voxels.length === 1
      ? `Removed ${voxel.type}`
      : `Removing ${stroke.voxels.length}…`;
  }

  /** Close the stroke: one history entry for however many voxels came out. */
  _commitErase() {
    const stroke = this._erase;
    this._erase = null;
    if (!stroke || stroke.voxels.length === 0) return;
    const { world, history } = this.ctx;
    if (stroke.voxels.length === 1) {
      // A plain click stays a plain removal, exactly as before.
      history.push(removeCommand(world, stroke.voxels[0]));
      return;
    }
    history.push(multiRemoveCommand(world, stroke.voxels, { applied: true }));
    this.lastAction = `Removed ${stroke.voxels.length} (sweep)`;
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
      const voxel = world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
      if (this.isShift && this.lastRemoved && voxel) this._showEraseLine(voxel);
      else ghost.hideCells();
      if (voxel) ghost.showRemoval(voxel.anchor, voxel.size, voxel.rotation ?? 0);
      return;
    }
    const anchor = this.placementAnchor(hit, this.size);
    const blocked = !world.isAreaFree(anchor[0], anchor[1], anchor[2], this.size, this.rotation);
    ghost.showPlacement(anchor, this.size, blocked, { blockId: this.type, rotation: this.rotation, variant: this.variant });

    const voxel = world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (this.isShift && this.lastPlaced) {
      // Line preview: red where a cell is occupied, green where it will
      // place. The aim cube stays visible so the axis snap is readable —
      // the line end shows where the line lands, the cube where you aim.
      const cells = orthogonalLineAnchors(this.lastPlaced, anchor, this.size);
      const flags = cells.map((c) => !world.isAreaFree(c[0], c[1], c[2], this.size, this.rotation));
      ghost.showCells(cells, this.size, flags, { keepPlacement: true });
    } else if (this.isShift && this.lastRemoved && voxel) {
      this._showEraseLine(voxel);
    } else {
      ghost.hideCells();
    }

    if (voxel) ghost.showRemoval(voxel.anchor, voxel.size, voxel.rotation ?? 0);
  }

  /** All-red cell preview of the erase line from the last removed voxel. */
  _showEraseLine(voxel) {
    const cells = orthogonalLineAnchors(this.lastRemoved, voxel.anchor, this.size);
    this.ctx.ghost.showCells(cells, this.size, cells.map(() => true), { keepPlacement: true });
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
      if (this.isShift && this.lastRemoved) {
        this.eraseLine();
        return;
      }
      this._beginErase();
    } else if (button === 0) {
      this.place();
    }
  }

  onMouseUp(button) {
    if (button === 2) this._commitErase();
  }

  update(dt) {
    this.updateGhost();
    if (this._erase) this._eraseStep();
  }

  onActivate() {
    this.lastPlaced = null;
    this.lastRemoved = null;
    this._erase = null;
  }

  /** Commit an in-flight erase stroke — its removals already happened. */
  onDeactivate() {
    this._commitErase();
  }

  cancel() {
    this._commitErase();
  }

  hide() {
    this.ctx.ghost.hide();
  }

  /** Edge length of the current size in cells (used by HUD/tests). */
  get span() {
    return spanFor(this.size);
  }
}
