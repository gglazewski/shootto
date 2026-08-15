// SwitchModal.js — wall-switch wiring, opened by clicking a switch decal in
// the editor.
//
// One setting: the game flag the switch drives. In the game, E on the switch
// flips the flag; lights whose "Powered by flag" and doors whose "Unlocks
// when flag" name the same flag react instantly (see game/Reactions.js).
//
// DOM-only (reuses the door modal's styles); the caller stores the flag on
// the placed decal entry.

export class SwitchModal {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} deps.container  the modal root (#switch-settings)
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
   * Show the wiring for one switch.
   * @param {{flag: string, startOn?: boolean}} state
   * @param {(change: {flag?: string, startOn?: boolean}) => void} onApply
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
    head.textContent = 'Light Switch';
    this.panel.appendChild(head);

    const flagRow = doc.createElement('label');
    flagRow.className = 'door-flag';
    flagRow.append('Flips flag');
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
      ? `E in the game flips “${s.flag}” on and off. Lights powered by it and doors unlocked by it follow the switch.`
      : 'Name a flag and E in the game flips it — lights with “Powered by flag” and doors with “Unlocks when flag” set to the same name follow the switch. Without a flag the switch is scenery.';
    this.panel.appendChild(flagHint);

    const startRow = doc.createElement('label');
    startRow.className = 'ie-check';
    const startIn = doc.createElement('input');
    startIn.type = 'checkbox';
    startIn.checked = !!s.startOn;
    startIn.addEventListener('change', () => {
      this._apply({ startOn: startIn.checked });
    });
    startRow.appendChild(startIn);
    startRow.appendChild(doc.createTextNode('Starts ON — the flag is raised when the game begins'));
    this.panel.appendChild(startRow);

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
