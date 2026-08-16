// MobModal.js — per-spawner settings, opened by clicking a mob spawn beacon
// in the editor.
//
// Three settings ride on the spawn record (see World.addMobSpawn):
//   - loot: the pool of melee items the spawner's mobs may drop.
//     null = default pool (every melee item), [] = drops nothing,
//     ['id', ...] = custom pool.
//   - delay: [min, max] respawn wait in seconds (null = game default).
//   - skins: the drawn characters this spawner's mobs wear (nurses in a
//     hospital, police in a station). null = any character; a non-empty
//     list restricts every wave to those looks. Cosmetic only.
//
// DOM-only (reuses the door modal's styles); the caller stores the changes on
// the spawn record. Middle-clicking a beacon copies these settings into the
// mob tool, so freshly placed spawners inherit them.

import { listEquipItems } from '../engine/EquipmentRegistry.js';
import { buildItemSwatch } from './items/itemSwatch.js';
import { closeX } from './closeX.js';
import {
  buildMobSpriteSheet, SPAWN_SKINS, SHEET_STAND_ROWS, SHEET_GROUND_ROW,
} from '../game/mobSprites.js';

/** Game-default respawn delay range, shown as input placeholders. */
const DEFAULT_DELAY = [20, 50];

export class MobModal {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} deps.container  the modal root (#mob-settings)
   */
  constructor({ doc = document, container }) {
    this.doc = doc;
    this.container = container;
    this.onClose = null;
    this._onApply = null;
    this._sheets = new Map(); // skin -> sprite sheet, built once per session

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
   * Show one spawner's settings.
   * @param {{typeName: string, loot: string[]|null, delay: [number,number]|null,
   *          skins: string[]|null}} state
   * @param {(change: {loot?: string[]|null, delay?: [number,number]|null,
   *          skins?: string[]|null}) => void} onApply
   */
  open(state, onApply) {
    this._state = { ...state };
    this._custom = false;
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
    head.textContent = `Spawner — ${s.typeName}`;
    this.panel.appendChild(head);
    this.panel.appendChild(closeX(doc, () => this.hide()));

    // --- respawn timer range ---
    const timerHead = doc.createElement('h3');
    timerHead.textContent = 'Respawn timer (seconds)';
    this.panel.appendChild(timerHead);

    const timerRow = doc.createElement('label');
    timerRow.className = 'door-flag';
    timerRow.append('Between');
    const minIn = doc.createElement('input');
    minIn.type = 'number';
    minIn.min = '0';
    minIn.placeholder = String(DEFAULT_DELAY[0]);
    minIn.value = s.delay ? String(s.delay[0]) : '';
    timerRow.appendChild(minIn);
    timerRow.append('and');
    const maxIn = doc.createElement('input');
    maxIn.type = 'number';
    maxIn.min = '0';
    maxIn.placeholder = String(DEFAULT_DELAY[1]);
    maxIn.value = s.delay ? String(s.delay[1]) : '';
    timerRow.appendChild(maxIn);
    const applyDelay = () => {
      const min = Number(minIn.value);
      const max = Number(maxIn.value);
      if (minIn.value === '' && maxIn.value === '') {
        this._apply({ delay: null });
        return;
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) return;
      this._apply({ delay: [Math.max(0, min), Math.max(0, min, max)] });
    };
    minIn.addEventListener('change', applyDelay);
    maxIn.addEventListener('change', applyDelay);
    this.panel.appendChild(timerRow);

    const timerHint = doc.createElement('p');
    timerHint.className = 'door-hint';
    timerHint.textContent = s.delay
      ? `A cleared wave returns after ${s.delay[0]}–${s.delay[1]} s. Clear both fields for the default.`
      : `Default: a cleared wave returns after ${DEFAULT_DELAY[0]}–${DEFAULT_DELAY[1]} s.`;
    this.panel.appendChild(timerHint);

    // --- character sprites ---
    const skinHead = doc.createElement('h3');
    skinHead.textContent = 'Characters';
    this.panel.appendChild(skinHead);

    const skinGrid = doc.createElement('div');
    skinGrid.className = 'mob-loot-grid';
    for (const skin of SPAWN_SKINS) {
      const row = doc.createElement('label');
      row.className = 'mob-loot-item';
      const box = doc.createElement('input');
      box.type = 'checkbox';
      box.checked = !!s.skins?.includes(skin);
      box.addEventListener('change', () => {
        const pool = new Set(s.skins ?? []);
        if (box.checked) pool.add(skin);
        else pool.delete(skin);
        // Keep SPAWN_SKINS order so the stored pool is stable; an empty pool
        // stores null = any character (a spawner can't wear nothing).
        const skins = SPAWN_SKINS.filter((k) => pool.has(k));
        this._apply({ skins: skins.length ? skins : null });
      });
      row.appendChild(box);
      row.appendChild(this._skinThumb(skin));
      row.appendChild(doc.createTextNode(skin));
      skinGrid.appendChild(row);
    }
    this.panel.appendChild(skinGrid);

    const skinHint = doc.createElement('p');
    skinHint.className = 'door-hint';
    skinHint.textContent = s.skins?.length
      ? 'This spawner only sends out the checked characters (looks only — stats come from the mob type).'
      : 'None checked: every wave is a random mix. Check characters to restrict the look — nurses in a hospital, police in a station.';
    this.panel.appendChild(skinHint);

    // --- loot pool ---
    const lootHead = doc.createElement('h3');
    lootHead.textContent = 'Loot pool';
    this.panel.appendChild(lootHead);

    const modeRow = doc.createElement('label');
    modeRow.className = 'door-flag';
    modeRow.append('Drops');
    const modeSel = doc.createElement('select');
    for (const [value, label] of [
      ['default', 'Default (materials + any melee weapon)'],
      ['none', 'Nothing'],
      ['custom', 'Custom pool…'],
    ]) {
      const opt = doc.createElement('option');
      opt.value = value;
      opt.textContent = label;
      modeSel.appendChild(opt);
    }
    // An empty custom pool and "Nothing" both store [] — the sticky _custom
    // flag keeps the checkbox list open while the user is still picking.
    modeSel.value = s.loot == null ? 'default'
      : s.loot.length === 0 && !this._custom ? 'none' : 'custom';
    modeSel.addEventListener('change', () => {
      this._custom = modeSel.value === 'custom';
      if (modeSel.value === 'default') this._apply({ loot: null });
      else if (modeSel.value === 'none') this._apply({ loot: [] });
      else this._apply({ loot: s.loot ?? [] });
    });
    modeRow.appendChild(modeSel);
    this.panel.appendChild(modeRow);

    if (modeSel.value === 'custom') {
      const all = listEquipItems();
      const isMelee = (i) => i.kind === 'weapon' && (i.weapon?.kind ?? 'melee') === 'melee';
      const groups = [
        { title: 'Weapons (rare drop)', items: all.filter(isMelee) },
        { title: 'Materials (common drop)', items: all.filter((i) => i.kind === 'material') },
      ];
      if (!groups.some((g) => g.items.length)) {
        const empty = doc.createElement('p');
        empty.className = 'door-hint';
        empty.textContent = 'No melee weapons or materials in the catalogue yet (F3 to build one).';
        this.panel.appendChild(empty);
      }
      for (const group of groups) {
        if (!group.items.length) continue;
        const head = doc.createElement('h3');
        head.textContent = group.title;
        this.panel.appendChild(head);
        const grid = doc.createElement('div');
        grid.className = 'mob-loot-grid';
        for (const item of group.items) {
          const row = doc.createElement('label');
          row.className = 'mob-loot-item';
          const box = doc.createElement('input');
          box.type = 'checkbox';
          box.checked = !!s.loot?.includes(item.id);
          box.addEventListener('change', () => {
            const pool = new Set(s.loot ?? []);
            if (box.checked) pool.add(item.id);
            else pool.delete(item.id);
            this._apply({ loot: [...pool] });
          });
          row.appendChild(box);
          row.appendChild(buildItemSwatch(item, 28));
          row.appendChild(doc.createTextNode(item.name));
          grid.appendChild(row);
        }
        this.panel.appendChild(grid);
      }
    }

    const lootHint = doc.createElement('p');
    lootHint.className = 'door-hint';
    lootHint.textContent =
      'On death: a rare chance to drop a weapon from the pool, and a common chance to drop a material. Middle-click the beacon to copy the spawner, settings included.';
    this.panel.appendChild(lootHint);

    const close = doc.createElement('button');
    close.className = 'cat-btn cat-close';
    close.textContent = 'Done';
    close.addEventListener('click', () => this.hide());
    this.panel.appendChild(close);
  }

  /** Canvas with the skin's idle pose, cropped to the standing rows (same
   *  crop as the NPC palette — the full frame also holds a lying corpse). */
  _skinThumb(skin) {
    let sheet = this._sheets.get(skin);
    if (!sheet) {
      sheet = buildMobSpriteSheet(skin);
      this._sheets.set(skin, sheet);
    }
    const canvas = this.doc.createElement('canvas');
    canvas.className = 'mob-skin-thumb';
    canvas.width = sheet.frameW;
    canvas.height = SHEET_STAND_ROWS;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(
        sheet.canvas,
        0, SHEET_GROUND_ROW + 1 - SHEET_STAND_ROWS, sheet.frameW, SHEET_STAND_ROWS,
        0, 0, canvas.width, canvas.height,
      );
    };
    draw(); // blank before the strip decodes…
    sheet.ready?.then(draw).catch(() => {}); // …so repaint once the art lands
    return canvas;
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
