// TouchControls.js — mobile touch layer for the playable game.
//
// Mirrors the Minecraft mobile scheme: a floating joystick on the left half of
// the screen (digital, feeds WASD), drag-to-look on the right half, and an
// on-screen button cluster (attack/reload/pickup/inject/sprint/crouch/slots/
// pause) that maps onto the game's existing actions. Uses Pointer Events with
// capture so joystick + look + buttons all work under multi-touch. The widgets
// themselves live in game.html (#touch-layer); this class only wires them up.

const JOY_ZONE = 0.4;        // left fraction of the screen that starts the joystick
const JOY_MAX_RADIUS = 64;   // px the knob can travel before clamping
const JOY_DEAD = 10;         // px before the joystick does anything
const LOOK_MULT = 1.8;       // × mouse sensitivity for finger drags
const AXIS_THRESHOLD = 0.2;  // normalized joystick deflection that triggers a key

export class TouchControls {
  /** True when the primary input is a touchscreen (coarse pointer, no mouse). */
  static isTouch() {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const fine = window.matchMedia('(pointer: fine)').matches;
    return coarse && !fine;
  }

  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {import('../editor/WalkControls.js').WalkControls} deps.walk
   * @param {object} [deps.callbacks] wired onto the on-screen buttons
   */
  constructor({ doc = document, walk, callbacks = {} }) {
    this.doc = doc;
    this.walk = walk;
    this.cb = {
      attack: null,
      reload: null,
      pickup: null,
      inject: null,
      selectSlot: null,
      pause: null,
      ...callbacks,
    };

    this.attacking = false; // set while the fire button is held (auto-repeat)
    this.enabled = true;
    this._sprint = false;
    this._crouch = false;
    this._joy = null;          // { px, py, dx, dy } | null
    this._active = new Map();  // pointerId -> { kind: 'joy'|'look', x, y }
    this._lookMult = (walk?.sensitivity ?? 0.0022) * LOOK_MULT;

    this.root = doc.getElementById('touch-layer');
    if (!this.root) return;
    this.joyBase = doc.getElementById('joy-base');
    this.joyKnob = doc.getElementById('joy-knob');
    this._buttonCleanup = [];

    this._bindLayer();
    this._bindButtons();
    this._bindSlots();
    this.setEnabled(false); // start hidden; GameApp shows it while playing
  }

  // --- joystick ---

  _joyBoundary() {
    return window.innerWidth * JOY_ZONE;
  }

  _startJoy(x, y) {
    this._joy = { px: x, py: y, dx: 0, dy: 0 };
    if (this.joyBase && this.joyKnob) {
      this.joyBase.style.left = `${x}px`;
      this.joyBase.style.top = `${y}px`;
      this.joyBase.classList.add('visible');
      this.joyKnob.style.transform = 'translate(0, 0)';
    }
  }

  _moveJoy(x, y) {
    if (!this._joy) return;
    let dx = x - this._joy.px;
    let dy = y - this._joy.py;
    const mag = Math.hypot(dx, dy);
    if (mag > JOY_MAX_RADIUS) {
      dx = (dx / mag) * JOY_MAX_RADIUS;
      dy = (dy / mag) * JOY_MAX_RADIUS;
    }
    this._joy.dx = dx;
    this._joy.dy = dy;
    if (this.joyKnob) this.joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;

    const nx = dx / JOY_MAX_RADIUS;
    const ny = dy / JOY_MAX_RADIUS;
    const active = mag > JOY_DEAD;
    this._setKey('KeyD', active && nx > AXIS_THRESHOLD);
    this._setKey('KeyA', active && nx < -AXIS_THRESHOLD);
    this._setKey('KeyS', active && ny > AXIS_THRESHOLD);
    this._setKey('KeyW', active && ny < -AXIS_THRESHOLD);
  }

  _endJoy() {
    this._joy = null;
    if (this.joyBase) this.joyBase.classList.remove('visible');
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) this.walk.onKeyUp(code);
  }

  _setKey(code, on) {
    const has = this.walk.keys.has(code);
    if (on && !has) this.walk.onKeyDown(code);
    else if (!on && has) this.walk.onKeyUp(code);
  }

  // --- layer input (joystick + look) ---

  _bindLayer() {
    const root = this.root;
    const down = (e) => {
      if (e.pointerType === 'mouse' || !this.enabled) return;
      if (e.target.closest('button')) return; // button handlers own these
      if (this._active.has(e.pointerId)) return;
      e.preventDefault();
      root.setPointerCapture?.(e.pointerId);
      const x = e.clientX;
      const y = e.clientY;
      if (!this._joy && x < this._joyBoundary()) {
        this._active.set(e.pointerId, { kind: 'joy', x, y });
        this._startJoy(x, y);
      } else {
        this._active.set(e.pointerId, { kind: 'look', x, y });
      }
    };
    const move = (e) => {
      const t = this._active.get(e.pointerId);
      if (!t || !this.enabled) return;
      e.preventDefault();
      if (t.kind === 'look') {
        this.walk.look((e.clientX - t.x) * this._lookMult, (e.clientY - t.y) * this._lookMult);
        t.x = e.clientX;
        t.y = e.clientY;
      } else {
        this._moveJoy(e.clientX, e.clientY);
      }
    };
    const end = (e) => {
      const t = this._active.get(e.pointerId);
      if (!t) return;
      this._active.delete(e.pointerId);
      if (t.kind === 'joy') this._endJoy();
    };
    root.addEventListener('pointerdown', down);
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    this._offLayer = () => {
      root.removeEventListener('pointerdown', down);
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', end);
      root.removeEventListener('pointercancel', end);
    };
  }

  // --- buttons ---

  _bindButton(id, onDown, onUp) {
    const el = this.doc.getElementById(id);
    if (!el) return;
    const down = (e) => {
      if (e.pointerType === 'mouse') return;
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      onDown?.(e);
    };
    const up = () => onUp?.();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    this._buttonCleanup.push(() => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    });
  }

  _bindButtons() {
    this._bindButton('btn-attack', () => { this.attacking = true; }, () => { this.attacking = false; });
    this._bindButton('btn-reload', () => this.cb.reload?.());
    this._bindButton('btn-pickup', () => this.cb.pickup?.());
    this._bindButton('btn-inject', () => this.cb.inject?.());
    this._bindButton('btn-pause', () => this.cb.pause?.());
    this._bindButton('btn-sprint', () => {
      this._sprint = !this._sprint;
      this._toggleClass('btn-sprint', 'on', this._sprint);
      this._setKey('ShiftLeft', this._sprint);
    });
    this._bindButton('btn-crouch', () => {
      this._crouch = !this._crouch;
      this._toggleClass('btn-crouch', 'on', this._crouch);
      this._setKey('KeyC', this._crouch);
    });
  }

  _bindSlots() {
    this._slotsWrap = this.doc.getElementById('slots-mobile');
    if (!this._slotsWrap) return;
    this._slotsWrap.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.dataset.index == null) return;
      e.preventDefault();
      this.cb.selectSlot?.(Number(btn.dataset.index));
    });
  }

  _toggleClass(id, cls, on) {
    const el = this.doc.getElementById(id);
    if (!el) return;
    el.classList.toggle(cls, on);
  }

  /** Highlight the equipment slot selected by the mobile slot bar. */
  setActiveSlot(i) {
    if (!this._slotsWrap) return;
    for (const b of this._slotsWrap.querySelectorAll('.slot-btn')) {
      b.classList.toggle('active', Number(b.dataset.index) === i);
    }
  }

  /** Hide the layer (e.g. while paused) and drop any held input. */
  setEnabled(on) {
    this.enabled = on;
    this.root?.classList.toggle('hidden', !on);
    if (!on) {
      this.attacking = false;
      this._endJoy();
      this._active.clear();
    } else {
      this._setKey('ShiftLeft', this._sprint);
      this._setKey('KeyC', this._crouch);
    }
  }

  dispose() {
    this._offLayer?.();
    for (const fn of this._buttonCleanup ?? []) fn();
  }
}
