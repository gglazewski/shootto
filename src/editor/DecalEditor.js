// DecalEditor.js — 2D pixel-art editor for drawn decals.
//
// Opened from the inventory's Decals section ("New Decal…"). The author
// picks a size in cells (1x1 up to 4x4 — one 16px tile of art per cell,
// same texel density as blocks), draws with paint/erase/fill/pick tools on
// a checkered canvas (transparent pixels stay see-through on the wall), and
// hits Create. The spec goes to the app (onCreate), which registers the
// decal through PixelDecals, rebuilds the atlas and puts it in hand —
// the same flow the text sign modal uses, with pixels instead of glyphs.

import { MAX_SPAN_CELLS, MAX_NAME_LENGTH, encodePixels } from '../engine/PixelDecals.js';
import { TILE_SIZE } from '../textures/TextureAtlas.js';
import { closeX } from './closeX.js';

const CANVAS_PX = 384; // on-screen size budget for the drawing area
const UNDO_CAP = 50;

// Starter palette: the PRL interior staples (whites, creams, wood, brick
// red, PKP green, navy) plus black — the color input covers the rest.
const PALETTE = [
  '#1a1a1e', '#f2eee4', '#c8b890', '#8a5a34', '#b03028',
  '#3a6e46', '#2e3c64', '#d89028',
];

export class DecalEditor {
  /** @param {{doc?: Document}} [deps] */
  constructor({ doc = document } = {}) {
    this.doc = doc;
    this.onCreate = null;
    this.onClose = null;

    this.tool = 'paint';
    this.color = PALETTE[0];
    this._stroke = false;
    this._undo = [];
    this._zoom = 1;

    const el = doc.createElement('div');
    el.className = 'ie-modal';
    el.id = 'decal-editor';
    const box = doc.createElement('div');
    box.className = 'ie-modal-box';
    el.appendChild(box);

    const h2 = doc.createElement('h2');
    h2.textContent = 'Decal Editor';
    box.appendChild(h2);
    box.appendChild(closeX(doc, () => this.hide()));

    const row = (label, ...controls) => {
      const r = doc.createElement('div');
      r.className = 'sign-row';
      const l = doc.createElement('span');
      l.className = 'label';
      l.textContent = label;
      r.appendChild(l);
      for (const c of controls) r.appendChild(c);
      box.appendChild(r);
      return r;
    };

    this.name = doc.createElement('input');
    this.name.type = 'text';
    this.name.maxLength = MAX_NAME_LENGTH;
    this.name.placeholder = 'My Decal';
    row('Name', this.name);

    const sizeSelect = () => {
      const sel = doc.createElement('select');
      for (let v = 1; v <= MAX_SPAN_CELLS; v++) {
        const o = doc.createElement('option');
        o.value = String(v);
        o.textContent = `${v} cell${v > 1 ? 's' : ''} (${v * 0.5} m)`;
        sel.appendChild(o);
      }
      return sel;
    };
    this.spanW = sizeSelect();
    this.spanH = sizeSelect();
    row('Width', this.spanW);
    row('Height', this.spanH);
    // Resizing keeps the art (cropped or extended at the bottom-right).
    this.spanW.addEventListener('input', () => this._resize());
    this.spanH.addEventListener('input', () => this._resize());

    // --- tools + color ---
    const tools = doc.createElement('div');
    tools.className = 'de-tools';
    this._toolBtns = {};
    for (const [id, label, title] of [
      ['paint', 'Paint', 'Paint pixels (RMB always erases)'],
      ['erase', 'Erase', 'Erase to transparent'],
      ['fill', 'Fill', 'Flood-fill matching pixels'],
      ['pick', 'Pick', 'Pick a color from the art'],
    ]) {
      const b = doc.createElement('button');
      b.className = 'ie-close de-tool';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', () => this._setTool(id));
      this._toolBtns[id] = b;
      tools.appendChild(b);
    }
    const zoomBtn = (label, title, mul) => {
      const b = doc.createElement('button');
      b.className = 'ie-close de-tool de-zoom';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', () => this._setZoom(mul));
      tools.appendChild(b);
    };
    zoomBtn('−', 'Zoom out (wheel down)', 0.5);
    zoomBtn('+', 'Zoom in (wheel up)', 2);
    this.colorInput = doc.createElement('input');
    this.colorInput.type = 'color';
    this.colorInput.value = this.color;
    this.colorInput.title = 'Brush color';
    this.colorInput.addEventListener('input', () => { this.color = this.colorInput.value; });
    tools.appendChild(this.colorInput);
    box.appendChild(tools);

    const palette = doc.createElement('div');
    palette.className = 'de-palette';
    for (const hex of PALETTE) {
      const sw = doc.createElement('button');
      sw.className = 'de-swatch';
      sw.style.background = hex;
      sw.title = hex;
      sw.addEventListener('click', () => {
        this.color = hex;
        this.colorInput.value = hex;
        if (this.tool === 'erase' || this.tool === 'pick') this._setTool('paint');
      });
      palette.appendChild(sw);
    }
    box.appendChild(palette);

    // --- drawing canvas (scrolls inside its wrap when zoomed in) ---
    const wrap = doc.createElement('div');
    wrap.className = 'decal-canvas-wrap';
    this.canvas = doc.createElement('canvas');
    this.canvas.className = 'decal-canvas';
    wrap.appendChild(this.canvas);
    box.appendChild(wrap);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._setZoom(e.deltaY < 0 ? 2 : 0.5);
    }, { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => this._pointer(e, true));
    this.canvas.addEventListener('pointermove', (e) => this._pointer(e, false));
    const endStroke = () => { this._stroke = false; };
    this.canvas.addEventListener('pointerup', endStroke);
    this.canvas.addEventListener('pointerleave', endStroke);

    const buttons = doc.createElement('div');
    buttons.className = 'sign-buttons';
    const btn = (label, fn) => {
      const b = doc.createElement('button');
      b.className = 'ie-close';
      b.textContent = label;
      b.addEventListener('click', fn);
      buttons.appendChild(b);
      return b;
    };
    btn('Undo', () => this._popUndo());
    btn('Clear', () => { this._pushUndo(); this.art.fill(0); this._render(); });
    this.createBtn = btn('Create', () => this._create());
    btn('Cancel', () => this.hide());
    box.appendChild(buttons);

    // The editor's hotkeys listen on the document; drawing must not fly the
    // camera. Escape closes, Ctrl+Z undoes.
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.hide();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this._popUndo(); }
    });
    box.addEventListener('keyup', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      if (e.target === el) this.hide();
    });

    this.el = el;
    doc.body.appendChild(el);

    this.art = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
    this._artW = TILE_SIZE;
    this._artH = TILE_SIZE;
    this._setTool('paint');
  }

  get _dims() {
    return [Number(this.spanW.value) * TILE_SIZE, Number(this.spanH.value) * TILE_SIZE];
  }

  _setTool(id) {
    this.tool = id;
    for (const [k, b] of Object.entries(this._toolBtns)) b.classList.toggle('active', k === id);
  }

  _setZoom(mul) {
    this._zoom = Math.min(8, Math.max(0.25, this._zoom * mul));
    this._render();
  }

  _resize() {
    const [W, H] = this._dims;
    const old = { art: this.art, W: this._artW, H: this._artH };
    this.art = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < Math.min(H, old.H); y++) {
      const n = Math.min(W, old.W) * 4;
      this.art.set(old.art.subarray(y * old.W * 4, y * old.W * 4 + n), y * W * 4);
    }
    this._artW = W;
    this._artH = H;
    this._undo.length = 0; // undo snapshots have the old dimensions
    this._render();
  }

  _pushUndo() {
    this._undo.push(this.art.slice());
    if (this._undo.length > UNDO_CAP) this._undo.shift();
  }

  _popUndo() {
    const prev = this._undo.pop();
    if (!prev || prev.length !== this.art.length) return;
    this.art = prev;
    this._render();
  }

  /** '#rrggbb' -> [r,g,b,255] */
  _rgba() {
    const v = parseInt(this.colorInput.value.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255];
  }

  _pointer(e, isDown) {
    if (isDown) e.preventDefault();
    if (!isDown && !this._stroke) return;
    const [W, H] = this._dims;
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * W);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * H);
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const erase = this.tool === 'erase' || (e.buttons & 2) !== 0;
    if (isDown) {
      if (this.tool === 'pick' && !erase) {
        const i = (y * W + x) * 4;
        if (this.art[i + 3] > 0) {
          const hex = `#${((1 << 24) | (this.art[i] << 16) | (this.art[i + 1] << 8) | this.art[i + 2]).toString(16).slice(1)}`;
          this.color = hex;
          this.colorInput.value = hex;
          this._setTool('paint');
        }
        return;
      }
      this._pushUndo();
      if (this.tool === 'fill' && !erase) {
        this._fill(x, y);
        this._render();
        return;
      }
      this._stroke = true;
    }
    if (!this._stroke) return;
    const i = (y * W + x) * 4;
    const [r, g, b, a] = erase ? [0, 0, 0, 0] : this._rgba();
    this.art[i] = r; this.art[i + 1] = g; this.art[i + 2] = b; this.art[i + 3] = a;
    this._render();
  }

  /** Flood-fill from (x,y): repaint the connected run of identical pixels. */
  _fill(x, y) {
    const [W, H] = this._dims;
    const at = (px, py) => (py * W + px) * 4;
    const s = at(x, y);
    const from = [this.art[s], this.art[s + 1], this.art[s + 2], this.art[s + 3]];
    const [r, g, b, a] = this._rgba();
    if (from[0] === r && from[1] === g && from[2] === b && from[3] === a) return;
    const stack = [[x, y]];
    while (stack.length) {
      const [px, py] = stack.pop();
      if (px < 0 || px >= W || py < 0 || py >= H) continue;
      const i = at(px, py);
      if (this.art[i] !== from[0] || this.art[i + 1] !== from[1] ||
          this.art[i + 2] !== from[2] || this.art[i + 3] !== from[3]) continue;
      this.art[i] = r; this.art[i + 1] = g; this.art[i + 2] = b; this.art[i + 3] = a;
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
  }

  _render() {
    const [W, H] = this._dims;
    const base = Math.max(4, Math.floor(CANVAS_PX / Math.max(W, H)));
    const scale = Math.max(1, Math.min(48, Math.round(base * this._zoom)));
    this.canvas.width = W * scale;
    this.canvas.height = H * scale;
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const tmp = this.doc.createElement('canvas');
    tmp.width = W;
    tmp.height = H;
    tmp.getContext('2d').putImageData(new ImageData(this.art.slice(), W), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, this.canvas.width, this.canvas.height);
    // cell boundaries, so multi-cell art shows where the wall grid falls
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    for (let cx = TILE_SIZE; cx < W; cx += TILE_SIZE) {
      ctx.strokeRect(cx * scale - 0.5, 0, 0, this.canvas.height);
    }
    for (let cy = TILE_SIZE; cy < H; cy += TILE_SIZE) {
      ctx.strokeRect(0, cy * scale - 0.5, this.canvas.width, 0);
    }
  }

  _spec() {
    return {
      name: this.name.value,
      span: [Number(this.spanW.value), Number(this.spanH.value)],
      px: encodePixels(this.art),
    };
  }

  _create() {
    // A fully transparent drawing has nothing to place — keep the editor
    // open rather than silently creating nothing.
    if (!this.art.some((_, i) => (i & 3) === 3 && this.art[i] > 0)) return;
    this.hide();
    if (this.onCreate) this.onCreate(this._spec());
  }

  show() {
    // Opened from the inventory, whose close handler re-locks the pointer —
    // free it again so drawing works.
    this.doc.exitPointerLock?.();
    this.el.classList.add('open');
    this._render();
    this.name.focus();
    this.name.select();
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
