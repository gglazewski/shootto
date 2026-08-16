// ItemTool.js — place/remove registered items in the world.
//
// Active when an item is selected (state.itemId set, chosen from the E
// inventory). LMB places the selected item adjacent to the hovered face (the
// whole footprint must be free of voxels and other items), RMB removes the item
// under the cursor. A translucent preview of the item model follows the aim
// with a green/red footprint box.

import { Tool } from '../Tool.js';
import { Notice } from '../Notice.js';
import { placeItemCommand, removeItemCommand } from '../commands.js';
import { itemAwarePick } from '../itemPick.js';
import { getItem } from '../../engine/ItemRegistry.js';
import { getEquipItem } from '../../engine/EquipmentRegistry.js';
import { createItemGeometry } from '../ItemGeometry.three.js';
import { MICRO_SIZE, cellsOf, gridOf, quarterTurns } from '../../engine/ItemTypes.js';
import { layFlat, layFlatCells } from '../../engine/LayFlat.js';
import { CELL_SIZE } from '../../engine/Space.js';
import { spanVecFor } from '../../engine/VoxelShape.js';

/** Resolve a selected item id from either the placeable-object or the
 *  equippable-item registry (the E menu mixes both; equipment has no cells
 *  and places at a single-cell footprint). */
const resolveItem = (id) => getItem(id) ?? getEquipItem(id);

export class ItemTool extends Tool {
  constructor(ctx) {
    super({ id: 'item', name: 'Place Item', ctx });
    this.lastAction = '';
    this._preview = null;
    this._previewKey = '';
    this._previewItem = null;
  }

  get item() {
    return resolveItem(this.ctx.state.get('itemId'));
  }

  /** Selected equipment def, or null when a placeable object is selected. */
  get _equip() {
    const id = this.ctx.state.get('itemId');
    return getItem(id) ? null : getEquipItem(id);
  }

  /** Footprint of the selected item in cells [w, h, d]. Equipment places in
   *  its resting pose — cropped to its voxels and laid flat (LayFlat.js). */
  get cells() {
    const equip = this._equip;
    return equip ? layFlatCells(equip) : cellsOf(this.item);
  }

  /** Current yaw in radians for the selected item (R cycles 90° steps). */
  get rotation() {
    return ((this.ctx.state.get('itemRotation') ?? 0) * Math.PI) / 180;
  }

  pick() {
    return itemAwarePick(this.ctx.world, this.ctx.THREE, this.ctx.camera);
  }

  /** Items are free objects, not grid blocks: anchor at small-cell resolution
   *  (no parity snap). The footprint extends the per-axis span in +x/+y/+z
   *  from the anchor, so against a negative-facing surface the anchor shifts
   *  back to keep the whole footprint adjacent to the clicked face. */
  placementAnchor(hit) {
    const span = spanVecFor(this.cells, quarterTurns(this.rotation));
    return hit.cell.map((c, i) => {
      const n = hit.normal[i];
      return c + (n > 0 ? 1 : n < 0 ? -span[i] : 0);
    });
  }

  onMouseDown(button) {
    if (button === 2) this._remove();
    else if (button === 0) this._place();
  }

  _place() {
    const { world } = this.ctx;
    const hit = this.pick();
    if (!hit) return;
    const anchor = this.placementAnchor(hit);
    if (!world.isAreaFree(anchor[0], anchor[1], anchor[2], this.cells, quarterTurns(this.rotation))) {
      Notice.warn('Cannot place item — space is blocked');
      return;
    }
    const cmd = placeItemCommand(
      world,
      { itemId: this.item?.id, cells: this.cells, anchor, rotation: this.rotation },
      () => this.ctx.onItemChange?.(),
    );
    if (cmd.do()) {
      this.ctx.history.push(cmd);
      this.lastAction = `Placed ${this.item?.name ?? this.item?.id}`;
    }
  }

  _remove() {
    const { world } = this.ctx;
    const hit = this.pick();
    if (!hit) return;
    const item = world.itemAt(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!item) return;
    const cmd = removeItemCommand(world, item, () => this.ctx.onItemChange?.());
    if (cmd.do()) {
      this.ctx.history.push(cmd);
      this.lastAction = `Removed ${resolveItem(item.itemId)?.name ?? item.itemId}`;
    }
  }

  update(dt) {
    this._updateGhost();
  }

  _updateGhost() {
    const { ghost } = this.ctx;
    const hit = this.pick();
    this._lastHit = hit;
    if (!hit) {
      this._hidePreview();
      ghost.hide();
      return;
    }
    const anchor = this.placementAnchor(hit);
    const blocked = !this.ctx.world.isAreaFree(anchor[0], anchor[1], anchor[2], this.cells, quarterTurns(this.rotation));
    ghost.hide();
    // Aiming at a placed item: keep its footprint outlined (RMB removes it)
    // but still preview the placement against the hovered face — items stack
    // on items (a cup on a table) just like on blocks.
    const item = this.ctx.world.itemAt(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (item) ghost.showRemoval(item.anchor, item.cells, quarterTurns(item.rotation ?? 0));
    this._showPreview(anchor, blocked);
  }

  _showPreview(anchor, blocked) {
    const it = this.item;
    if (!it) {
      this._hidePreview();
      return;
    }
    const key = `${it.id}:${this.cells.join('x')}:${this.rotation}`;
    // Rebuild when the item (id, size) or the registered definition changes
    // (a re-saved item is a new object), so the preview always matches.
    if (!this._preview || this._previewKey !== key || this._previewItem !== it) {
      this._buildPreview(it);
      this._previewKey = key;
      this._previewItem = it;
    }
    const { group, box } = this._preview;
    group.visible = true;
    group.position.set(anchor[0] * CELL_SIZE, anchor[1] * CELL_SIZE, anchor[2] * CELL_SIZE);
    const [sx, sy, sz] = spanVecFor(this.cells, quarterTurns(this.rotation)).map((n) => n * CELL_SIZE);
    box.scale.set(sx, sy, sz);
    box.position.set(sx / 2, sy / 2, sz / 2);
    box.material.color.setHex(blocked ? 0xff5533 : 0x33ff66);
    this._preview.mesh.material.opacity = blocked ? 0.3 : 0.6;
  }

  _buildPreview(it) {
    const T = this.ctx.THREE;
    if (this._preview) this.ctx.scene?.remove?.(this._preview.group);
    const group = new T.Group();
    const c = MICRO_SIZE;
    // Equipment previews in its resting pose, matching how it will render.
    const model = this._equip ? layFlat(this._equip) : { microVoxels: it.microVoxels, grid: gridOf(it) };
    const geo = createItemGeometry(T, model.microVoxels, { rotation: this.rotation, grid: model.grid });
    const mesh = new T.Mesh(
      geo,
      new T.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    mesh.scale.setScalar(c);
    group.add(mesh);
    const box = new T.LineSegments(
      new T.EdgesGeometry(new T.BoxGeometry(1, 1, 1)),
      new T.LineBasicMaterial({ color: 0x33ff66 }),
    );
    group.add(box);
    const scene = this.ctx.scene;
    if (scene) scene.add(group);
    this._preview = { group, mesh, box, geo };
  }

  _hidePreview() {
    if (this._preview) this._preview.group.visible = false;
    this.ctx.ghost.hide();
  }

  onActivate() {
    this._hidePreview();
  }

  onDeactivate() {
    this.hide();
  }

  cancel() {
    this.hide();
  }

  hide() {
    this._hidePreview();
  }
}
