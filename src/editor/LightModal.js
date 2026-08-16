// LightModal.js — per-light settings, opened by clicking a light in the editor.
//
// Two settings, mirroring what Lights.js stores on the voxel:
//   - the authored state: on, off or flickering (the horror-movie strobe)
//   - a power flag: name a game flag and the light stays dark until the game
//     raises it — a wall switch wired to the same name, or a quest's Flags
//     fields. '!name' inverts (lit until the flag goes up).
//
// DOM-only (reuses the door modal's styles); the caller applies the choice
// to the voxel and re-meshes.

import { closeX } from './closeX.js';

/** The three states, in display order. */
const MODES = [
  { mode: 'on', label: '💡 On' },
  { mode: 'off', label: '⚫ Off' },
  { mode: 'flicker', label: '⚡ Flickering' },
];

const MODE_HINTS = {
  on: 'Steady light.',
  off: 'Dark until something turns it on (a flag, or this dialog).',
  flicker: 'Broken-bulb strobe: calm lit stretches broken by fits of rapid chatter.',
};

export class LightModal {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} deps.container  the modal root (#light-settings)
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
   * Show the settings for one light.
   * @param {{name: string, mode: 'on'|'off'|'flicker', flag: string}} state
   * @param {(change: {mode?: string, flag?: string}) => void} onApply
   *   Called on every change; the modal stays open so both settings can be
   *   adjusted in one visit.
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
    head.textContent = s.name || 'Light';
    this.panel.appendChild(head);
    this.panel.appendChild(closeX(doc, () => this.hide()));

    // --- state ---
    const row = doc.createElement('div');
    row.className = 'door-row';
    for (const { mode, label } of MODES) {
      const btn = doc.createElement('button');
      btn.className = 'cat-btn door-lock';
      if (s.mode === mode) btn.classList.add('active');
      btn.textContent = label;
      btn.addEventListener('click', () => this._apply({ mode }));
      row.appendChild(btn);
    }
    this.panel.appendChild(row);

    const modeHint = doc.createElement('p');
    modeHint.className = 'door-hint';
    modeHint.textContent = MODE_HINTS[s.mode] ?? '';
    this.panel.appendChild(modeHint);

    // --- power flag (action/reaction) ---
    const flagRow = doc.createElement('label');
    flagRow.className = 'door-flag';
    flagRow.append('Powered by flag');
    const flagIn = doc.createElement('input');
    flagIn.type = 'text';
    flagIn.placeholder = 'none';
    flagIn.value = s.flag ?? '';
    flagIn.addEventListener('change', () => {
      this._apply({ flag: flagIn.value.trim() });
    });
    flagRow.appendChild(flagIn);
    this.panel.appendChild(flagRow);

    const flagHint = doc.createElement('p');
    flagHint.className = 'door-hint';
    flagHint.textContent = s.flag
      ? `Dark until the game raises “${s.flag.replace(/^!/, '')}” — then it runs the state above. A wall switch with the same flag flips it; quests can too. '!' inverts.`
      : 'Optional: name a flag and the light stays dark until the game raises it — a wall switch wired to the same name, or a quest. Prefix with ! to invert.';
    this.panel.appendChild(flagHint);

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
