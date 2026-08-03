// ItemRegistry.js — registry of registered items (id -> ItemDef).
//
// Global mutable store mirroring VoxelTypes' BLOCKS registry, but populated at
// runtime from the F2 item editor / loaded item files. Pure (no three.js/DOM).

import { ITEM_WORLD_SIZE } from './ItemTypes.js';

const REGISTRY = new Map();

/** Register (or overwrite) an item. Stores a copy so callers can keep editing
 *  the working item without mutating the registered definition. */
export function registerItem(item) {
  if (!item || !item.id) return null;
  const copy = structuredClone(item);
  REGISTRY.set(copy.id, copy);
  return copy;
}

/** @returns {ItemDef|null} the registered item or null */
export function getItem(id) {
  return REGISTRY.get(id) ?? null;
}

export function isItemId(id) {
  return REGISTRY.has(id);
}

/** Remove an item from the registry. @returns {boolean} true when removed */
export function removeItem(id) {
  return REGISTRY.delete(id);
}

/** @returns {ItemDef[]} all registered items, in insertion order */
export function listItems() {
  return [...REGISTRY.values()];
}

export function clearItems() {
  REGISTRY.clear();
}

/** Persist the whole registry as JSON text (localStorage / files). */
export function serializeRegistry() {
  return JSON.stringify(listItems());
}

/** Load registry entries from JSON text (array of ItemDefs). @returns {ItemDef[]} */
export function deserializeRegistry(text) {
  const out = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return out;
  }
  if (!Array.isArray(data)) return out;
  for (const entry of data) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) continue;
    const microVoxels = (Array.isArray(entry.microVoxels) ? entry.microVoxels : [])
      .filter(
        (v) =>
          v && Number.isInteger(v.x) && Number.isInteger(v.y) && Number.isInteger(v.z) &&
          Array.isArray(v.color) && v.color.length >= 3,
      )
      .map((v) => ({ x: v.x, y: v.y, z: v.z, color: [v.color[0], v.color[1], v.color[2]] }));
    const light =
      entry.light && Array.isArray(entry.light.color) && entry.light.color.length >= 3
        ? {
            x: Math.floor(entry.light.x),
            y: Math.floor(entry.light.y),
            z: Math.floor(entry.light.z),
            color: [entry.light.color[0], entry.light.color[1], entry.light.color[2]],
            strength: typeof entry.light.strength === 'number' ? Math.min(7.5, Math.max(0.5, entry.light.strength)) : 3,
          }
        : null;
    const item = {
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
      size: entry.size in ITEM_WORLD_SIZE ? entry.size : 'small',
      solid: entry.solid !== false,
      microVoxels,
      light,
    };
    registerItem(item);
    out.push(item);
  }
  return out;
}
