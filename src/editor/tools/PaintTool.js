// PaintTool.js — repaint individual block faces with another block's texture.
//
// The block selected in the palette (state.blockId) is the paint. HOLD LMB
// and sweep the crosshair: every face it crosses takes that texture. HOLD RMB
// to strip faces back to their block's own texture. Each stroke lands as ONE
// history entry, so a mis-swipe undoes in a single step.
//
// Paint is purely visual — the voxel keeps its type, opacity, light and
// collision, and a painted face emits no extra geometry (the mesher just
// samples a different atlas tile), so a fully repainted world renders at
// exactly the same cost as an unpainted one.

import { Tool } from '../Tool.js';
import { paintFacesCommand } from '../commands.js';
import { faceFromNormal } from './DecalTool.js';
import { shapeFor, getBlock } from '../../engine/VoxelTypes.js';
import { spanVecFor } from '../../engine/VoxelShape.js';
import { Notice } from '../Notice.js';

/**
 * Cells of a voxel that sit on one of its faces — a BIG block paints as one
 * whole side, not as the single 0.5 m cell the crosshair happens to hit.
 * @returns {[number,number,number][]}
 */
export function faceCells(voxel, face) {
  const [ax, ay, az] = voxel.anchor;
  const span = spanVecFor(voxel.size, voxel.rotation ?? 0);
  const axis = face[1] === 'x' ? 0 : face[1] === 'y' ? 1 : 2;
  const layer = face[0] === 'p' ? span[axis] - 1 : 0;
  const out = [];
  for (let i = 0; i < span[0]; i++) {
    for (let j = 0; j < span[1]; j++) {
      for (let k = 0; k < span[2]; k++) {
        if ([i, j, k][axis] !== layer) continue;
        out.push([ax + i, ay + j, az + k]);
      }
    }
  }
  return out;
}

export class PaintTool extends Tool {
  constructor(ctx) {
    super({ id: 'paint', name: 'Paint', ctx });
    this.lastAction = '';
    this._stroke = null; // { entries, seen: Set, strip: boolean }
  }

  /** The block whose texture the brush carries (the palette selection). */
  get type() {
    return this.ctx.state.get('blockId');
  }

  /** The block face under the crosshair, or null. */
  _target() {
    const hit = this.pick();
    if (!hit) return null;
    const face = faceFromNormal(hit.normal);
    if (!face) return null;
    const voxel = this.ctx.world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!voxel) return null;
    return { cell: hit.cell, face, voxel };
  }

  onMouseDown(button) {
    if (button === 0) {
      if (!this.type) {
        Notice.warn('Pick a block in the palette — its texture is the paint');
        return;
      }
      this._begin(false);
    } else if (button === 2) {
      this._begin(true);
    }
  }

  onMouseUp(button) {
    if (button === 0 || button === 2) this._commit();
  }

  update(dt) { // eslint-disable-line no-unused-vars
    if (this._stroke) this._step();
    this._updateGhost();
  }

  /** Open a stroke and apply its first face right away (a plain click is a
   *  one-face stroke). */
  _begin(strip) {
    this._commit();
    this._stroke = { entries: [], seen: new Set(), strip };
    this._step();
  }

  /** Apply the brush to the face under the crosshair, once per face. */
  _step() {
    const stroke = this._stroke;
    const t = this._target();
    if (!t) return;
    const tag = `${t.voxel.anchor.join(',')}|${t.face}`;
    if (stroke.seen.has(tag)) return;
    stroke.seen.add(tag);
    if (shapeFor(t.voxel.type) !== 'cube') {
      // Panes and doors mesh their art as a whole slab — there is no
      // per-face tile to swap. Warn once per face, not once per frame.
      if (!stroke.warned) {
        stroke.warned = true;
        Notice.warn('Only full blocks take paint — panes and doors keep their art');
      }
      return;
    }
    const { world } = this.ctx;
    const type = stroke.strip ? null : this.type;
    for (const cell of faceCells(t.voxel, t.face)) {
      const prev = world.paintAt(cell[0], cell[1], cell[2], t.face);
      const changed = type == null
        ? world.unpaintFace(cell[0], cell[1], cell[2], t.face) != null
        : world.paintFace(cell[0], cell[1], cell[2], t.face, type);
      if (changed) stroke.entries.push({ cell, face: t.face, type, prev });
    }
    const n = stroke.entries.length;
    if (n) {
      this.lastAction = stroke.strip
        ? `Stripped ${n} face${n === 1 ? '' : 's'}`
        : `Painted ${n} face${n === 1 ? '' : 's'} ${getBlock(type)?.name ?? type}`;
    }
  }

  /** Close the stroke: however many faces it touched become one undo step. */
  _commit() {
    const stroke = this._stroke;
    this._stroke = null;
    if (!stroke || stroke.entries.length === 0) return;
    // The edits already landed while the button was held, so the command is
    // pushed without re-running do(); redo replays it.
    this.ctx.history.push(paintFacesCommand(this.ctx.world, stroke.entries));
  }

  /** Preview: the brush tile on the aimed face, boxed by the voxel that takes
   *  it (a BIG block paints its whole side). */
  _updateGhost() {
    const { ghost } = this.ctx;
    const t = this._target();
    if (!t || shapeFor(t.voxel.type) !== 'cube' || !this.type) {
      ghost.hide();
      if (t) ghost.showRemoval(t.voxel.anchor, t.voxel.size, t.voxel.rotation ?? 0);
      return;
    }
    // showDecal draws a single tile quad pinned to the face — with a block id
    // it resolves that block's tile for this face, exactly what paint emits.
    ghost.showDecal(t.cell, t.face, this.type, 0, false);
    ghost.showRemoval(t.voxel.anchor, t.voxel.size, t.voxel.rotation ?? 0);
  }

  onActivate() {
    this._stroke = null;
  }

  onDeactivate() {
    this._commit();
    this.hide();
  }

  cancel() {
    this._commit();
  }

  hide() {
    this.ctx.ghost.hide();
  }
}
