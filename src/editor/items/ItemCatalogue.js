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

import { listItems } from '../../engine/ItemRegistry.js';
import { buildItemSwatch } from './itemSwatch.js';
import { ITEM_WORLD_SIZE } from '../../engine/ItemTypes.js';

export class ItemCatalogue {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} deps.container  the modal root (#item-catalogue)
   * @param {object} [deps.callbacks]
   *   { onCard(id), onEdit(id), onExport(id), onDelete(id), onImport(text) }
   */
  constructor({ doc = document, container, callbacks = {} }) {
    this.doc = doc;
    this.container = container;
    this.cb = callbacks;
    this.onClose = null;

    const panel = this.container.querySelector('.panel');
    panel.innerHTML = '';

    const title = doc.createElement('h2');
    title.textContent = 'Item Catalogue';
    panel.appendChild(title);

    const bar = doc.createElement('div');
    bar.className = 'cat-bar';
    const importBtn = doc.createElement('button');
    importBtn.className = 'cat-btn';
    importBtn.textContent = 'Import item file';
    importBtn.addEventListener('click', () => this._file.click());
    bar.appendChild(importBtn);
    this._file = doc.createElement('input');
    this._file.type = 'file';
    this._file.accept = '.json,application/json';
    this._file.style.display = 'none';
    this._file.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        this.cb.onImport?.(String(reader.result));
        e.target.value = '';
      };
      reader.readAsText(f);
    });
    bar.appendChild(this._file);
    panel.appendChild(bar);

    this.grid = doc.createElement('div');
    this.grid.className = 'cat-grid';
    panel.appendChild(this.grid);

    this.empty = doc.createElement('div');
    this.empty.className = 'inv-hint';
    this.empty.textContent = 'No items yet — press F2 to build a placeable object';
    panel.appendChild(this.empty);

    const close = doc.createElement('button');
    close.className = 'cat-btn cat-close';
    close.textContent = 'Close';
    close.addEventListener('click', () => this.hide());
    panel.appendChild(close);

    // clicking the dark backdrop closes the catalogue
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container) this.hide();
    });

    this.hide();
  }

  /** Re-render from the current registry (call after save/import/delete). */
  refresh() {
    this._render();
  }

  show() {
    this._render();
    this.container.classList.add('open');
  }

  hide() {
    const wasOpen = this.isOpen;
    this.container.classList.remove('open');
    if (wasOpen && this.onClose) this.onClose();
  }

  toggle() {
    if (this.isOpen) this.hide();
    else this.show();
  }

  get isOpen() {
    return this.container.classList.contains('open');
  }

  _render() {
    this.grid.innerHTML = '';
    const items = listItems();
    this.empty.style.display = items.length ? 'none' : '';
    for (const item of items) this.grid.appendChild(this._card(item));
  }

  _card(item) {
    const doc = this.doc;
    const card = doc.createElement('div');
    card.className = 'cat-item';
    card.title = `${item.name} — click to select`;
    card.appendChild(buildItemSwatch(item, 56));

    const name = doc.createElement('div');
    name.className = 'cat-name';
    name.textContent = item.name;
    card.appendChild(name);

    const meta = doc.createElement('div');
    meta.className = 'cat-meta';
    const bits = [`${ITEM_WORLD_SIZE[item.size].toFixed(1)} m`, item.solid === false ? 'traversable' : 'blocking', `${item.microVoxels.length} voxels`];
    if (item.light) bits.push('light');
    meta.textContent = bits.join(' · ');
    card.appendChild(meta);

    const actions = doc.createElement('div');
    actions.className = 'cat-actions';
    const mk = (label, fn, extra = '') => {
      const b = doc.createElement('button');
      b.className = `cat-btn ${extra}`;
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      actions.appendChild(b);
    };
    mk('Edit', () => this.cb.onEdit?.(item.id));
    mk('Export', () => this.cb.onExport?.(item.id));
    mk('Delete', () => this.cb.onDelete?.(item.id), 'danger');
    card.appendChild(actions);

    card.addEventListener('click', () => this.cb.onCard?.(item.id));
    return card;
  }
}
