// PrefabPanel.js — the control strip shown while a prefab is being edited.
//
// Lives on the right edge under the top buttons: prefab name, the build
// volume steppers (W×H×D in cells with the metric size next to them — they
// can grow or shrink at any point during the build), Paste prefab (the
// library, opened to stamp a finished build into this one), Save, and Back to
// the world. Leaving with unsaved changes swaps the footer for an inline
// confirm (Save & exit / Discard / Keep editing) — no native dialogs, they
// would freeze the page for automation and feel out of place.
//
// Each stepper is flanked by two side buttons picking WHICH wall moves when
// the number changes — the typed twin of grabbing that wall with the Resize
// tool. Growing from the min side slides the content the other way, so the
// build stays put and the wall is what travels.
//
// The panel swallows its own keystrokes so typing a name never triggers
// editor shortcuts underneath.

import { CELL_SIZE } from '../engine/Space.js';
import { MAX_PREFAB_SPAN } from '../persistence/PrefabSerializer.js';

export class PrefabPanel {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} deps.container  #prefab-panel
   * @param {object} [deps.callbacks] { onName(name), onDims(dims, {axis, side}), onPaste(), onSave(), onExit(force) }
   */
  constructor({ doc = document, container, callbacks = {} }) {
    this.doc = doc;
    this.root = container;
    this.cb = callbacks;
    this._dims = [16, 16, 16];
    /** Which wall each axis grows from: 'min' (−X/−Y/−Z) or 'max'. */
    this._sides = ['max', 'max', 'max'];
    this._dirty = false;

    this.root.innerHTML = `
      <div class="pf-title">Prefab</div>
      <label class="pf-row"><span class="pf-label">Name</span>
        <input id="pf-name" type="text" value="New Prefab" spellcheck="false" /></label>
      <div class="pf-row pf-size"><span class="pf-label" title="Build volume in 0.5 m cells — change it any time; shrinking refuses while content would stick out">Size</span>
        <span class="pf-dims">
          ${[[0, 'x', 'Width', 'X'], [1, 'y', 'Height', 'Y'], [2, 'z', 'Depth', 'Z']].map(([axis, key, name, letter]) => `
            <span class="pf-axis" data-axis="${axis}">
              <button class="pf-side" data-axis="${axis}" data-side="min" title="${name}: grow/shrink from the −${letter} side">◧</button>
              <input id="pf-dim-${key}" type="number" min="1" max="${MAX_PREFAB_SPAN}" step="1" title="${name} (${letter}, cells)" />
              <button class="pf-side" data-axis="${axis}" data-side="max" title="${name}: grow/shrink from the +${letter} side">◨</button>
            </span>`).join('<span class="pf-x">×</span>')}
        </span></div>
      <div class="pf-row"><span class="pf-label">Meters</span><span id="pf-meters" class="pf-meters">—</span></div>
      <div class="pf-row"><span class="pf-label">Content</span><span id="pf-count" class="pf-meters">0 blocks</span></div>
      <div class="pf-actions" id="pf-actions">
        <button id="pf-paste" title="Stamp another prefab into this one (Shift+F6)">Paste prefab…</button>
        <button id="pf-save" class="primary" title="Save to the prefab library (Ctrl+S)">Save</button>
        <button id="pf-exit" title="Back to the world editor (F6)">Back to world</button>
      </div>
      <div class="pf-confirm" id="pf-confirm" hidden>
        <div class="pf-confirm-msg">Unsaved changes</div>
        <button id="pf-confirm-save" class="primary">Save &amp; exit</button>
        <button id="pf-confirm-discard" class="danger">Discard</button>
        <button id="pf-confirm-stay">Keep editing</button>
      </div>
      <div class="pf-hint"><kbd>Esc</kbd> frees the mouse to use this panel · <kbd>F6</kbd> back to world<br />
        <kbd>Tab</kbd> → <b>Resize</b> grabs a side of the box and pulls it<br />
        <kbd>Shift</kbd>+<kbd>F6</kbd> pastes a library prefab into this one</div>
    `;

    const $ = (sel) => this.root.querySelector(sel);
    this.el = {
      name: $('#pf-name'),
      dimX: $('#pf-dim-x'),
      dimY: $('#pf-dim-y'),
      dimZ: $('#pf-dim-z'),
      meters: $('#pf-meters'),
      count: $('#pf-count'),
      paste: $('#pf-paste'),
      save: $('#pf-save'),
      exit: $('#pf-exit'),
      actions: $('#pf-actions'),
      confirm: $('#pf-confirm'),
      sides: [...this.root.querySelectorAll('.pf-side')],
    };

    this.el.name.addEventListener('change', () => this.cb.onName?.(this.el.name.value.trim() || 'New Prefab'));
    for (const [el, axis] of [[this.el.dimX, 0], [this.el.dimY, 1], [this.el.dimZ, 2]]) {
      el.addEventListener('change', () => {
        const dims = [...this._dims];
        dims[axis] = Number(el.value);
        this.cb.onDims?.(dims, { axis, side: this._sides[axis] });
      });
    }
    for (const btn of this.el.sides) {
      btn.addEventListener('click', () => this.setSide(Number(btn.dataset.axis), btn.dataset.side));
    }
    this._paintSides();
    this.el.paste.addEventListener('click', () => this.cb.onPaste?.());
    this.el.save.addEventListener('click', () => this.cb.onSave?.());
    this.el.exit.addEventListener('click', () => this.cb.onExit?.(false));
    $('#pf-confirm-save').addEventListener('click', async () => {
      this.closeConfirm();
      if (await this.cb.onSave?.()) this.cb.onExit?.(true);
    });
    $('#pf-confirm-discard').addEventListener('click', () => {
      this.closeConfirm();
      this.cb.onExit?.(true);
    });
    $('#pf-confirm-stay').addEventListener('click', () => this.closeConfirm());

    // The panel owns its keystrokes (name typing must not fire tool keys).
    for (const type of ['keydown', 'keyup']) {
      this.root.addEventListener(type, (e) => {
        if (e.key === 'Escape' || /^F\d+$/.test(e.key)) return; // mode keys pass
        e.stopPropagation();
      });
    }
  }

  show({ name, dims, dirty = false }) {
    this.el.name.value = name;
    this.setDims(dims);
    this.setDirty(dirty);
    this.closeConfirm();
    this.root.classList.add('open');
  }

  hide() {
    this.closeConfirm();
    this.root.classList.remove('open');
  }

  get isOpen() {
    return this.root.classList.contains('open');
  }

  get name() {
    return this.el.name.value.trim() || 'New Prefab';
  }

  setDims(dims) {
    this._dims = [...dims];
    const active = this.doc.activeElement;
    if (active !== this.el.dimX) this.el.dimX.value = String(dims[0]);
    if (active !== this.el.dimY) this.el.dimY.value = String(dims[1]);
    if (active !== this.el.dimZ) this.el.dimZ.value = String(dims[2]);
    this.el.meters.textContent = dims.map((d) => (d * CELL_SIZE).toFixed(1).replace(/\.0$/, '')).join(' × ') + ' m';
  }

  /** Pick the wall an axis grows from: 'min' or 'max'. */
  setSide(axis, side) {
    if (side !== 'min' && side !== 'max') return;
    this._sides[axis] = side;
    this._paintSides();
  }

  /** @returns {'min'|'max'} */
  sideFor(axis) {
    return this._sides[axis];
  }

  _paintSides() {
    for (const btn of this.el.sides) {
      btn.classList.toggle('active', this._sides[Number(btn.dataset.axis)] === btn.dataset.side);
    }
  }

  setCount(blocks, items) {
    this.el.count.textContent = items ? `${blocks} blocks · ${items} objects` : `${blocks} blocks`;
  }

  setDirty(dirty) {
    this._dirty = dirty;
    this.el.save.textContent = dirty ? 'Save •' : 'Save';
    this.el.save.classList.toggle('attention', dirty);
  }

  get dirty() {
    return this._dirty;
  }

  /** Ask about unsaved changes before leaving. */
  askExit() {
    this.el.confirm.hidden = false;
    this.el.actions.hidden = true;
  }

  closeConfirm() {
    this.el.confirm.hidden = true;
    this.el.actions.hidden = false;
  }
}
