// QuestItems.js — built-in quest items (fetch-quest objectives).
//
// Quest items are equip-registry entries with kind 'quest': they place in the
// world like any other equippable item, but the game only lets the player
// pick one up while an ACTIVE quest's collect objective wants it (see
// QuestLog.wantsItem), and picking it up grants nothing visible — no hotbar
// slot, no ammo — it just advances the quest.
//
// Built-ins registered here always exist, so the built-in questlines that
// reference them (the granny's teapot) work out of the box. They register
// BEFORE the author's saved registry loads, so an author who re-skins one
// under the same id wins. Pure module (no three.js/DOM).

import { registerEquipItem } from './EquipmentRegistry.js';

/** Granny's favorite teapot: a hand-built cream porcelain pot with a blue
 *  lid, spout and looped handle, in the default 8³ build volume. */
function teapotVoxels() {
  const cream = [235, 226, 205];
  const blue = [86, 118, 190];
  const out = [];
  const put = (x, y, z, color) => out.push({ x, y, z, color: [...color] });

  // Body: a plump rounded pot, y1..y3, centered on (3.5, z 3.5).
  for (let y = 1; y <= 3; y++) {
    for (let x = 2; x <= 5; x++) {
      for (let z = 2; z <= 5; z++) {
        const corner = (x === 2 || x === 5) && (z === 2 || z === 5);
        if (corner && y !== 2) continue; // taper top + bottom, bulge in the middle
        // A sprinkle of blue floral pattern on the belly.
        const floral = y === 2 && ((x + z) % 3 === 0) && !corner;
        put(x, y, z, floral ? blue : cream);
      }
    }
  }
  // Base ring.
  for (let x = 3; x <= 4; x++) for (let z = 3; z <= 4; z++) put(x, 0, z, cream);
  // Lid + knob.
  for (let x = 3; x <= 4; x++) for (let z = 3; z <= 4; z++) put(x, 4, z, blue);
  put(3, 5, 3, blue);
  // Spout: pokes out the +z side, rising.
  put(3, 2, 6, blue);
  put(3, 3, 6, cream);
  put(3, 4, 7, blue);
  // Handle: a loop on the -z side.
  put(3, 3, 1, blue);
  put(3, 2, 0, blue);
  put(3, 1, 1, blue);
  return out;
}

export const BUILTIN_QUEST_ITEMS = Object.freeze([
  Object.freeze({
    id: 'granny-teapot',
    name: 'Granny’s Teapot',
    kind: 'quest',
    // Built-ins are code, not authored content: serializeEquipRegistry skips
    // them, so they never masquerade as the author's saved equippable items.
    // An author's re-skin under the same id has no flag and persists normally.
    builtin: true,
    grid: [8, 8, 8],
    microVoxels: teapotVoxels(),
    grip: null,
    grip2: null,
    yaw: 0,
  }),
]);

/** Register every built-in quest item (idempotent). Call before loading the
 *  author's saved equip registry so authored overrides win. */
export function registerBuiltinQuestItems() {
  for (const def of BUILTIN_QUEST_ITEMS) registerEquipItem(def);
}
