// PrefabBrowser.js — the prefab library modal.
//
// Reuses the catalogue shell (search, import, drop-to-import, card grid,
// two-step delete) over the SERVER prefab library instead of an in-memory
// registry: show() pulls the listing and loads every prefab so the cards can
// draw real thumbnails (the screenshot saved with the prefab) and the paste
// tool has its data cached.
//
// Card click puts the prefab in hand (Prefab tool); New Prefab opens the
// prefab editor on an empty volume.
//
// Opened from INSIDE a prefab session it runs in paste mode: the cards stamp
// into the build volume instead of the world, and New Prefab steps aside —
// one session at a time, and the prefab in progress is the one being built.

import { CatalogueModal } from './items/CatalogueModal.js';
import { CELL_SIZE } from '../engine/Space.js';

export class PrefabBrowser extends CatalogueModal {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} deps.container
   * @param {import('../PrefabLibrary.js').PrefabLibrary} deps.library
   * @param {object} [deps.callbacks]  { onCard(id), onEdit(id), onExport(id),
   *   onDelete(id), onImport(text), onNew() }
   */
  constructor({ doc = document, container, library, callbacks = {} }) {
    super({
      doc,
      container,
      callbacks,
      title: 'Prefab Library',
      emptyText: 'No prefabs yet — press New Prefab to build the first one',
      cardHint: 'click to place in the world',
    });
    this.library = library;
    this._entries = [];
    this._loading = false;
    this._pasteMode = false;

    // The shared shell labels its import button for items; retitle it and
    // add the New Prefab action in front of the search box.
    const bar = container.querySelector('.cat-bar');
    for (const btn of bar.querySelectorAll('button')) {
      if (btn.textContent === 'Import item file') btn.textContent = 'Import prefab file';
    }
    const newBtn = doc.createElement('button');
    newBtn.className = 'cat-btn primary';
    newBtn.textContent = '+ New Prefab';
    newBtn.title = 'Open the prefab editor on an empty build volume';
    newBtn.addEventListener('click', () => this.cb.onNew?.());
    bar.insertBefore(newBtn, bar.firstChild);
    this._newBtn = newBtn;
  }

  /** Paste mode: cards stamp into the open prefab, not into the world. */
  setPasteMode(on) {
    this._pasteMode = !!on;
    this._newBtn.hidden = this._pasteMode;
    this.cardHint = this._pasteMode ? 'click to paste into this prefab' : 'click to place in the world';
    this.emptyText = this._pasteMode
      ? 'No other prefabs in the library yet'
      : 'No prefabs yet — press New Prefab to build the first one';
    if (this.isOpen) this.refresh();
  }

  get pasteMode() {
    return this._pasteMode;
  }

  _list() {
    return this._entries;
  }

  /** Pull the library listing + parsed prefabs, then re-render the grid. */
  async refreshFromServer() {
    if (this._loading) return;
    this._loading = true;
    try {
      const listing = await this.library.list();
      const prefabs = await Promise.all(listing.map((e) => this.library.load(e.id)));
      this._entries = prefabs.filter(Boolean).map((p) => ({
        id: p.id,
        name: p.name,
        dims: p.dims,
        thumb: p.thumb ?? null,
        blockCount: p.blocks.length + p.items.length,
      }));
    } finally {
      this._loading = false;
    }
    if (this.isOpen) this.refresh();
  }

  show() {
    super.show();
    this.refreshFromServer();
  }

  _meta(entry) {
    const m = entry.dims.map((d) => (d * CELL_SIZE).toFixed(1).replace(/\.0$/, '')).join(' × ');
    return `${m} m · ${entry.blockCount} blocks`;
  }

  _card(entry) {
    const card = super._card(entry);
    // Swap the item swatch (first child) for the prefab thumbnail.
    const old = card.querySelector('canvas');
    const thumb = this.doc.createElement('div');
    thumb.className = 'prefab-thumb';
    if (entry.thumb) {
      const img = this.doc.createElement('img');
      img.src = entry.thumb;
      img.alt = entry.name;
      thumb.appendChild(img);
    } else {
      thumb.textContent = '⌂';
    }
    if (old) card.replaceChild(thumb, old);
    else card.insertBefore(thumb, card.firstChild);
    // Editing a second prefab is impossible mid-session — the button would
    // only ever answer "already editing one".
    if (this._pasteMode) card.querySelector('.cat-actions button')?.remove();
    return card;
  }
}
