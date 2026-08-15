// SaveSlots.js — three save-game slots for the playable game.
//
// Each slot stores a full snapshot: the world + its item registry (as a
// WorldBundle) plus the player's position/orientation, so loading a slot
// restores exactly the state that was saved — independent of later edits to
// the editor's map. Storage is injected (localStorage in the browser, a stub
// in tests) so this module stays pure and testable.

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
 *  serialized QuestLog, `flags` the serialized GameFlags (older saves
 *  without either load with a fresh log/store). */
export function makeSlot({ bundle, player, stats, quests = null, flags = null }) {
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt: Date.now(),
    bundle,
    player,
    stats,
    quests,
    flags,
  };
}
