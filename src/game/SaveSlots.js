// SaveSlots.js — LEGACY v1 save slots (localStorage + embedded WorldBundle).
//
// Kept as a reader forever so old saves keep loading: LegacySaves.js imports
// v1 slots into the SaveStore (IndexedDB, player state only) on startup.
// Do not write new saves through this module — the game saves via
// persistence/SaveStore.js. Storage is injected (localStorage in the
// browser, a stub in tests) so this module stays pure and testable.

export const SLOT_COUNT = 3;
export const SAVE_FORMAT = 'voxelsave';
export const SAVE_VERSION = 1;

export function slotKey(i) {
  return `voxelgame.save.${i}`;
}

/** @returns {object|null} the slot payload, or null when empty/corrupt */
export function readSlot(i, storage) {
  if (!storage) return null;
  const text = storage.getItem(slotKey(i));
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @returns {boolean} true when written */
export function writeSlot(i, data, storage) {
  if (!storage) return false;
  storage.setItem(slotKey(i), JSON.stringify(data));
  return true;
}

/** @returns {boolean} true when the slot has a readable save */
export function hasSlot(i, storage) {
  return readSlot(i, storage) !== null;
}

/** @returns {(object|null)[]} all slots, in order (null = empty) */
export function listSlots(storage) {
  return Array.from({ length: SLOT_COUNT }, (_, i) => readSlot(i, storage));
}

/** Build a fresh slot payload from a bundle + player state. `quests` is the
 *  serialized QuestLog, `flags` the serialized GameFlags, `containers` the
 *  serialized ContainerStore (older saves without any of them load with a
 *  fresh log/store/empty stashes). */
export function makeSlot({ bundle, player, stats, quests = null, flags = null, containers = null }) {
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt: Date.now(),
    bundle,
    player,
    stats,
    quests,
    flags,
    containers,
  };
}
