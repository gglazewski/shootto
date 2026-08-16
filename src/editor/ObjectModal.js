// ObjectModal.js — per-placement settings for a placed object (F2 catalogue),
// opened by clicking the object in the editor.
//
// Two settings ride on the placement record (see World.placeItem):
//   - loot: search-loot config, or absent = plain scenery.
//     { pool: null|['id',...], reset: seconds|null }
//     pool null = default pool (materials + any melee weapon), [] = custom
//     pool with nothing picked (searchable but always empty); reset null =
//     one search per playthrough, a number restocks the roll after that many
//     seconds — the same shape the mob spawners use for their timers.
//   - storage: true = storage container. In game E opens a persistent stash
//     the player moves items into and out of (contents live in save slots).
//     Mutually exclusive with search loot — enabling one clears the other.
//
// DOM-only (reuses the door/mob modal styles); the caller stores the changes
// on the placement record.

import { listEquipItems } from '../engine/EquipmentRegistry.js';
import { buildItemSwatch } from './items/itemSwatch.js';
import { closeX } from './closeX.js';

export class ObjectModal {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} deps.container  the modal root (#object-settings)
   */
  constructor({ doc = document, container }) {
    this.doc = doc;
    this.container = container;
    this.onClose = null;
    this._onApply = null;

    this.panel = container.querySelector('.panel');
    container.addEventListener('click', (e) => {
      if (e.target === container) this.hide();
    });
    this._onKey = (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      }
      e.stopPropagation(); // keep editor shortcuts out while open
    };
  }

  /**
   * Show one placed object's settings.
   * @param {{name: string, loot: {pool: string[]|null, reset: number|null}|null, storage?: boolean}} state
   * @param {(change: {loot?: {pool: string[]|null, reset: number|null}|null, storage?: boolean}) => void} onApply
   */
  open(state, onApply) {
    this._state = { ...state };
    this._onApply = onApply;
    this._render();
    this.container.classList.add('open');
    this.doc.addEventListener('keydown', this._onKey, true);
  }

  _apply(change) {
    Object.assign(this._state, change);
    this._onApply?.(change);
    this._render();
  }

  _render() {
    const doc = this.doc;
    const s = this._state;
    this.panel.innerHTML = '';

    const head = doc.createElement('h2');
    head.textContent = `Object — ${s.name}`;
    this.panel.appendChild(head);
    this.panel.appendChild(closeX(doc, () => this.hide()));

    // --- storage container ---
    const storeHead = doc.createElement('h3');
    storeHead.textContent = 'Storage';
    this.panel.appendChild(storeHead);

    const storeRow = doc.createElement('label');
    storeRow.className = 'door-flag';
    const storeBox = doc.createElement('input');
    storeBox.type = 'checkbox';
    storeBox.checked = !!s.storage;
    storeBox.addEventListener('change', () => {
      // storage and search loot are mutually exclusive on one object
      this._apply(storeBox.checked ? { storage: true, loot: null } : { storage: false });
    });
    storeRow.appendChild(storeBox);
    storeRow.append('Storage container (E opens a stash in game)');
    this.panel.appendChild(storeRow);

    const storeHint = doc.createElement('p');
    storeHint.className = 'door-hint';
    storeHint.textContent = s.storage
      ? 'Players stash and retrieve items here — contents persist in save games. Storage replaces search loot.'
      : 'A stash the player can hoard items in, e.g. furniture in a base.';
    this.panel.appendChild(storeHint);

    if (s.storage) {
      const close = doc.createElement('button');
      close.className = 'cat-btn cat-close';
      close.textContent = 'Done';
      close.addEventListener('click', () => this.hide());
      this.panel.appendChild(close);
      return;
    }

    // --- search loot pool ---
    const lootHead = doc.createElement('h3');
    lootHead.textContent = 'Search loot';
    this.panel.appendChild(lootHead);

    const modeRow = doc.createElement('label');
    modeRow.className = 'door-flag';
    modeRow.append('Searching finds');
    const modeSel = doc.createElement('select');
    for (const [value, label] of [
      ['none', 'Nothing (plain scenery)'],
      ['default', 'Default pool (materials + any melee weapon)'],
      ['custom', 'Custom pool…'],
    ]) {
      const opt = doc.createElement('option');
      opt.value = value;
      opt.textContent = label;
      modeSel.appendChild(opt);
    }
    modeSel.value = !s.loot ? 'none' : s.loot.pool == null ? 'default' : 'custom';
    modeSel.addEventListener('change', () => {
      if (modeSel.value === 'none') this._apply({ loot: null });
      else if (modeSel.value === 'default') this._apply({ loot: { pool: null, reset: s.loot?.reset ?? null } });
      else this._apply({ loot: { pool: s.loot?.pool ?? [], reset: s.loot?.reset ?? null } });
    });
    modeRow.appendChild(modeSel);
    this.panel.appendChild(modeRow);

    if (s.loot && s.loot.pool != null) {
      const all = listEquipItems();
      const isMelee = (i) => i.kind === 'weapon' && (i.weapon?.kind ?? 'melee') === 'melee';
      const groups = [
        { title: 'Weapons (rare find)', items: all.filter(isMelee) },
        { title: 'Materials (common find)', items: all.filter((i) => i.kind === 'material') },
      ];
      if (!groups.some((g) => g.items.length)) {
        const empty = doc.createElement('p');
        empty.className = 'door-hint';
        empty.textContent = 'No melee weapons or materials in the catalogue yet (F3 to build one).';
        this.panel.appendChild(empty);
      }
      for (const group of groups) {
        if (!group.items.length) continue;
        const groupHead = doc.createElement('h3');
        groupHead.textContent = group.title;
        this.panel.appendChild(groupHead);
        const grid = doc.createElement('div');
        grid.className = 'mob-loot-grid';
        for (const item of group.items) {
          const row = doc.createElement('label');
          row.className = 'mob-loot-item';
          const box = doc.createElement('input');
          box.type = 'checkbox';
          box.checked = !!s.loot.pool.includes(item.id);
          box.addEventListener('change', () => {
            const pool = new Set(s.loot.pool);
            if (box.checked) pool.add(item.id);
            else pool.delete(item.id);
            this._apply({ loot: { pool: [...pool], reset: s.loot.reset } });
          });
          row.appendChild(box);
          row.appendChild(buildItemSwatch(item, 28));
          row.appendChild(doc.createTextNode(item.name));
          grid.appendChild(row);
        }
        this.panel.appendChild(grid);
      }
    }

    // --- restock timer (only meaningful on a searchable object) ---
    if (s.loot) {
      const timerHead = doc.createElement('h3');
      timerHead.textContent = 'Loot restock timer (seconds)';
      this.panel.appendChild(timerHead);

      const timerRow = doc.createElement('label');
      timerRow.className = 'door-flag';
      timerRow.append('Restocks after');
      const resetIn = doc.createElement('input');
      resetIn.type = 'number';
      resetIn.min = '1';
      resetIn.placeholder = 'never';
      resetIn.value = s.loot.reset != null ? String(s.loot.reset) : '';
      resetIn.addEventListener('change', () => {
        const n = Number(resetIn.value);
        const reset = resetIn.value !== '' && Number.isFinite(n) && n > 0 ? n : null;
        this._apply({ loot: { pool: s.loot.pool, reset } });
      });
      timerRow.appendChild(resetIn);
      this.panel.appendChild(timerRow);

      const timerHint = doc.createElement('p');
      timerHint.className = 'door-hint';
      timerHint.textContent = s.loot.reset != null
        ? `A searched object rolls fresh loot ${s.loot.reset} s later. Clear the field for one search per playthrough.`
        : 'One search per playthrough — the object never restocks.';
      this.panel.appendChild(timerHint);
    }

    const lootHint = doc.createElement('p');
    lootHint.className = 'door-hint';
    lootHint.textContent =
      'A searchable object highlights in game with “Press E to search”: one roll — a rare weapon or a common material — flies to the player.';
    this.panel.appendChild(lootHint);

    const close = doc.createElement('button');
    close.className = 'cat-btn cat-close';
    close.textContent = 'Done';
    close.addEventListener('click', () => this.hide());
    this.panel.appendChild(close);
  }

  hide() {
    const wasOpen = this.isOpen;
    this.container.classList.remove('open');
    this.doc.removeEventListener('keydown', this._onKey, true);
    this._onApply = null;
    if (wasOpen && this.onClose) this.onClose();
  }

  get isOpen() {
    return this.container.classList.contains('open');
  }
}
