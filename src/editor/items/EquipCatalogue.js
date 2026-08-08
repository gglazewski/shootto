// EquipCatalogue.js — the F3 editor's browser of saved equippable items.
//
// A modal listing every equippable item in the equipment registry (preview,
// name, stats, voxel count). Clicking a card loads it into the F3 editor;
// each card also has Edit / Export / Delete, and the catalogue can Import item
// files. Deleting removes the item from the registry everywhere.
//
// Save is handled by the App (register + persist); Export is an explicit,
// separate action that writes the file. The panel chrome (search, count,
// keyboard, delete confirm, kind chips) lives in CatalogueModal.

import { listEquipItems } from '../../engine/EquipmentRegistry.js';
import { ammoName } from '../../engine/AmmoTypes.js';
import { CatalogueModal } from './CatalogueModal.js';

export class EquipCatalogue extends CatalogueModal {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} deps.container  the modal root (#equip-catalogue)
   * @param {object} [deps.callbacks]
   *   { onCard(id), onEdit(id), onExport(id), onDelete(id), onImport(text) }
   */
  constructor({ doc = document, container, callbacks = {} } = {}) {
    super({
      doc,
      container,
      callbacks,
      title: 'Equipment Catalogue',
      emptyText: 'No items yet — press F3 to build an equippable item',
      cardHint: 'click to edit',
    });
  }

  _filters() {
    return [
      { id: 'all', label: 'All', test: () => true },
      { id: 'weapon', label: 'Weapons', test: (i) => i.kind !== 'ammo' },
      { id: 'ammo', label: 'Ammo', test: (i) => i.kind === 'ammo' },
    ];
  }

  _list() {
    return listEquipItems();
  }

  _meta(item) {
    if (item.kind === 'ammo') {
      const a = item.ammo ?? {};
      return `ammo · ${a.type ? ammoName(a.type) : 'no type'} ×${a.amount ?? 0} · ${item.microVoxels.length} voxels`;
    }
    const s = item.stats ?? {};
    // Multi-pellet guns show per-pellet math: "6×8 dmg" (damage is per pellet).
    const pellets = item.weapon?.pellets ?? 1;
    const dmg = pellets > 1 ? `${pellets}×${s.damage ?? 10} dmg` : `${s.damage ?? 10} dmg`;
    const bits = [dmg, `${s.reach ?? 2} m`, `${s.cooldown ?? 0.35} s`, `${item.microVoxels.length} voxels`];
    if (item.grip) bits.push(item.grip2 ? 'grip R+L' : 'grip');
    return bits.join(' · ');
  }
}
