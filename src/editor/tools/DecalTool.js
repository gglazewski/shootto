// DecalTool.js — pin decals (blood, cracks, bullet holes) onto block faces.
//
// Active when a decal is selected (state.decalId set, chosen from the E
// inventory). LMB pins the decal onto the face under the crosshair, RMB
// peels the decal off the aimed face. R spins the pending decal in quarter
// turns (state.decalRotation). A textured ghost previews the decal on the
// exact face it will land on. Every edit goes through History.

import { Tool } from '../Tool.js';
import { placeDecalCommand, removeDecalCommand } from '../commands.js';
import { shapeFor, getDecal } from '../../engine/VoxelTypes.js';
import { Notice } from '../Notice.js';

/** Face name for a raycast entry normal. */
export function faceFromNormal(normal) {
  if (normal[0]) return normal[0] > 0 ? 'px' : 'nx';
  if (normal[1]) return normal[1] > 0 ? 'py' : 'ny';
  if (normal[2]) return normal[2] > 0 ? 'pz' : 'nz';
  return null;
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
    if (shapeFor(t.voxel.type) === 'pane') {
      Notice.warn('Decals need a full block face');
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
    const blocked = shapeFor(t.voxel.type) === 'pane'
      || !this.ctx.world.canPlaceDecal(this.decalId, t.cell[0], t.cell[1], t.cell[2], t.face, this.rotation);
    ghost.showDecal(t.cell, t.face, this.decalId, this.rotation, blocked);
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
