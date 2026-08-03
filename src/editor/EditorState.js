// EditorState.js — central observable editor state.
//
// Holds the selection (block id + voxel size) and, later, anything else that
// multiple UI surfaces react to. Components subscribe instead of being poked
// by hand from a wiring function.

export class EditorState {
  constructor(initial = {}) {
    this._state = { ...initial };
    this._listeners = new Set();
  }

  get(field) {
    return this._state[field];
  }

  get all() {
    return { ...this._state };
  }

  set(field, value) {
    const prev = this._state[field];
    if (Object.is(prev, value)) return;
    this._state[field] = value;
    for (const fn of [...this._listeners]) fn({ field, value, prev, state: this });
  }

  /** @param {(change: {field:string, value:unknown, prev:unknown, state:EditorState}) => void} fn */
  on(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
}
