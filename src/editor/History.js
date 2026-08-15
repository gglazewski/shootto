// History.js — undo/redo stack with a bounded depth.
//
// Commands are plain { description, do(), undo() } objects. Pushing a new
// command clears the redo branch; when the stack exceeds the cap the oldest
// action is dropped (no redo for it).

export class History {
  constructor({ max = 10, onChange = null } = {}) {
    this.max = max;
    this.onChange = onChange;
    this._undo = [];
    this._redo = [];
  }

  get length() {
    return this._undo.length;
  }

  get canUndo() {
    return this._undo.length > 0;
  }

  get canRedo() {
    return this._redo.length > 0;
  }

  /**
   * Execute nothing here — the caller runs cmd.do() and pushes on success.
   * @param {{do:Function, undo:Function, description?:string}} cmd
   */
  push(cmd) {
    if (this._undo.length >= this.max) this._undo.shift();
    this._undo.push(cmd);
    this._redo.length = 0;
    this.onChange?.();
  }

  /** Undo the most recent action. @returns {object|null} the undone command */
  undo() {
    const cmd = this._undo.pop();
    if (!cmd) return null;
    cmd.undo();
    this._redo.push(cmd);
    this.onChange?.();
    return cmd;
  }

  /** Redo the most recently undone action. @returns {object|null} the redone command */
  redo() {
    const cmd = this._redo.pop();
    if (!cmd) return null;
    cmd.do();
    this._undo.push(cmd);
    this.onChange?.();
    return cmd;
  }

  clear() {
    this._undo.length = 0;
    this._redo.length = 0;
  }
}
