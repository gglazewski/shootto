// weapons.js — attack profiles for the playable game.
//
// The player attacks with the item in the selected equipment slot; with an
// empty slot they fight barehanded (fists). Each attack has a damage value,
// a reach (in cells) and a cooldown (seconds). Equippable items from the F3
// editor carry their own composable weapon profile (kind / hands / muzzle /
// animation / recoil); other item ids fall back to a generic melee profile.

import { getItem } from '../engine/ItemRegistry.js';
import { getEquipItem } from '../engine/EquipmentRegistry.js';
import { CELL_SIZE } from '../engine/Space.js';

export const FISTS = Object.freeze({
  id: 'fists',
  name: 'Fists',
  damage: 5,
  range: 4, // cells (2.0 m)
  cooldown: 0.45,
  kind: 'melee',
  hands: 'one',
  anim: 'punch',
  recoil: 0,
  muzzle: null,
  magazine: 0,
  ammo: '',
  reload: 0, // fists cannot reload
});

/** Weapon profile for an equipped item (equipment profile when available). */
export function weaponFor(itemId) {
  if (!itemId) return FISTS;
  const item = getItem(itemId) ?? getEquipItem(itemId);
  if (item?.stats) {
    const w = item.weapon ?? {};
    return {
      id: itemId,
      name: item?.name ?? itemId,
      damage: item.stats.damage,
      range: Math.max(1, Math.round(item.stats.reach / CELL_SIZE)),
      cooldown: item.stats.cooldown,
      kind: w.kind === 'ranged' ? 'ranged' : 'melee',
      hands: w.hands === 'two' ? 'two' : 'one',
      anim: ['punch', 'slash', 'stab', 'gun'].includes(w.anim) ? w.anim : 'punch',
      recoil: w.recoil ?? 0.05,
      muzzle: w.muzzle ?? null,
      magazine: w.magazine ?? 0,
      ammo: w.ammo ?? '',
      reload: typeof w.reload === 'number' ? Math.max(0.2, Math.min(10, w.reload)) : 1.4,
    };
  }
  return {
    id: itemId,
    name: item?.name ?? itemId,
    damage: 12,
    range: 5, // cells (2.5 m)
    cooldown: 0.3,
    kind: 'melee',
    hands: 'one',
    anim: 'punch',
    recoil: 0.05,
    muzzle: null,
    magazine: 0,
    ammo: '',
    reload: 1.4,
  };
}

/** True when an item id maps to something attackable. */
export function isWeapon(itemId) {
  return !!itemId;
}
