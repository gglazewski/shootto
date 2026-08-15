// DecalTool.js — pin decals (blood, cracks, bullet holes) onto block faces.
//
// Active when a decal is selected (state.decalId set, chosen from the E
// inventory). LMB pins the decal onto the face under the crosshair, RMB
// peels the decal off the aimed face. R spins the pending decal in quarter
// turns (state.decalRotation). A textured ghost previews the decal on the
// exact face it will land on. Every edit goes through History.

import { Tool } from '../Tool.js';
import { placeDecalCommand, removeDecalCommand } from '../commands.js';
import { shapeFor, getDecal, acceptsDecal } from '../../engine/VoxelTypes.js';
import { isSwitchDecal } from '../../engine/Switches.js';
import { Notice } from '../Notice.js';

/** Face name for a raycast entry normal. */
export function faceFromNormal(normal) {
  if (normal[0]) return normal[0] > 0 ? 'px' : 'nx';
  if (normal[1]) return normal[1] > 0 ? 'py' : 'ny';
  if (normal[2]) return normal[2] > 0 ? 'pz' : 'nz';
  return null;
}

/**
 * Ghost offset in cells that walks the preview from the cell's face plane
 * onto a pane's own plane: a pane sits centered in its voxel, so a curtain
 * must preview on the glass, not on the cell boundary in front of it.
 * Returns null for every other shape (the face plane is already right).
 */
export function paneGhostOffset(voxel, cell, face) {
  if (shapeFor(voxel.type) !== 'pane') return null;
  const axis = face[1] === 'x' ? 0 : face[1] === 'y' ? 1 : 2;
  const span = voxel.size === 'big' ? 2 : 1;
  const anchor = voxel.anchor ?? cell;
  const offset = [0, 0, 0];
  offset[axis] = anchor[axis] + span / 2 - (cell[axis] + (face[0] === 'p' ? 1 : 0));
  return offset;
}

export class DecalTool extends Tool {
  constructor(ctx) {
    super({ id: 'decal', name: 'Decal', ctx });
    this.lastAction = '';
  }

  get decalId() {
    return this.ctx.state.get('decalId');
  }

  /** Quarter turns spinning the decal on its face (R cycles it). */
  get rotation() {
    return this.ctx.state.get('decalRotation') ?? 0;
  }

  /** The face under the crosshair, or null: { cell, face, decal|null }. */
  _target() {
    const hit = this.pick();
    if (!hit) return null;
    const face = faceFromNormal(hit.normal);
    if (!face) return null;
    const [x, y, z] = hit.cell;
    const voxel = this.ctx.world.get(x, y, z);
    if (!voxel) return null;
    return { cell: hit.cell, face, voxel, decal: this.ctx.world.decalAt(x, y, z, face) };
  }

  onMouseDown(button) {
    if (button === 2) {
      this._remove();
      return;
    }
    if (button !== 0) return;
    this._place();
  }

  _place() {
    if (!this.decalId) return;
    const t = this._target();
    if (!t) return;
    if (!acceptsDecal(t.voxel.type, t.voxel.rotation ?? 0, t.face)) {
      Notice.warn(
        shapeFor(t.voxel.type) === 'pane'
          ? 'Aim at the flat side of the pane'
          : 'Decals need a full block face',
      );
      return;
    }
    if (t.decal) {
      Notice.warn('That face already has a decal — RMB removes it');
      return;
    }
    if (!this.ctx.world.canPlaceDecal(this.decalId, t.cell[0], t.cell[1], t.cell[2], t.face, this.rotation)) {
      Notice.warn('No room — the decal needs backing blocks under its whole footprint');
      return;
    }
    const cmd = placeDecalCommand(this.ctx.world, {
      decalId: this.decalId, cell: t.cell, face: t.face, rotation: this.rotation,
    });
    if (cmd.do()) {
      this.ctx.history.push(cmd);
      this.lastAction = `Placed ${getDecal(this.decalId)?.name ?? this.decalId}`;
      // A fresh wall switch opens its wiring immediately — unwired it would
      // click without driving anything.
      const placed = this.ctx.world.decalAt(t.cell[0], t.cell[1], t.cell[2], t.face);
      if (isSwitchDecal(placed)) this.ctx.onSwitchPlaced?.(placed);
    }
  }

  _remove() {
    const t = this._target();
    if (!t?.decal) return;
    const cmd = removeDecalCommand(this.ctx.world, t.decal);
    if (cmd.do()) {
      this.ctx.history.push(cmd);
      this.lastAction = `Removed ${getDecal(t.decal.decalId)?.name ?? t.decal.decalId}`;
    }
  }

  update(dt) {
    const { ghost } = this.ctx;
    const t = this.decalId ? this._target() : null;
    if (!t) {
      ghost.hide();
      return;
    }
    const blocked = !this.ctx.world.canPlaceDecal(this.decalId, t.cell[0], t.cell[1], t.cell[2], t.face, this.rotation);
    ghost.showDecal(t.cell, t.face, this.decalId, this.rotation, blocked, paneGhostOffset(t.voxel, t.cell, t.face));
  }

  onDeactivate() {
    this.hide();
  }

  cancel() {
    this.hide();
  }

  hide() {
    this.ctx.ghost.hide();
  }
}
