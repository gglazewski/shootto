// Inventory.js — modal picker with the full block list.
//
// Toggled with E. Hovering a block tracks it so the number keys (1-0) can
// assign it to a hotbar slot while the panel is open. Clicking a block
// selects it and closes the panel. Shares the same swatch list as the
// toolbar so blocks always look consistent. Opening frees the pointer lock
// (wired in App); `onClose` lets the caller re-lock it when the panel closes.

export class Inventory {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.container  the modal root (#inventory)
   * @param {{id:string, name:string, canvas:HTMLCanvasElement}[]} deps.items
   * @param {{id:string, name:string, canvas:HTMLCanvasElement}[]} [deps.objectItems]
   *   registered placeable objects (shown in a separate section).
   * @param {{id:string, name:string, canvas:HTMLCanvasElement}[]} [deps.equipItems]
   *   registered equippable items (shown in a separate section).
   */
  constructor({ container, items, objectItems = [], equipItems = [] }) {
    this.items = items;
    this.objectItems = objectItems;
    this.equipItems = equipItems;
    this.container = container;
    this.onSelect = null;
    this.onSelectItem = null;
    this.onSelectEquip = null;
    /** Called whenever the panel closes (selection, E, or backdrop click). */
    this.onClose = null;
    /** The block/object currently under the cursor: { kind, id } or null. */
    this.hovered = null;

    const panel = this.container.querySelector('.panel');
    panel.innerHTML = '';
    const title = document.createElement('h2');
    title.textContent = 'Inventory';
    panel.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'inventory-grid';
    for (const item of items) {
      const btn = document.createElement('button');
      btn.className = 'inv-item';
      btn.dataset.id = item.id;
      btn.dataset.kind = 'block';
      btn.title = item.name;
      btn.appendChild(item.canvas);
      const label = document.createElement('span');
      label.textContent = item.name;
      btn.appendChild(label);
      btn.addEventListener('click', () => {
        if (this.onSelect) this.onSelect(item.id);
        this.hide();
      });
      btn.addEventListener('mouseenter', () => this.setHovered('block', item.id));
      grid.appendChild(btn);
    }
    panel.appendChild(grid);

    const hint = document.createElement('div');
    hint.className = 'inv-hint';
    hint.textContent = 'Hover a block or object and press 1-9 / 0 to assign it to the hotbar';
    panel.appendChild(hint);

    const section = document.createElement('h3');
    section.className = 'inv-section';
    section.textContent = 'Placeable Objects';
    panel.appendChild(section);
    this.objGrid = document.createElement('div');
    this.objGrid.className = 'inventory-grid obj-grid';
    panel.appendChild(this.objGrid);
    this.objEmpty = document.createElement('div');
    this.objEmpty.className = 'inv-hint';
    this.objEmpty.textContent = 'None yet — press F2 to build a placeable object';
    panel.appendChild(this.objEmpty);
    this._renderObjectItems();

    const equipSection = document.createElement('h3');
    equipSection.className = 'inv-section';
    equipSection.textContent = 'Equippable Items';
    panel.appendChild(equipSection);
    this.equipGrid = document.createElement('div');
    this.equipGrid.className = 'inventory-grid equip-grid';
    panel.appendChild(this.equipGrid);
    this.equipEmpty = document.createElement('div');
    this.equipEmpty.className = 'inv-hint';
    this.equipEmpty.textContent = 'None yet — press F3 to build an equippable item';
    panel.appendChild(this.equipEmpty);
    this._renderEquipItems();

    // clicking the dark backdrop (outside the panel) closes the inventory
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container) this.hide();
    });

    this.hide();
  }

  /** Replace the list of registered placeable objects and re-render. */
  updateObjectItems(objectItems) {
    this.objectItems = objectItems ?? [];
    this._renderObjectItems();
  }

  /** Replace the list of registered equippable items and re-render. */
  updateEquipItems(equipItems) {
    this.equipItems = equipItems ?? [];
    this._renderEquipItems();
  }

  _renderObjectItems() {
    this.objGrid.innerHTML = '';
    for (const item of this.objectItems) {
      const btn = document.createElement('button');
      btn.className = 'inv-item';
      btn.dataset.id = item.id;
      btn.dataset.kind = 'item';
      btn.title = item.name;
      btn.appendChild(item.canvas);
      const label = document.createElement('span');
      label.textContent = item.name;
      btn.appendChild(label);
      btn.addEventListener('click', () => {
        if (this.onSelectItem) this.onSelectItem(item.id);
        this.hide();
      });
      btn.addEventListener('mouseenter', () => this.setHovered('item', item.id));
      this.objGrid.appendChild(btn);
    }
    this.objEmpty.style.display = this.objectItems.length ? 'none' : '';
  }

  _renderEquipItems() {
    this.equipGrid.innerHTML = '';
    for (const item of this.equipItems) {
      const btn = document.createElement('button');
      btn.className = 'inv-item';
      btn.dataset.id = item.id;
      btn.dataset.kind = 'equip';
      btn.title = item.name;
      btn.appendChild(item.canvas);
      const label = document.createElement('span');
      label.textContent = item.name;
      btn.appendChild(label);
      btn.addEventListener('click', () => {
        if (this.onSelectEquip) this.onSelectEquip(item.id);
        this.hide();
      });
      btn.addEventListener('mouseenter', () => this.setHovered('equip', item.id));
      this.equipGrid.appendChild(btn);
    }
    this.equipEmpty.style.display = this.equipItems.length ? 'none' : '';
  }

  /** Mark `kind`/`id` as hovered and highlight its grid item (all off if null). */
  setHovered(kind, id) {
    this.hovered = kind && id ? { kind, id } : null;
    for (const btn of this.container.querySelectorAll('.inv-item')) {
      const match = this.hovered && btn.dataset.kind === kind && btn.dataset.id === id;
      btn.classList.toggle('hovered', !!match);
    }
  }

  /** Id of the hovered block or object (back-compat with tests). */
  get hoveredId() {
    return this.hovered?.id ?? null;
  }

  show() {
    this.container.classList.add('open');
  }

  hide() {
    const wasOpen = this.isOpen;
    this.container.classList.remove('open');
    this.setHovered(null, null);
    if (wasOpen && this.onClose) this.onClose();
  }

  toggle() {
    if (this.isOpen) this.hide();
    else this.show();
    return this.isOpen;
  }

  get isOpen() {
    return this.container.classList.contains('open');
  }
}
