// LegacySaves.js — one-time import of v1 localStorage save slots.
//
// v1 slots (SaveSlots.js) stored a full WorldBundle — registries included —
// as a ~5 MB JSON string per slot, which blew localStorage's quota at one
// slot. The world is static (v3 saves carry no world data), so the import
// keeps only the player state and drops the bundle entirely; any objects the
// player had picked up respawn once. The localStorage key is removed,
// freeing the quota for good.

import { SLOT_COUNT, readSlot, slotKey } from '../game/SaveSlots.js';
import { makeSave, manualSlotKey } from './SaveStore.js';

/**
 * @param {Storage|null} storage  localStorage (or a test stub)
 * @param {object} store  an open SaveStore
 * @returns {Promise<number>} how many slots were imported
 */
export async function importLegacySlots(storage, store) {
  if (!storage) return 0;
  let imported = 0;
  for (let i = 0; i < SLOT_COUNT; i++) {
    const slot = readSlot(i, storage);
    if (!slot) continue;
    if (await store.readMeta(manualSlotKey(i))) {
      // The store already has a newer save for this slot — the stale legacy
      // copy only wastes quota.
      storage.removeItem(slotKey(i));
      continue;
    }
    try {
      const payload = makeSave({
        pickedUp: [],
        player: slot.player ?? null,
        stats: slot.stats ?? null,
        quests: slot.quests ?? null,
        flags: slot.flags ?? null,
        containers: slot.containers ?? null,
      });
      payload.savedAt = slot.savedAt ?? payload.savedAt;
      await store.write(manualSlotKey(i), payload, { savedAt: payload.savedAt });
      storage.removeItem(slotKey(i));
      imported++;
    } catch (e) {
      // Leave the legacy slot untouched; a future run (or bug fix) can retry.
      console.warn(`Legacy save slot ${i} import failed:`, e);
    }
  }
  return imported;
}
