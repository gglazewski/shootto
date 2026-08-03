// Input.js — single owner of all input listeners.
//
// Previously keydown/up, mousemove, wheel and mousedown were spread across
// main.js and FlyControls. This dispatcher:
//   - maintains the set of currently held key codes (isDown()),
//   - forwards raw keydown/keyup so FlyControls keeps its movement keys,
//   - emits semantic actions from the Keybindings table,
//   - emits mousemove/wheel/mousedown/mouseup for tools and HUD.

import { resolveBinding } from './Keybindings.js';

export class InputDispatcher {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.domElement  the canvas (pointer target)
   * @param {Document} [deps.doc]
   */
  constructor({ domElement, doc = document }) {
    this.domElement = domElement;
    this.doc = doc;
    this.held = new Set();
    this._handlers = new Map(); // action -> Set<fn>
    this._bound = {
      keydown: (e) => this._onKeyDown(e),
      keyup: (e) => this._onKeyUp(e),
      mousemove: (e) => this._emit('mousemove', { dx: e.movementX, dy: e.movementY, x: e.clientX, y: e.clientY }),
      wheel: (e) => {
        e.preventDefault();
        this._emit('wheel', { deltaY: e.deltaY });
      },
      mousedown: (e) => this._emit('mousedown', { button: e.button, x: e.clientX, y: e.clientY }),
      mouseup: (e) => this._emit('mouseup', { button: e.button, x: e.clientX, y: e.clientY }),
      contextmenu: (e) => e.preventDefault(),
    };
  }

  connect() {
    const d = this.doc;
    d.addEventListener('keydown', this._bound.keydown);
    d.addEventListener('keyup', this._bound.keyup);
    d.addEventListener('mousemove', this._bound.mousemove);
    this.domElement.addEventListener('wheel', this._bound.wheel, { passive: false });
    this.domElement.addEventListener('mousedown', this._bound.mousedown);
    this.domElement.addEventListener('mouseup', this._bound.mouseup);
    this.domElement.addEventListener('contextmenu', this._bound.contextmenu);
  }

  disconnect() {
    const d = this.doc;
    d.removeEventListener('keydown', this._bound.keydown);
    d.removeEventListener('keyup', this._bound.keyup);
    d.removeEventListener('mousemove', this._bound.mousemove);
    this.domElement.removeEventListener('wheel', this._bound.wheel);
    this.domElement.removeEventListener('mousedown', this._bound.mousedown);
    this.domElement.removeEventListener('mouseup', this._bound.mouseup);
    this.domElement.removeEventListener('contextmenu', this._bound.contextmenu);
  }

  isDown(code) {
    return this.held.has(code);
  }

  /** @param {string} action @param {(payload:object) => void} fn @returns {() => void} */
  on(action, fn) {
    if (!this._handlers.has(action)) this._handlers.set(action, new Set());
    this._handlers.get(action).add(fn);
    return () => this._handlers.get(action)?.delete(fn);
  }

  _emit(action, payload) {
    const set = this._handlers.get(action);
    if (!set) return;
    for (const fn of [...set]) fn(payload ?? {});
  }

  _onKeyDown(e) {
    this.held.add(e.code);
    this._emit('keydown', { code: e.code, event: e });

    const resolved = resolveBinding(e);
    if (resolved) {
      if (resolved.spec.preventDefault) e.preventDefault();
      this._emit(resolved.action, { code: e.code, event: e });
    }
  }

  _onKeyUp(e) {
    this.held.delete(e.code);
    this._emit('keyup', { code: e.code, event: e });
  }
}
