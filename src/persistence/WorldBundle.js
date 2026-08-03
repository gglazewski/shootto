// WorldBundle.js — one file that packages a world together with its item
// registry, so a map and every object it uses ship together.
//
// On-disk format (versioned like the plain map):
//   { format: 'voxelbundle', version: 1,
//     map:   { ...voxelmap content... },
//     items: [ ...ItemDefs... ],
//     equip: [ ...EquipDefs... ] }
//
// Loading a bundle registers its items and equippable items first (so placed
// items resolve), then deserializes the map. Pure apart from the registry
// side effect, which matches how WorldSerializer already treats the registry.

import { World } from '../engine/World.js';
import { serialize, deserialize } from './WorldSerializer.js';
import { serializeRegistry, deserializeRegistry } from '../engine/ItemRegistry.js';
import { serializeEquipRegistry, deserializeEquipRegistry } from '../engine/EquipmentRegistry.js';

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
    },
    null,
    2,
  );
}

/** @returns {{world: World, errors: string[], itemCount: number}} */
export function deserializeBundle(text) {
  const errors = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { world: new World(), errors: [`Invalid JSON: ${e.message}`], itemCount: 0 };
  }
  if (!data || data.format !== BUNDLE_FORMAT) {
    return { world: new World(), errors: ['Not a voxelbundle file'], itemCount: 0 };
  }
  if (!data.map || typeof data.map !== 'object') {
    return { world: new World(), errors: [...errors, 'Bundle has no map'], itemCount: 0 };
  }
  const items = Array.isArray(data.items) ? deserializeRegistry(JSON.stringify(data.items)) : [];
  if (Array.isArray(data.equip)) deserializeEquipRegistry(JSON.stringify(data.equip));
  const { world, errors: mapErrors } = deserialize(JSON.stringify(data.map));
  return { world, errors: [...errors, ...mapErrors], itemCount: items.length };
}
