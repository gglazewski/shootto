// CatalogueModal.js — shared UI shell for the editor's catalogue modals.
//
// Renders the panel chrome both catalogues share: a title with a live count,
// a search box (autofocused, filters as you type, Enter opens the first
// match), optional kind-filter chips, an Import button, the scrollable card
// grid and the empty state. Cards are keyboard-focusable (Enter/Space
// activates) and Delete is a two-step confirm so a stray click can't wipe an
// item from the registry everywhere.
//
// Subclasses supply the item list (_list), the per-card meta line (_meta) and
// optionally the filter chips (_filters). Escape peels back one layer:
// search text → the modal.

import { buildItemSwatch } from './itemSwatch.js';

export class CatalogueModal {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} deps.container  the modal root
   * @param {object} [deps.callbacks]
   *   { onCard(id), onEdit(id), onExport(id), onDelete(id), onImport(text) }
   * @param {string} deps.title      panel heading
   * @param {string} deps.emptyText  hint shown when the registry is empty
   * @param {string} deps.cardHint   tooltip suffix, e.g. 'click to select'
   */
  constructor({ doc = document, container, callbacks = {}, title, emptyText, cardHint }) {
    this.doc = doc;
    this.container = container;
    this.cb = callbacks;
    this.onClose = null;
    this.emptyText = emptyText;
    this.cardHint = cardHint;
    this._query = '';
    this._filter = 'all';

    const panel = this.container.querySelector('.panel');
    panel.innerHTML = '';

    const head = doc.createElement('h2');
    head.textContent = title;
    this.count = doc.createElement('span');
    this.count.className = 'cat-count';
    head.appendChild(this.count);
    panel.appendChild(head);

    const bar = doc.createElement('div');
    bar.className = 'cat-bar';

    this.search = doc.createElement('input');
    this.search.type = 'search';
    this.search.className = 'cat-search';
    this.search.placeholder = 'Search…';
    this.search.addEventListener('input', () => {
      this._query = this.search.value.trim().toLowerCase();
      this._render();
    });
    bar.appendChild(this.search);

    this._chips = [];
    for (const f of this._filters()) {
      const chip = doc.createElement('button');
      chip.className = 'cat-btn cat-chip';
      chip.textContent = f.label;
      chip.dataset.id = f.id;
      chip.addEventListener('click', () => {
        this._filter = f.id;
        this._render();
      });
      this._chips.push(chip);
      bar.appendChild(chip);
    }

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

    // Capture-phase so the modal owns the keyboard while open — the editor
    // underneath must not react to shortcuts (letters are tools, Esc exits).
    // stopPropagation in the capture phase also prevents target listeners, so
    // Enter/Space activation is handled here rather than on the elements
    // (button default actions still fire — stopPropagation doesn't stop them).
    // F-keys pass through so mode toggles keep working.
    this._onKey = (e) => {
      if (!this.isOpen || /^F\d+$/.test(e.key)) return;
      const active = this.doc.activeElement;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (this.search.value) {
          this.search.value = '';
          this._query = '';
          this._render();
          this.search.focus();
        } else {
          this.hide();
        }
      } else if (e.key === 'Enter' && active === this.search) {
        this.grid.querySelector('.cat-item')?.click(); // open the first match
      } else if ((e.key === 'Enter' || e.key === ' ') && active?.classList?.contains('cat-item')) {
        e.preventDefault();
        active.click();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
          && active !== this.search) {
        this.search.focus(); // type anywhere to search
      }
      e.stopPropagation();
    };

    this.hide();
  }

  /** Kind-filter chips: [{ id, label, test(item) }]. Default: none. */
  _filters() {
    return [];
  }

  /** Re-render from the current registry (call after save/import/delete). */
  refresh() {
    this._render();
  }

  show() {
    this.search.value = '';
    this._query = '';
    this._filter = 'all';
    this._render();
    this.container.classList.add('open');
    this.doc.addEventListener('keydown', this._onKey, true);
    this.search.focus();
  }

  hide() {
    const wasOpen = this.isOpen;
    this.container.classList.remove('open');
    this.doc.removeEventListener('keydown', this._onKey, true);
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
    const all = this._list();
    const filter = this._filters().find((f) => f.id === this._filter);
    let items = filter ? all.filter(filter.test) : all.slice();
    if (this._query) items = items.filter((i) => i.name.toLowerCase().includes(this._query));
    items.sort((a, b) => a.name.localeCompare(b.name));

    this.count.textContent = items.length === all.length
      ? `${all.length}`
      : `${items.length} / ${all.length}`;
    for (const chip of this._chips) chip.classList.toggle('active', chip.dataset.id === this._filter);

    if (!all.length) this.empty.textContent = this.emptyText;
    else if (!items.length) this.empty.textContent = 'No items match';
    this.empty.style.display = items.length ? 'none' : '';

    for (const item of items) this.grid.appendChild(this._card(item));
  }

  _card(item) {
    const doc = this.doc;
    const card = doc.createElement('div');
    card.className = 'cat-item';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.title = `${item.name} — ${this.cardHint}`;
    card.appendChild(buildItemSwatch(item, 56));

    const name = doc.createElement('div');
    name.className = 'cat-name';
    name.textContent = item.name;
    card.appendChild(name);

    const meta = doc.createElement('div');
    meta.className = 'cat-meta';
    meta.textContent = this._meta(item);
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
      return b;
    };
    mk('Edit', () => this.cb.onEdit?.(item.id));
    mk('Export', () => this.cb.onExport?.(item.id));

    let armed = null;
    const del = mk('Delete', () => {
      if (armed) {
        clearTimeout(armed);
        armed = null;
        this.cb.onDelete?.(item.id);
        return;
      }
      del.textContent = 'Sure?';
      del.classList.add('armed');
      armed = setTimeout(() => {
        armed = null;
        del.textContent = 'Delete';
        del.classList.remove('armed');
      }, 2500);
    }, 'danger');
    card.appendChild(actions);

    card.addEventListener('click', () => this.cb.onCard?.(item.id));
    return card;
  }
}
