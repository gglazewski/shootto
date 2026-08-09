// SquareTool.js — drag a rectangle of voxels on a plane.
//
// The drag must start ON a voxel (init spot is the cell adjacent to the
// clicked face). The CLICKED FACE decides the orientation, and it stays
// locked for the whole drag:
//   - top/bottom face  -> horizontal rectangle (floor/ceiling)
//   - side face        -> vertical rectangle on that face's plane (wall)
//   - Shift at click   -> the other orientation (top face + Shift = wall
//     facing the camera; side face + Shift = floor at that height)
// The far corner is found by intersecting the aim ray with the drag plane,
// so the rectangle can extend into empty space. RMB-drag mirrors LMB-drag as
// an ERASE rectangle on the clicked voxel's own layer (a plain RMB click
// therefore still removes the single voxel under the cursor); the whole
// rectangle lands as one history entry.

import { Tool } from '../Tool.js';
import { multiPlaceCommand, multiRemoveCommand } from '../commands.js';
import { spanFor, anchorFor } from '../../engine/VoxelShape.js';
import { getBlock } from '../../engine/VoxelTypes.js';
import { worldToCell } from '../../engine/VoxelRaycaster.js';
import { itemAwarePick } from '../itemPick.js';
import { Notice } from '../Notice.js';

/** Ray-plane intersection in cell units, or null when parallel/behind. */
export function rayPlaneIntersection(origin, dir, axis, coord) {
  const denom = dir[axis];
  // Tiny threshold: a shallow view angle along the plane must still track
  // the far corner (laying a long floor is exactly this pose); the t cap
  // below bounds how far a near-parallel ray can run.
  if (Math.abs(denom) < 0.02 || !Number.isFinite(denom)) return null;
  const t = (coord - origin[axis]) / denom;
  if (!Number.isFinite(t) || t < 0 || t > 512) return null;
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
}

export class SquareTool extends Tool {
  constructor(ctx) {
    super({ id: 'square', name: 'Square', ctx });
    this._drag = null;
    this.lastAction = '';
  }

  get type() {
    return this.ctx.state.get('blockId');
  }

  get size() {
    return this.ctx.state.get('size');
  }

  /** Yaw of the pending placements in quarter turns (R cycles it). */
  get rotation() {
    return this.ctx.state.get('blockRotation') ?? 0;
  }

  /** Slab variant applied to every placement (V cycles it) — only
   *  cube-shaped blocks come in halves. */
  get variant() {
    if ((getBlock(this.type)?.shape ?? 'cube') !== 'cube') return null;
    return this.ctx.state.get('blockVariant') ?? null;
  }

  /** Item-aware pick, same as BuildTool: a drag can start on a placed
   *  object's face (build a floor on top of a table). */
  pick() {
    return itemAwarePick(this.ctx.world, this.ctx.THREE, this.ctx.camera);
  }

  onMouseDown(button) {
    if (button === 2) {
      // RMB cancels an in-progress place drag; on its own it starts an
      // erase drag on the clicked voxel's layer.
      if (this._drag) {
        this._drag = null;
        this.hide();
        this.lastAction = 'Square cancelled';
        Notice.info('Square cancelled');
        return;
      }
      const hit = this.pick();
      if (!hit) return; // erase drag must start on a voxel too
      const axis = this._planeAxis(hit.normal);
      const axes = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
      // The clicked voxel's own layer, not the adjacent placement cell.
      const anchor = anchorFor(hit.cell[0], hit.cell[1], hit.cell[2], this.size);
      this._drag = { axis, axes, start: anchor, end: anchor, erase: true };
      this.lastAction = axis === 1 ? 'Erase: floor' : 'Erase: wall';
      return;
    }
    if (button !== 0) return;
    // Pinned-size blocks (doors) don't tile into rectangles.
    if (getBlock(this.type)?.fixedSize) {
      Notice.warn('Doors are placed one at a time with the Build tool');
      return;
    }
    // LMB cancels an in-progress erase drag (mirror of RMB on a place drag).
    if (this._drag?.erase) {
      this._drag = null;
      this.hide();
      this.lastAction = 'Erase cancelled';
      Notice.info('Erase cancelled');
      return;
    }
    if (this._drag) return;
    const hit = this.pick();
    if (!hit) return; // init spot must be on a voxel
    const axis = this._planeAxis(hit.normal);
    const axes = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    const anchor = this.placementAnchor(hit, this.size);
    this._drag = { axis, axes, start: anchor, end: anchor };
    this.lastAction = axis === 1 ? 'Square: floor' : 'Square: wall';
  }

  /**
   * Drag-plane axis (the fixed coordinate), locked for the whole drag.
   * The clicked face decides: top/bottom -> floor, side -> wall on that
   * face's plane. Shift flips it — a wall from a floor click rises facing
   * the camera; a floor from a wall click spreads at the clicked height.
   */
  _planeAxis(normal) {
    const nAxis = normal[1] !== 0 ? 1 : normal[0] !== 0 ? 0 : 2;
    if (!this.isShift) return nAxis;
    if (nAxis !== 1) return 1;
    const d = this._lookDir();
    return Math.abs(d[0]) >= Math.abs(d[2]) ? 0 : 2;
  }

  onMouseUp(button) {
    if (this._drag?.erase) {
      if (button === 2) this._commitErase();
      return;
    }
    if (button !== 0 || !this._drag) return;
    const { world, history, ghost } = this.ctx;
    if (!this.type) {
      this._drag = null;
      ghost.hideCells();
      return;
    }
    const cells = this._rectAnchors();
    if (cells.length > 0) {
      const cmd = multiPlaceCommand(world, cells, this.type, this.size, this.rotation, this.variant);
      const placedCount = cmd.do();
      if (placedCount > 0) {
        history.push(cmd);
        this.lastAction = `Placed ${placedCount} ${this.type} (square)`;
      } else {
        Notice.warn('Nothing could be placed there');
      }
    }
    this._drag = null;
    ghost.hideCells();
  }

  update(dt) {
    const { ghost, world } = this.ctx;
    if (!this._drag) {
      // Not dragging: show a single-cell placement preview like the build tool.
      const hit = this.pick();
      if (!hit) {
        ghost.hide();
        return;
      }
      const voxel = world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
      if (!this.type) {
        ghost.hide();
        ghost.hideCells();
        if (voxel) ghost.showRemoval(voxel.anchor, voxel.size);
        return;
      }
      const anchor = this.placementAnchor(hit, this.size);
      const blocked = !world.isAreaFree(anchor[0], anchor[1], anchor[2], this.size);
      ghost.showPlacement(anchor, this.size, blocked, { blockId: this.type, rotation: this.rotation, variant: this.variant });
      if (voxel) ghost.showRemoval(voxel.anchor, voxel.size);
      return;
    }

    // The plane is locked at drag start — only the far corner follows the
    // aim, so the rectangle never flips orientation or jumps planes mid-drag.
    const end = this._aimAnchorOnPlane(this._drag.axis, this._drag.start[this._drag.axis]);
    if (end) this._drag.end = end;
    const cells = this._rectAnchors();
    const flags = cells.map((c) => !world.isAreaFree(c[0], c[1], c[2], this.size));
    ghost.showCells(cells, this.size, flags);
  }

  /** All anchors on the drag plane between start and end, stepping by span. */
  _rectAnchors() {
    const { start, end, axis, axes } = this._drag;
    const span = spanFor(this.size);
    const [u, v] = axes;
    const out = [];
    const u0 = Math.min(start[u], end[u]), u1 = Math.max(start[u], end[u]);
    const v0 = Math.min(start[v], end[v]), v1 = Math.max(start[v], end[v]);
    for (let a = u0; a <= u1; a += span) {
      for (let b = v0; b <= v1; b += span) {
        const c = [0, 0, 0];
        c[axis] = start[axis];
        c[u] = a;
        c[v] = b;
        out.push(c);
      }
    }
    return out;
  }

  _lookDir() {
    const { camera, THREE } = this.ctx;
    const dir = camera.getWorldDirection(new THREE.Vector3());
    return [dir.x, dir.y, dir.z];
  }

  /** Anchor of the aim ray on the given plane (or null). */
  _aimAnchorOnPlane(axis, coord) {
    const { camera } = this.ctx;
    const origin = worldToCell(camera.position.toArray());
    // Intersect the plane through the CENTER of the voxel layer, not its
    // lower boundary, so the far corner lands where the crosshair points
    // even at shallow view angles.
    const span = spanFor(this.size);
    const p = rayPlaneIntersection(origin, this._lookDir(), axis, coord + span / 2);
    if (!p) return null;
    return anchorFor(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2]), this.size);
  }

  /** Erase every voxel under the dragged rectangle as one history entry. */
  _commitErase() {
    const { world, history, ghost } = this.ctx;
    const cells = this._rectAnchors();
    this._drag = null;
    ghost.hideCells();
    const voxels = this.voxelsAt(cells, this.size);
    if (voxels.length === 0) return;
    const cmd = multiRemoveCommand(world, voxels);
    const n = cmd.do();
    if (n === 0) return;
    history.push(cmd);
    this.lastAction = `Removed ${n} (square)`;
  }

  onDeactivate() {
    this._drag = null;
    this.hide();
  }

  /** Abort a drag (pointer lock lost, tool switch). */
  cancel() {
    if (this._drag) {
      this._drag = null;
      this.hide();
    }
  }

  hide() {
    const { ghost } = this.ctx;
    ghost.hideCells();
    ghost.hide();
  }
}
