// ToolRegistry.js — holds tools and tracks the active one.
//
// The active tool receives mouse/update lifecycle calls from the App. Tools
// are plain objects implementing the Tool interface (see Tool.js).

export class ToolRegistry {
  constructor() {
    /** @type {Map<string, import('./Tool.js').Tool>} */
    this._tools = new Map();
    this._active = null;
  }

  register(tool) {
    this._tools.set(tool.id, tool);
    return tool;
  }

  get(id) {
    return this._tools.get(id);
  }

  list() {
    return [...this._tools.values()];
  }

  /** Activate a tool by id; deactivates the previous one. @returns {object|null} */
  activate(id) {
    const tool = this._tools.get(id);
    if (!tool) return null;
    if (this._active && this._active !== tool) this._active.onDeactivate();
    this._active = tool;
    tool.onActivate();
    return tool;
  }

  get active() {
    return this._active;
  }

  /** Cycle to the next registered tool. @returns {object} the new active tool */
  cycle() {
    const ids = this.list().map((t) => t.id);
    const i = ids.indexOf(this._active?.id);
    return this.activate(ids[(i + 1) % ids.length]);
  }
}
