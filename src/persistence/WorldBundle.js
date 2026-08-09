// WorldBundle.js — one file that packages a world together with its item
// registry, so a map and every object it uses ship together.
//
// On-disk format (versioned like the plain map):
//   { format: 'voxelbundle', version: 1,
//     map:   { ...voxelmap content... },
//     items: [ ...ItemDefs... ],
//     equip: [ ...EquipDefs... ],
//     npcs:  [ ...NpcDefs... ],          // additive
//     quests: { giverId: [tiers...] } }  // additive
//
// Loading a bundle registers its items, equippable items, NPCs and quests
// first (so placed items and NPC spawns resolve), then deserializes the map.
// Pure apart from the registry side effects, which matches how
// WorldSerializer already treats the registry.

import { World } from '../engine/World.js';
import { serialize, deserialize } from './WorldSerializer.js';
import { serializeRegistry, deserializeRegistry } from '../engine/ItemRegistry.js';
import { serializeEquipRegistry, deserializeEquipRegistry } from '../engine/EquipmentRegistry.js';
import { serializeNpcRegistry, deserializeNpcRegistry } from '../engine/NpcRegistry.js';
import { serializeQuestRegistry, deserializeQuestRegistry } from '../engine/QuestRegistry.js';

export const BUNDLE_FORMAT = 'voxelbundle';
export const BUNDLE_VERSION = 1;

/** @returns {string} JSON text of the world + its full item + equipment registries. */
export function serializeBundle(world) {
  return JSON.stringify(
    {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      map: JSON.parse(serialize(world)),
      items: JSON.parse(serializeRegistry()),
      equip: JSON.parse(serializeEquipRegistry()),
      npcs: JSON.parse(serializeNpcRegistry()),
      quests: JSON.parse(serializeQuestRegistry()),
    },
    null,
    2,
  );
}

/** @returns {{world: World, errors: string[], itemCount: number, fatal: boolean}}
 *  `fatal` carries the same meaning as in deserialize(): unreadable file vs
 *  per-entry skips around a world that is otherwise fine. */
export function deserializeBundle(text) {
  const errors = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { world: new World(), errors: [`Invalid JSON: ${e.message}`], itemCount: 0, fatal: true };
  }
  if (!data || data.format !== BUNDLE_FORMAT) {
    return { world: new World(), errors: ['Not a voxelbundle file'], itemCount: 0, fatal: true };
  }
  if (!data.map || typeof data.map !== 'object') {
    return { world: new World(), errors: [...errors, 'Bundle has no map'], itemCount: 0, fatal: true };
  }
  const items = Array.isArray(data.items) ? deserializeRegistry(JSON.stringify(data.items)) : [];
  if (Array.isArray(data.equip)) deserializeEquipRegistry(JSON.stringify(data.equip));
  // Old bundles carry no npcs/quests fields — the built-in registries stand.
  if (Array.isArray(data.npcs)) deserializeNpcRegistry(JSON.stringify(data.npcs));
  if (data.quests && typeof data.quests === 'object') deserializeQuestRegistry(JSON.stringify(data.quests));
  const { world, errors: mapErrors, fatal } = deserialize(JSON.stringify(data.map));
  return { world, errors: [...errors, ...mapErrors], itemCount: items.length, fatal: !!fatal };
}
