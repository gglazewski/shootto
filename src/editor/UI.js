// UI.js — the editor's left sidebar (action buttons + live inspector) plus
// the crosshair overlays: status text, action toast and the F1 help panel.
// DOM-only (browser); every button routes through an injected callback.

export class UI {
  /**
   * @param {object} deps
   * @param {Document} deps.doc
   * @param {object} [deps.callbacks] one per sidebar action:
   *   {save, load, export, newWorld, undo, redo, items, prefabs, worlds,
   *    objects, equip, npcs, test, help}
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
      hudVoxels: this.$('#hud-voxels'),
      hudObjects: this.$('#hud-objects'),
      hudMobs: this.$('#hud-mobs'),
      hudNpcs: this.$('#hud-npcs'),
      action: this.$('#ui-action'),
      prompt: this.$('#ui-prompt'),
      hint: this.$('#ui-hint'),
      sidebar: this.$('#sidebar'),
      collapse: this.$('#sb-collapse'),
      show: this.$('#sb-show'),
      worldName: this.$('#sb-world-name'),
      dirty: this.$('#sb-dirty'),
      new: this.$('#btn-new'),
      save: this.$('#btn-save'),
      load: this.$('#btn-load'),
      export: this.$('#btn-export'),
      undo: this.$('#btn-undo'),
      redo: this.$('#btn-redo'),
      history: this.$('#sb-history'),
      items: this.$('#btn-items'),
      prefabs: this.$('#btn-prefabs'),
      worlds: this.$('#btn-worlds'),
      objects: this.$('#btn-objects'),
      equip: this.$('#btn-equip'),
      npcs: this.$('#btn-npcs'),
      test: this.$('#btn-test'),
      help: this.$('#btn-help'),
      file: this.$('#file-load'),
    };

    // Every sidebar button is a thin shim over one callback, so the table
    // below is the whole wiring — a new action means one row here.
    const wire = (key, fn) => this.el[key]?.addEventListener('click', fn);
    for (const key of ['save', 'export', 'undo', 'redo', 'items', 'prefabs',
      'worlds', 'objects', 'equip', 'npcs', 'test', 'help']) {
      wire(key, () => this.cb[key]?.());
    }
    wire('new', () => this.armNew()); // destructive — two-step confirm
    wire('load', () => this.pickFile());
    wire('collapse', () => this.toggleSidebar());
    wire('show', () => this.toggleSidebar());

    this.el.hint.addEventListener('click', () => this.hideHelp());
    // Esc dismisses the help overlay, like every other modal.
    this.doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.helpVisible) this.hideHelp();
    });
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

  // --- sidebar ---

  /** Show/hide the sidebar (` or the chevrons). @returns {boolean} now visible */
  toggleSidebar(visible) {
    const body = this.doc.body;
    const collapsed = visible == null ? !body.classList.contains('sb-collapsed') : !visible;
    body.classList.toggle('sb-collapsed', collapsed);
    return !collapsed;
  }

  /** Open the hidden file picker behind "Load file". */
  pickFile() {
    this.el.file?.click();
  }

  /**
   * "New world" throws the open world away, so it takes two presses: the
   * first arms the button (and says so), the second within ~2.5 s fires.
   * Same idiom as the catalogues' Del buttons.
   * @returns {boolean} true when the action actually ran
   */
  armNew() {
    if (this._newArmed) {
      clearTimeout(this._newArmed);
      this._newArmed = null;
      this._paintNew(false);
      this.cb.newWorld?.();
      return true;
    }
    this._paintNew(true);
    this.toast('New world — press again to discard the current one', 2400);
    this._newArmed = setTimeout(() => {
      this._newArmed = null;
      this._paintNew(false);
    }, 2500);
    return false;
  }

  _paintNew(armed) {
    const btn = this.el.new;
    if (!btn) return;
    btn.classList.toggle('armed', armed);
    // The label is the button's text node (it sits between the icon and the
    // shortcut chip), so swap that node alone.
    const text = [...btn.childNodes].find((n) => n.nodeType === 3);
    if (text) text.nodeValue = armed ? 'Discard world?' : 'New';
  }

  /**
   * Render the sidebar's edit timeline and undo/redo enablement.
   * `past` holds applied edits oldest-first (the last one is where you are),
   * `future` holds undone edits redo would re-apply, nearest-first.
   * @param {{past: string[], future: string[]}} timeline
   * @param {(delta: number) => void} [onJump] steps to undo (<0) / redo (>0)
   */
  setHistory({ past = [], future = [] } = {}, onJump = null) {
    if (this.el.undo) this.el.undo.disabled = past.length === 0;
    if (this.el.redo) this.el.redo.disabled = future.length === 0;
    const host = this.el.history;
    if (!host) return;
    host.textContent = '';
    const doc = this.doc;
    if (!past.length && !future.length) {
      const empty = doc.createElement('div');
      empty.className = 'sbh-empty';
      empty.textContent = 'No edits yet';
      host.appendChild(empty);
      return;
    }
    // Keep the rail short: the tail of the applied edits plus the first few
    // redoable ones. The current state is always visible.
    const rows = [
      { label: 'Original', delta: -past.length, kind: past.length ? 'past' : 'current' },
      ...past.map((label, i) => ({
        label, delta: i + 1 - past.length, kind: i === past.length - 1 ? 'current' : 'past',
      })).slice(-7),
      ...future.map((label, i) => ({ label, delta: i + 1, kind: 'future' })).slice(0, 3),
    ];
    for (const r of rows) {
      const row = doc.createElement('div');
      row.className = `sbh-row ${r.kind}`;
      const dot = doc.createElement('span');
      dot.className = 'sbh-dot';
      const label = doc.createElement('span');
      label.className = 'sbh-label';
      label.textContent = r.label;
      row.append(dot, label);
      row.title = r.kind === 'current' ? 'You are here'
        : r.delta < 0 ? `Undo back to “${r.label}”` : `Redo forward to “${r.label}”`;
      if (r.delta !== 0 && onJump) {
        row.addEventListener('click', () => onJump(r.delta));
      }
      host.appendChild(row);
    }
  }

  /** Which library world is open, and whether it has unsaved edits. */
  setWorld(path, dirty) {
    if (this.el.worldName) {
      const label = path ? path.replace(/\.json$/i, '') : 'unsaved world';
      if (this.el.worldName.textContent !== label) {
        this.el.worldName.textContent = label;
        this.el.worldName.title = path
          ? `worlds/${path}`
          : 'Not in the world catalogue yet — use Worlds… ▸ Save here';
      }
    }
    this.el.dirty?.classList.toggle('on', !!dirty);
  }

  /** World contents counters shown in the inspector. */
  setStats({ voxels, objects, mobs, npcs } = {}) {
    const put = (el, n) => {
      if (el) el.textContent = n == null ? '-' : String(n);
    };
    put(this.el.hudVoxels, voxels);
    put(this.el.hudObjects, objects);
    put(this.el.hudMobs, mobs);
    put(this.el.hudNpcs, npcs);
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

  /** Standing interaction prompt under the crosshair (test run). Pass null
   *  to clear it. Accepts markup so callers can wrap keys in <kbd>. */
  setPrompt(html) {
    if (!this.el.prompt) return;
    if (html) {
      this.el.prompt.innerHTML = html;
      this.el.prompt.classList.remove('hidden');
    } else {
      this.el.prompt.classList.add('hidden');
    }
  }

  /** Transient message under the crosshair. */
  toast(text, ms = 1600) {
    this.el.action.textContent = text;
    this.el.action.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.el.action.classList.remove('show'), ms);
  }
}
