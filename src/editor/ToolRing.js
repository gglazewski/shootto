// ToolRing.js — radial tool selector shown while Tab is held.
//
// A ring of tool buttons around the crosshair. While open, raw mouse deltas
// accumulate into a virtual cursor; the slice the cursor points at is the
// highlighted tool. Releasing Tab selects it (via onSelect(index)). A quick
// tap with almost no movement reports `wasMoved === false`, so the caller can
// keep the old "tap Tab cycles" behaviour.

export class ToolRing {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} [deps.container]
   */
  constructor({ doc = document, container } = {}) {
    this.doc = doc;
    this.container = container ?? doc.querySelector('#tool-ring');
    this.center = doc.querySelector('#tool-ring-center');

    this.tools = []; // { id, name }
    this.items = []; // HTMLElement[]
    this.index = 0;
    this.open = false;
    this._cursor = { x: 0, y: 0 };
    this._moved = 0;
    this._radius = 64;
    this.onSelect = null; // (index: number) => void
  }

  setTools(tools) {
    for (const item of this.items) item.remove();
    this.items = [];
    this.tools = tools;
    this._radius = tools.length > 8 ? 88 : 64;
    const n = tools.length;
    tools.forEach((tool, i) => {
      const el = this.doc.createElement('div');
      el.className = 'tool-ring-item';
      el.textContent = tool.name;
      this._position(el, i);
      this.container.appendChild(el);
      this.items.push(el);
    });
  }

  /** Show the ring, highlighting the currently active tool. */
  show(activeIndex) {
    if (this.tools.length === 0) return false;
    if (this.open) return true; // already open: don't reset the gesture
    this.index = Math.max(0, Math.min(this.tools.length - 1, activeIndex));
    const a = (this.index / this.tools.length) * Math.PI * 2;
    this._cursor = { x: Math.sin(a) * this._radius, y: -Math.cos(a) * this._radius };
    this._moved = 0;
    this.open = true;
    this.container.classList.remove('hidden');
    this._render();
    return true;
  }

  /** Feed mouse deltas while the ring is open. */
  move(dx, dy) {
    if (!this.open) return;
    this._cursor.x += dx * 0.7;
    this._cursor.y += dy * 0.7;
    this._moved += Math.abs(dx) + Math.abs(dy);
    const n = this.tools.length;
    let angle = Math.atan2(this._cursor.x, -this._cursor.y); // 0 at top, clockwise
    angle = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    this.index = Math.round((angle / (2 * Math.PI)) * n) % n;
    this._render();
  }

  get selectedIndex() {
    return this.index;
  }

  get selectedTool() {
    return this.tools[this.index] ?? null;
  }

  /** True when the mouse moved enough to be a real radial gesture. */
  get wasMoved() {
    return this._moved > 30;
  }

  close() {
    this.open = false;
    this.container.classList.add('hidden');
  }

  _position(el, i) {
    const a = (i / this.tools.length) * Math.PI * 2;
    el.style.left = `${Math.sin(a) * this._radius}px`;
    el.style.top = `${-Math.cos(a) * this._radius}px`;
  }

  _render() {
    this.center.textContent = this.tools[this.index]?.name ?? '';
    this.items.forEach((el, i) => el.classList.toggle('highlight', i === this.index));
  }
}
