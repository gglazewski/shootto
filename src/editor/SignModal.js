// SignModal.js — small dialog for creating text sign decals.
//
// Opened from the inventory's Decals section ("+ New Sign"). The author
// types the text (Polish diacritics welcome), picks band height, width
// (auto or fixed), text and background colors, and watches the live
// preview — rendered by the same renderSignPixels the atlas tile uses, so
// what you see is exactly what lands on the wall. Create hands the spec to
// the app (onCreate), which registers the decal, rebuilds the atlas and
// puts the sign in hand.

import { renderSignPixels, normalizeSpec, MAX_TEXT_LENGTH, MAX_WIDTH_CELLS } from '../engine/TextDecals.js';

export class SignModal {
  /** @param {{doc?: Document}} [deps] */
  constructor({ doc = document } = {}) {
    this.doc = doc;
    this.onCreate = null;
    this.onClose = null;

    const el = doc.createElement('div');
    el.className = 'ie-modal';
    el.id = 'sign-modal';
    const box = doc.createElement('div');
    box.className = 'ie-modal-box';
    el.appendChild(box);

    const h2 = doc.createElement('h2');
    h2.textContent = 'Text Sign';
    box.appendChild(h2);

    const row = (label, control) => {
      const r = doc.createElement('div');
      r.className = 'sign-row';
      const l = doc.createElement('span');
      l.className = 'label';
      l.textContent = label;
      r.appendChild(l);
      r.appendChild(control);
      box.appendChild(r);
      return r;
    };

    this.text = doc.createElement('input');
    this.text.type = 'text';
    this.text.maxLength = MAX_TEXT_LENGTH;
    this.text.placeholder = 'KWIATY';
    row('Text', this.text);

    this.height = doc.createElement('select');
    for (const [v, label] of [[1, '1 cell (0.5 m)'], [2, '2 cells (1 m)']]) {
      const o = doc.createElement('option');
      o.value = String(v);
      o.textContent = label;
      this.height.appendChild(o);
    }
    row('Height', this.height);

    this.width = doc.createElement('select');
    const auto = doc.createElement('option');
    auto.value = '';
    auto.textContent = 'Auto (fit text)';
    this.width.appendChild(auto);
    for (let w = 1; w <= MAX_WIDTH_CELLS; w++) {
      const o = doc.createElement('option');
      o.value = String(w);
      o.textContent = `${w} cell${w > 1 ? 's' : ''} (${w * 0.5} m)`;
      this.width.appendChild(o);
    }
    row('Width', this.width);

    this.fg = doc.createElement('input');
    this.fg.type = 'color';
    this.fg.value = '#181410';
    row('Text color', this.fg);

    this.bg = doc.createElement('input');
    this.bg.type = 'color';
    this.bg.value = '#e8a820';
    row('Background', this.bg);

    this.noBg = doc.createElement('input');
    this.noBg.type = 'checkbox';
    const check = doc.createElement('label');
    check.className = 'ie-check';
    check.appendChild(this.noBg);
    check.appendChild(doc.createTextNode('No background (painted lettering)'));
    box.appendChild(check);

    this.preview = doc.createElement('canvas');
    this.preview.className = 'sign-preview';
    box.appendChild(this.preview);

    const buttons = doc.createElement('div');
    buttons.className = 'sign-buttons';
    this.createBtn = doc.createElement('button');
    this.createBtn.className = 'ie-close';
    this.createBtn.textContent = 'Create';
    this.createBtn.addEventListener('click', () => this._create());
    const cancel = doc.createElement('button');
    cancel.className = 'ie-close';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.hide());
    buttons.appendChild(this.createBtn);
    buttons.appendChild(cancel);
    box.appendChild(buttons);

    // The editor's hotkeys listen on the document; typing a sign must not
    // fly the camera or toggle the inventory. Enter creates, Escape closes.
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && e.target === this.text) this._create();
      if (e.key === 'Escape') this.hide();
    });
    box.addEventListener('keyup', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      if (e.target === el) this.hide();
    });

    for (const input of [this.text, this.height, this.width, this.fg, this.bg, this.noBg]) {
      input.addEventListener('input', () => this._renderPreview());
    }

    this.el = el;
    doc.body.appendChild(el);
  }

  _spec() {
    return {
      text: this.text.value,
      fg: this.fg.value,
      bg: this.noBg.checked ? null : this.bg.value,
      height: Number(this.height.value),
      width: this.width.value ? Number(this.width.value) : null,
    };
  }

  _renderPreview() {
    this.bg.disabled = this.noBg.checked;
    const spec = normalizeSpec(this._spec());
    const ctx = this.preview.getContext('2d');
    if (!spec.text) {
      this.preview.width = 256;
      this.preview.height = 32;
      ctx.clearRect(0, 0, 256, 32);
      return;
    }
    const art = renderSignPixels(spec);
    const scale = Math.max(1, Math.min(4, Math.floor(256 / art.width)));
    this.preview.width = art.width * scale;
    this.preview.height = art.height * scale;
    const tmp = this.doc.createElement('canvas');
    tmp.width = art.width;
    tmp.height = art.height;
    tmp.getContext('2d').putImageData(new ImageData(art.data, art.width, art.height), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, this.preview.width, this.preview.height);
  }

  _create() {
    const spec = this._spec();
    if (!normalizeSpec(spec).text) return;
    this.hide();
    if (this.onCreate) this.onCreate(spec);
  }

  show() {
    // Opened from the inventory, whose close handler re-locks the pointer —
    // free it again so the form is clickable.
    this.doc.exitPointerLock?.();
    this.el.classList.add('open');
    this._renderPreview();
    this.text.focus();
    this.text.select();
  }

  hide() {
    const wasOpen = this.isOpen;
    this.el.classList.remove('open');
    if (wasOpen && this.onClose) this.onClose();
  }

  get isOpen() {
    return this.el.classList.contains('open');
  }
}
