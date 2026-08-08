// Toolbar.js — bottom hotbar with 10 fixed shortcuts (keys 1..0).
//
// Renders exactly TOOLBAR_SLOTS slots. Slots are pre-filled from the block
// list; the rest stay empty until assigned. A slot holds an entry
// { kind: 'block'|'item', id, name, canvas }, so both blocks and placeable
// objects can be assigned to a slot (from the inventory by hovering one and
// pressing the number key, or by clicking a filled slot to make it active).
// Selecting a block slot reports the block id; selecting an item slot reports
// the item id — the caller wires this to the right selection state.

export const TOOLBAR_SLOTS = 10;

export class Toolbar {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.container
   * @param {{id:string, name:string, canvas:HTMLCanvasElement}[]} deps.items
   *   the full block swatch list; used to resolve block ids assigned to slots.
   */
  constructor({ container, items }) {
    this.items = items.map((it) => ({ ...it, kind: 'block' }));
    this.slots = this.items.slice(0, TOOLBAR_SLOTS).concat(
      new Array(Math.max(0, TOOLBAR_SLOTS - items.length)).fill(null),
    );
    this.selected = 0;
    this.onSelect = null;

    this.container = container;
    this.container.classList.add('toolbar');
    this.slotEls = [];

    for (let i = 0; i < TOOLBAR_SLOTS; i++) {
      const slot = document.createElement('button');
      slot.className = 'slot';
      const label = document.createElement('span');
      label.className = 'slot-label';
      label.textContent = i === TOOLBAR_SLOTS - 1 ? '0' : String(i + 1);
      slot.appendChild(label);
      slot.addEventListener('click', () => this.toggle(i));
      this.container.appendChild(slot);
      this.slotEls.push(slot);
    }

    this.render();
  }

  /** Put the entry { kind, id, name, canvas } into slot `index`, removing it
   *  from any other slot. @returns {boolean} */
  assign(index, entry) {
    if (index < 0 || index >= TOOLBAR_SLOTS) return false;
    if (!entry || !entry.id) return false;
    const key = `${entry.kind ?? 'block'}:${entry.id}`;
    for (let i = 0; i < TOOLBAR_SLOTS; i++) {
      const s = this.slots[i];
      if (s && `${s.kind}:${s.id}` === key) this.slots[i] = null;
    }
    this.slots[index] = { ...entry };
    this.render();
    return true;
  }

  /** User gesture: select a slot, or deselect it when it's already active. */
  toggle(index) {
    if (index < 0 || index >= TOOLBAR_SLOTS) return;
    if (index === this.selected && this.slots[index]) {
      this.deselect();
      return;
    }
    this.select(index);
  }

  select(index) {
    if (index < 0 || index >= TOOLBAR_SLOTS) return;
    this.selected = index;
    this.render();
    if (this.onSelect) this.onSelect(this.slots[index] ?? null);
  }

  /** Select the first slot holding a block with `id`; no-op if not on the bar. */
  selectType(id) {
    this._selectByKind('block', id);
  }

  /** Select the first slot holding an item with `id`; no-op if not on the bar. */
  selectItem(id) {
    this._selectByKind('item', id);
  }

  /** Select the first slot holding a decal with `id`; no-op if not on the bar. */
  selectDecal(id) {
    this._selectByKind('decal', id);
  }

  _selectByKind(kind, id) {
    const i = this.slots.findIndex((it) => it && it.kind === kind && it.id === id);
    if (i >= 0) this.select(i);
  }

  /** Clear the active slot highlight (e.g. when nothing is selected). */
  clearSelection() {
    this.selected = -1;
    this.render();
  }

  /** Deselect the active slot and notify the caller with null. */
  deselect() {
    this.selected = -1;
    this.render();
    if (this.onSelect) this.onSelect(null);
  }

  get selectedId() {
    return this.slots[this.selected]?.id;
  }

  /** Key label for a slot index (1..9, 0). */
  static keyFor(index) {
    return index === TOOLBAR_SLOTS - 1 ? '0' : String(index + 1);
  }

  render() {
    this.slotEls.forEach((s, i) => {
      const item = this.slots[i];
      s.classList.toggle('active', i === this.selected);
      s.classList.toggle('empty', !item);
      s.title = item ? `${item.name} (${Toolbar.keyFor(i)})` : `Empty slot (${Toolbar.keyFor(i)})`;
      const old = s.querySelector('canvas');
      if (old) s.removeChild(old);
      if (item) s.appendChild(item.canvas);
    });
  }
}
