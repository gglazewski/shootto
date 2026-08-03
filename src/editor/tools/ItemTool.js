// ItemTool.js — place/remove registered items in the world.
//
// Active when an item is selected (state.itemId set, chosen from the E
// inventory). LMB places the selected item adjacent to the hovered face (the
// whole footprint must be free of voxels and other items), RMB removes the item
// under the cursor. A translucent preview of the item model follows the aim
// with a green/red footprint box.

import { Tool } from '../Tool.js';
import { Notice } from '../Notice.js';
import { itemAwarePick } from '../itemPick.js';
import { getItem } from '../../engine/ItemRegistry.js';
import { getEquipItem } from '../../engine/EquipmentRegistry.js';
import { createItemGeometry } from '../ItemGeometry.three.js';
import { microCellSizeFor } from '../../engine/ItemTypes.js';
import { CELL_SIZE } from '../../engine/Space.js';
import { spanFor } from '../../engine/VoxelShape.js';

/** Resolve a selected item id from either the placeable-object or the
 *  equippable-item registry (the E menu mixes both; equipment has no size and
 *  places at the small footprint). */
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

  get size() {
    return this.item?.size ?? 'small';
  }

  /** Current yaw in radians for the selected item (R cycles 90° steps). */
  get rotation() {
    return ((this.ctx.state.get('itemRotation') ?? 0) * Math.PI) / 180;
  }

  pick() {
    return itemAwarePick(this.ctx.world, this.ctx.THREE, this.ctx.camera);
  }

  onMouseDown(button) {
    if (button === 2) this._remove();
    else if (button === 0) this._place();
  }

  _place() {
    const { world } = this.ctx;
    const hit = this.pick();
    if (!hit) return;
    const anchor = this.placementAnchor(hit, this.size);
    if (!world.isAreaFree(anchor[0], anchor[1], anchor[2], this.size)) {
      Notice.warn('Cannot place item — space is blocked');
      return;
    }
    if (world.placeItem(this.item?.id, this.size, anchor[0], anchor[1], anchor[2], this.rotation)) {
      this.lastAction = `Placed ${this.item?.name ?? this.item?.id}`;
      this.ctx.onItemChange?.();
    }
  }

  _remove() {
    const { world } = this.ctx;
    const hit = this.pick();
    if (!hit) return;
    const item = world.itemAt(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!item) return;
    world.removeItemAt(hit.cell[0], hit.cell[1], hit.cell[2]);
    this.lastAction = `Removed ${resolveItem(item.itemId)?.name ?? item.itemId}`;
    this.ctx.onItemChange?.();
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
    const item = this.ctx.world.itemAt(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (item) {
      // Aiming at a placed item -> show its footprint as a removal outline.
      this._hidePreview();
      ghost.hide();
      ghost.showRemoval(item.anchor, item.size);
      return;
    }
    const anchor = this.placementAnchor(hit, this.size);
    const blocked = !this.ctx.world.isAreaFree(anchor[0], anchor[1], anchor[2], this.size);
    ghost.hide();
    this._showPreview(anchor, blocked);
  }

  _showPreview(anchor, blocked) {
    const it = this.item;
    if (!it) {
      this._hidePreview();
      return;
    }
    const key = `${it.id}:${this.size}:${this.rotation}`;
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
    const s = spanFor(this.size) * CELL_SIZE;
    box.scale.set(s, s, s);
    box.position.set(s / 2, s / 2, s / 2);
    box.material.color.setHex(blocked ? 0xff5533 : 0x33ff66);
    this._preview.mesh.material.opacity = blocked ? 0.3 : 0.6;
  }

  _buildPreview(it) {
    const T = this.ctx.THREE;
    if (this._preview) this.ctx.scene?.remove?.(this._preview.group);
    const group = new T.Group();
    const c = microCellSizeFor(this.size);
    const geo = createItemGeometry(T, it.microVoxels, { rotation: this.rotation });
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
