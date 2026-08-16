// ItemCatalogue.js — the editor's browser of saved placeable objects.
//
// A modal listing every item in the registry (preview, name, size, voxel count,
// light). Clicking a card runs the context action (arm placement in the world
// editor / load into the item editor); each card also has Edit / Export /
// Delete, and the catalogue can Import item files. Deleting removes the item
// from the registry everywhere (inventory, placements in the world).
//
// Save is handled by the editor (the App): it registers + persists the item to
// the catalogue; Export is an explicit, separate action that writes the file.
// The panel chrome (search, count, keyboard, delete confirm) lives in
// CatalogueModal.

import { listItems } from '../../engine/ItemRegistry.js';
import { cellsOf } from '../../engine/ItemTypes.js';
import { CELL_SIZE } from '../../engine/Space.js';
import { CatalogueModal } from './CatalogueModal.js';

export class ItemCatalogue extends CatalogueModal {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} deps.container  the modal root (#item-catalogue)
   * @param {object} [deps.callbacks]
   *   { onCard(id), onEdit(id), onExport(id), onDelete(id), onImport(text) }
   */
  constructor({ doc = document, container, callbacks = {} } = {}) {
    super({
      doc,
      container,
      callbacks,
      title: 'Object Catalogue',
      emptyText: 'No objects yet — press F2 to build a placeable object',
      cardHint: 'click to select',
    });
  }

  /** Cards offer a copy into the F3 equipment catalogue (scenery → pickable). */
  _convertLabel() {
    return 'To Items';
  }

  _list() {
    return listItems();
  }

  _meta(item) {
    const bits = [
      cellsOf(item).map((c) => (c * CELL_SIZE).toFixed(1).replace(/\.0$/, '')).join('×') + ' m',
      item.solid === false ? 'traversable' : 'blocking',
      `${item.microVoxels.length} voxels`,
    ];
    if (item.light) bits.push('light');
    return bits.join(' · ');
  }
}
