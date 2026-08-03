// SquareTool.js — drag a rectangle of voxels on a plane.
//
// The drag must start ON a voxel (init spot is the cell adjacent to the
// clicked face). The orientation follows the camera: look mostly up/down and
// the square is horizontal, look mostly forward and it is vertical (aligned
// with the dominant horizontal axis). The far corner is found by intersecting
// the aim ray with the drag plane, so the square can extend into empty space.
// RMB still removes the voxel under the cursor.

import { Tool } from '../Tool.js';
import { multiPlaceCommand, removeCommand } from '../commands.js';
import { spanFor, anchorFor } from '../../engine/VoxelShape.js';
import { worldToCell } from '../../engine/VoxelRaycaster.js';
import { Notice } from '../Notice.js';

/**
 * Plane from the camera look direction, with hysteresis so the square does
 * not flap near the 45° boundary. `curAxis` is the axis of the ongoing drag.
 */
function planeFromLook(d, curAxis) {
  const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
  const horiz = ax >= az ? 0 : 2; // vertical plane aligned to the dominant horizontal axis
  const vertAxes = horiz === 0 ? [1, 2] : [0, 1];

  if (curAxis === 1 && ay > 0.35) return { axis: 1, axes: [0, 2] };
  if (curAxis != null && curAxis !== 1 && ay < 0.8) return { axis: horiz, axes: vertAxes };

  if (ay > 0.5) return { axis: 1, axes: [0, 2] }; // looking up/down -> horizontal square
  return { axis: horiz, axes: vertAxes }; // looking forward -> vertical square
}

/** Ray-plane intersection in cell units, or null when parallel/behind. */
export function rayPlaneIntersection(origin, dir, axis, coord) {
  const denom = dir[axis];
  if (Math.abs(denom) < 0.15 || !Number.isFinite(denom)) return null; // near-parallel
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

  onMouseDown(button) {
    if (button === 2) {
      // RMB cancels an in-progress square drag.
      if (this._drag) {
        this._drag = null;
        this.hide();
        this.lastAction = 'Square cancelled';
        Notice.info('Square cancelled');
        return;
      }
      this._removeUnderCursor();
      return;
    }
    if (button !== 0 || this._drag) return;
    const hit = this.pick();
    if (!hit) return; // init spot must be on a voxel
    const { axis, axes } = planeFromLook(this._lookDir());
    const anchor = this.placementAnchor(hit, this.size);
    this._drag = { axis, axes, start: anchor, end: anchor };
  }

  onMouseUp(button) {
    if (button !== 0 || !this._drag) return;
    const { world, history, ghost } = this.ctx;
    if (!this.type) {
      this._drag = null;
      ghost.hideCells();
      return;
    }
    const cells = this._rectAnchors();
    if (cells.length > 0) {
      const cmd = multiPlaceCommand(world, cells, this.type, this.size);
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
      ghost.showPlacement(anchor, this.size, false);
      if (voxel) ghost.showRemoval(voxel.anchor, voxel.size);
      return;
    }

    // Orientation follows the camera, so moving it flips between
    // horizontal and vertical squares live.
    const { axis, axes } = planeFromLook(this._lookDir(), this._drag.axis);
    this._drag.axis = axis;
    this._drag.axes = axes;
    const end = this._aimAnchorOnPlane(axis, this._drag.start[axis]);
    if (end) this._drag.end = end;
    ghost.showCells(this._rectAnchors(), this.size, false);
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
    const { camera, THREE } = this.ctx;
    const origin = worldToCell(camera.position.toArray());
    const p = rayPlaneIntersection(origin, this._lookDir(), axis, coord);
    if (!p) return null;
    return anchorFor(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2]), this.size);
  }

  _removeUnderCursor() {
    const { world, history } = this.ctx;
    const hit = this.pick();
    if (!hit) return;
    const voxel = world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!voxel) return;
    const cmd = removeCommand(world, voxel);
    if (cmd.do()) {
      history.push(cmd);
      this.lastAction = `Removed ${voxel.type}`;
    }
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
