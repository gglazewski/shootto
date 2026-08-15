// NpcPalette.js — the NPC picker shown while the NPC tool is active.
//
// A card panel on the right edge, one card per registered NPC type
// (built-ins plus whatever the F4 editor authored). Each card shows the
// character's actual drawn sprite — idle pose, cropped to the standing
// rows of the frame box — above the name, so you can see who you are about
// to place instead of deciphering ids. Clicking a card selects that type;
// G still cycles types and the highlight follows. The card list rebuilds
// from the registry every time the palette opens (and after F4 edits), so
// new or reskinned NPCs appear without a reload.
//
// DOM-only (browser); the sprite art decodes asynchronously, so each thumb
// paints once immediately (blank before first decode) and repaints when the
// sheet's `ready` promise settles — same contract as MobRenderer.

import { listNpcs } from '../engine/NpcRegistry.js';
import { buildMobSpriteSheet, SHEET_STAND_ROWS, SHEET_GROUND_ROW } from '../game/mobSprites.js';

export class NpcPalette {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} deps.container  #npc-palette
   * @param {(id: string) => void} [deps.onPick]  a card was clicked
   */
  constructor({ doc = document, container, onPick } = {}) {
    this.doc = doc;
    this.root = container;
    this.onPick = onPick ?? null;
    this.selectedId = null;
    this._sheets = new Map(); // skin -> sprite sheet (canvas + ready)
    this._cards = new Map(); // npc id -> card element
  }

  /** Open with `selectedId` highlighted, rebuilding the cards. */
  show(selectedId = this.selectedId) {
    this.refresh(selectedId);
    this.root.classList.add('open');
  }

  hide() {
    this.root.classList.remove('open');
  }

  get isOpen() {
    return this.root.classList.contains('open');
  }

  /** Move the highlight without rebuilding (G-cycle keeps the palette in sync). */
  setSelected(id) {
    this.selectedId = id;
    for (const [npcId, card] of this._cards) card.classList.toggle('active', npcId === id);
  }

  /** Rebuild the card list from the registry. */
  refresh(selectedId = this.selectedId) {
    this.selectedId = selectedId;
    this._cards.clear();
    this.root.innerHTML = '<div class="np-title">NPCs</div>';
    const list = listNpcs();
    if (!list.length) {
      const empty = this.doc.createElement('div');
      empty.className = 'np-empty';
      empty.textContent = 'No NPC types — author one in the NPC editor (F4)';
      this.root.appendChild(empty);
      return;
    }
    const grid = this.doc.createElement('div');
    grid.className = 'np-cards';
    for (const npc of list) {
      const card = this.doc.createElement('button');
      card.className = 'np-card';
      card.title = `Place ${npc.name}`;
      card.appendChild(this._thumb(npc.skin));
      const name = this.doc.createElement('span');
      name.className = 'np-name';
      name.textContent = npc.name;
      card.appendChild(name);
      card.addEventListener('click', () => {
        this.setSelected(npc.id);
        this.onPick?.(npc.id);
      });
      this._cards.set(npc.id, card);
      grid.appendChild(card);
    }
    this.root.appendChild(grid);
    const hint = this.doc.createElement('div');
    hint.className = 'np-hint';
    hint.innerHTML = '<kbd>Esc</kbd> frees the mouse to pick · <kbd>G</kbd> cycles';
    this.root.appendChild(hint);
    this.setSelected(this._cards.has(this.selectedId) ? this.selectedId : list[0].id);
  }

  /** Canvas with the skin's idle pose, cropped to the standing rows. */
  _thumb(skin) {
    let sheet = this._sheets.get(skin);
    if (!sheet) {
      sheet = buildMobSpriteSheet(skin);
      this._sheets.set(skin, sheet);
    }
    const canvas = this.doc.createElement('canvas');
    canvas.className = 'np-thumb';
    canvas.width = sheet.frameW;
    canvas.height = SHEET_STAND_ROWS;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Idle frame 0, cropped to where a standing figure lives in the box —
      // the full frame also holds outflung arms and a lying corpse, so the
      // uncropped art would render every character tiny.
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
}
