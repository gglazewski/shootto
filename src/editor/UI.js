// UI.js — HUD overlay: crosshair, status text, action toast, and the
// Save/Load/Export/Clear buttons. DOM-only (browser).

export class UI {
  /**
   * @param {object} deps
   * @param {Document} deps.doc
   * @param {object} [deps.callbacks] {save, load, export, clear, undo, redo}
   */
  constructor({ doc = document, callbacks = {} }) {
    this.doc = doc;
    this.cb = callbacks;

    this.el = {
      crosshair: this.$('#ui-crosshair'),
      hudType: this.$('#hud-type'),
      hudSize: this.$('#hud-size'),
      hudPos: this.$('#hud-pos'),
      hudSpeed: this.$('#hud-speed'),
      hudFps: this.$('#hud-fps'),
      hudTool: this.$('#hud-tool'),
      action: this.$('#ui-action'),
      hint: this.$('#ui-hint'),
      save: this.$('#btn-save'),
      load: this.$('#btn-load'),
      export: this.$('#btn-export'),
      saveFile: this.$('#btn-save-file'),
      clear: this.$('#btn-clear'),
      undo: this.$('#btn-undo'),
      redo: this.$('#btn-redo'),
      items: this.$('#btn-items'),
      file: this.$('#file-load'),
    };

    this.el.save.addEventListener('click', () => this.cb.save && this.cb.save());
    this.el.export.addEventListener('click', () => this.cb.export && this.cb.export());
    this.el.saveFile.addEventListener('click', () => this.cb.saveFile && this.cb.saveFile());
    this.el.clear.addEventListener('click', () => this.cb.clear && this.cb.clear());
    this.el.undo.addEventListener('click', () => this.cb.undo && this.cb.undo());
    this.el.redo.addEventListener('click', () => this.cb.redo && this.cb.redo());
    this.el.items.addEventListener('click', () => this.cb.items && this.cb.items());
    this.el.load.addEventListener('click', () => this.el.file.click());
    this.el.hint.addEventListener('click', () => this.hideHelp());
    this.el.file.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        this.cb.load && this.cb.load(String(reader.result));
        e.target.value = '';
      };
      reader.readAsText(file);
    });
  }

  $(sel) {
    return this.doc.querySelector(sel);
  }

  setSelection(type, size) {
    this.el.hudType.textContent = type ?? '—';
    this.el.hudSize.textContent = size ?? '';
  }

  setTool(name) {
    this.el.hudTool.textContent = name;
  }

  setPosition(x, y, z) {
    this.el.hudPos.textContent = `${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`;
  }

  setFps(fps) {
    this.el.hudFps.textContent = fps.toFixed(0);
  }

  setSpeed(speed) {
    this.el.hudSpeed.textContent = speed.toFixed(1);
  }

  showHelp() {
    this.el.hint.classList.remove('hidden');
  }

  hideHelp() {
    this.el.hint.classList.add('hidden');
  }

  /** Toggle the F1 help overlay. @returns {boolean} whether it is now visible */
  toggleHelp() {
    this.el.hint.classList.toggle('hidden');
    return !this.el.hint.classList.contains('hidden');
  }

  get helpVisible() {
    return !this.el.hint.classList.contains('hidden');
  }

  /** Transient message under the crosshair. */
  toast(text, ms = 1600) {
    this.el.action.textContent = text;
    this.el.action.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.el.action.classList.remove('show'), ms);
  }
}
