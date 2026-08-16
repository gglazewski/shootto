// weapons.js — attack profiles for the playable game.
//
// The player attacks with the item in the selected equipment slot; with an
// empty slot they fight barehanded (fists). Each attack has a damage value,
// a reach (in cells) and a cooldown (seconds). Equippable items from the F3
// editor carry their own composable weapon profile (kind / hands / muzzle /
// animation / recoil); other item ids fall back to a generic melee profile.

import { getItem } from '../engine/ItemRegistry.js';
import { getEquipItem, RANGED_SPREAD, DEFAULT_EQUIP_STATS } from '../engine/EquipmentRegistry.js';
import { CELL_SIZE } from '../engine/Space.js';

// Stopping power: a ranged hit staggers its target (Mob.takeDamage's impact).
// Damage above this threshold also knocks the mob back at KNOCKBACK_PER_DAMAGE
// m/s per point, so a pistol gives a shove while a heavy gun launches.
const KNOCKBACK_THRESHOLD = 15;
const KNOCKBACK_PER_DAMAGE = 0.22;
const knockbackFor = (damage) => Math.max(0, (damage - KNOCKBACK_THRESHOLD) * KNOCKBACK_PER_DAMAGE);

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
  spread: 0, // radians of aim wobble (melee swings are exact)
  pellets: 1, // projectiles per attack (shotguns fire several)
  knockback: 0, // melee only flinches, never stops or shoves a mob
  durability: 0, // landed hits before breaking (0 = unbreakable — fists never wear)
});

/** Weapon profile for an equipped item (equipment profile when available).
 *  Consumables (bandages, kits) never fight — they read as fists. */
export function weaponFor(itemId) {
  if (!itemId) return FISTS;
  const item = getItem(itemId) ?? getEquipItem(itemId);
  if (item?.kind === 'consumable') return { ...FISTS, id: itemId, name: item.name ?? itemId };
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
      // Ranged weapons wobble by default; melee stays exact.
      spread: w.spread ?? (w.kind === 'ranged' ? RANGED_SPREAD : 0),
      // Projectiles per shot — stats.damage applies per pellet.
      pellets: Math.max(1, Math.round(w.pellets ?? 1)),
      // Only guns stop/shove mobs — derived from damage so stopping power
      // grows with the punch.
      knockback: w.kind === 'ranged' ? knockbackFor(item.stats.damage) : 0,
      // Melee weapons wear out: this many landed hits on mobs before the
      // weapon breaks (0 = unbreakable). Guns never wear.
      durability:
        w.kind === 'ranged'
          ? 0
          : Math.max(0, Math.round(item.stats.durability ?? DEFAULT_EQUIP_STATS.durability)),
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
    spread: 0,
    pellets: 1,
    knockback: 0,
    // Improvised weapons (plain world items swung as clubs) are frail.
    durability: 10,
  };
}

/** True when an item id maps to something attackable. */
export function isWeapon(itemId) {
  return !!itemId;
}
