// ItemRegistry.js — registry of registered items (id -> ItemDef).
//
// Global mutable store mirroring VoxelTypes' BLOCKS registry, but populated at
// runtime from the F2 item editor / loaded item files. Pure (no three.js/DOM).

import { normalizeItemData } from './ItemTypes.js';

const REGISTRY = new Map();

/** Register (or overwrite) an item. Stores a normalized copy (any legacy
 *  'small'/'big' size migrates to cells) so callers can keep editing the
 *  working item without mutating the registered definition. */
export function registerItem(item) {
  if (!item || !item.id) return null;
  const copy = {
    id: item.id,
    name: typeof item.name === 'string' && item.name ? item.name : String(item.id),
    solid: item.solid !== false,
    ...normalizeItemData(item),
  };
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
    const item = registerItem(entry); // registerItem normalizes (incl. legacy sizes)
    if (item) out.push(item);
  }
  return out;
}
