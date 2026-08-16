// ContainerStore.js — persistent contents of storage containers.
//
// A storage container is a placed object authored with `storage: true` (see
// ObjectModal / World.placeItem). Its contents are runtime game state, not
// map data: keyed by the placement's anchor ("x,y,z"), serialized into save
// slots next to the player stats. Each container mirrors the player model —
// stackable materials by id plus a list of item entries carrying their
// wear/decay, so a weapon stashed in a cupboard keeps its condition.
// No three.js/DOM, so it can be unit tested in Node.

const sanitizeEntry = (e) => {
  const src = typeof e === 'string' ? { id: e } : e;
  if (!src || typeof src !== 'object' || typeof src.id !== 'string' || !src.id) return null;
  return {
    id: src.id,
    wear: Number.isFinite(Number(src.wear)) ? Math.max(0, Math.round(Number(src.wear))) : 0,
    decay: Number.isFinite(Number(src.decay)) ? Math.max(0, Math.round(Number(src.decay))) : 0,
  };
};

export class ContainerStore {
  constructor() {
    /** @type {Map<string, {materials: Record<string, number>, items: {id:string, wear:number, decay:number}[]}>} */
    this._map = new Map();
  }

  /** Contents for a container anchor key, created empty on first open. */
  open(key) {
    let c = this._map.get(key);
    if (!c) {
      c = { materials: {}, items: [] };
      this._map.set(key, c);
    }
    return c;
  }

  /** Add materials to a container. @returns {number} the new count */
  addMaterial(key, id, amount = 1) {
    const c = this.open(key);
    if (!id || !(amount > 0)) return c.materials[id] ?? 0;
    c.materials[id] = (c.materials[id] ?? 0) + Math.round(amount);
    return c.materials[id];
  }

  /** Take materials out (never below 0; drops the key at 0).
   *  @returns {number} amount actually taken */
  takeMaterial(key, id, amount) {
    const c = this.open(key);
    const have = c.materials[id] ?? 0;
    const taken = Math.min(Math.max(0, Math.round(amount)), have);
    if (taken >= have) delete c.materials[id];
    else if (taken > 0) c.materials[id] = have - taken;
    return taken;
  }

  /** Stash an item entry (condition rides along). @returns {boolean} */
  stow(key, itemId, wear = 0, decay = 0) {
    if (!itemId) return false;
    this.open(key).items.push({ id: itemId, wear, decay });
    return true;
  }

  /** Take the item entry at an index out of a container.
   *  @returns {{id:string, wear:number, decay:number}|null} */
  take(key, index) {
    const c = this.open(key);
    if (index < 0 || index >= c.items.length) return null;
    return c.items.splice(index, 1)[0];
  }

  /** @returns {object} plain data for save slots — empty containers dropped */
  serialize() {
    const out = {};
    for (const [key, c] of this._map) {
      const materials = Object.fromEntries(Object.entries(c.materials).filter(([, n]) => n > 0));
      if (!Object.keys(materials).length && !c.items.length) continue;
      out[key] = { materials, items: c.items.map((e) => ({ ...e })) };
    }
    return out;
  }

  /** @returns {ContainerStore} tolerant of missing/legacy/malformed data */
  static deserialize(data) {
    const store = new ContainerStore();
    if (!data || typeof data !== 'object') return store;
    for (const [key, c] of Object.entries(data)) {
      if (!c || typeof c !== 'object') continue;
      const container = store.open(key);
      if (c.materials && typeof c.materials === 'object') {
        for (const [id, count] of Object.entries(c.materials)) {
          const n = Math.round(Number(count));
          if (typeof id === 'string' && id && Number.isFinite(n) && n > 0) container.materials[id] = n;
        }
      }
      if (Array.isArray(c.items)) {
        container.items.push(...c.items.map(sanitizeEntry).filter(Boolean));
      }
    }
    return store;
  }
}
