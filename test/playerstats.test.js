import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PlayerStats,
  EQUIPMENT_SLOTS,
  MAX_HEALTH,
  MAX_ARMOR,
  INJECTION_HEAL,
} from '../src/game/PlayerStats.js';
import { weaponFor, FISTS } from '../src/game/weapons.js';
import { clearItems, registerItem } from '../src/engine/ItemRegistry.js';
import { registerEquipItem, clearEquipItems } from '../src/engine/EquipmentRegistry.js';

test('player starts with full health and zero armor', () => {
  const s = new PlayerStats();
  assert.equal(s.health, MAX_HEALTH);
  assert.equal(s.armor, 0, 'armor only comes from armor pickups');
  assert.deepEqual(EQUIPMENT_SLOTS, ['primary', 'secondary', 'extra', 'injection']);
});

test('damage is absorbed by armor first, then health', () => {
  const s = new PlayerStats({ health: 100, armor: 100 });
  const r = s.damage(10);
  // armor absorbs 60% of 10 = 6, health takes 4
  assert.equal(r.absorbed, 6);
  assert.equal(s.armor, 94);
  assert.equal(s.health, 96);
});

test('damage never drops health or armor below zero', () => {
  const s = new PlayerStats({ health: 20, armor: 5 });
  s.damage(100);
  assert.equal(s.health, 0);
  assert.equal(s.armor, 0);
  assert.equal(s.isDead, true);
});

test('heal and repair clamp to max', () => {
  const s = new PlayerStats({ health: 50, armor: 40 });
  s.heal(1000);
  s.repair(1000);
  assert.equal(s.health, MAX_HEALTH);
  assert.equal(s.armor, MAX_ARMOR);
});

test('equipment slots hold item ids and report the active hand', () => {
  const s = new PlayerStats({ equipment: { primary: 'sword', injection: 'medkit' } });
  assert.equal(s.equipment.primary, 'sword');
  assert.equal(s.activeSlotName, 'primary');
  assert.equal(s.activeItemId, 'sword');

  s.setActiveSlot(2); // extra
  assert.equal(s.activeSlotName, 'extra');
  assert.equal(s.activeItemId, null, 'empty extra slot means fists');

  s.equip('extra', 'axe');
  assert.equal(s.activeItemId, 'axe');
  s.unequip('extra');
  assert.equal(s.activeItemId, null);
});

test('injection heals and is consumed', () => {
  const s = new PlayerStats({ health: 50, armor: 100, equipment: { injection: 'medkit' } });
  assert.equal(s.useInjection(), true);
  assert.equal(s.health, 50 + INJECTION_HEAL);
  assert.equal(s.equipment.injection, null, 'injection consumed on use');
  assert.equal(s.useInjection(), false, 'no injection left');
});

test('serialize/deserialize round-trips the whole model', () => {
  const s = new PlayerStats({
    health: 73,
    armor: 41,
    equipment: { primary: 'a', secondary: 'b', extra: null, injection: 'i' },
    ammo: { pistol: 40, rifle: 8 },
  });
  s.setActiveSlot(1);
  s.addWear('primary');
  s.addWear('primary');
  const copy = PlayerStats.deserialize(s.serialize());
  assert.equal(copy.health, 73);
  assert.equal(copy.armor, 41);
  assert.deepEqual(copy.equipment, s.equipment);
  assert.equal(copy.activeSlot, 1);
  assert.deepEqual(copy.ammo, { pistol: 40, rifle: 8, shotgun: 0 }, 'ammo must round-trip');
  assert.deepEqual(copy.wear, { primary: 2, secondary: 0, extra: 0, injection: 0 }, 'weapon wear must round-trip');
});

test('weapon wear counts landed hits and resets when the item changes', () => {
  const s = new PlayerStats({ equipment: { primary: 'bat' } });
  assert.equal(s.wear.primary, 0, 'a fresh weapon has no wear');
  assert.equal(s.addWear('primary'), 1);
  assert.equal(s.addWear('primary'), 2);
  assert.equal(s.addWear('nope'), 0, 'unknown slots take no wear');

  s.equip('primary', 'bat');
  assert.equal(s.wear.primary, 2, 're-equipping the same item keeps its wear');

  s.equip('primary', 'knife');
  assert.equal(s.wear.primary, 0, 'a different item arrives fresh');

  s.addWear('primary');
  s.unequip('primary');
  assert.equal(s.wear.primary, 0, 'clearing the slot discards the wear');
});

test('repairWear zeroes a slot (the NPC repair service) and keeps the item', () => {
  const s = new PlayerStats({ equipment: { primary: 'bat' } });
  s.addWear('primary');
  s.addWear('primary');
  assert.equal(s.repairWear('primary'), true);
  assert.equal(s.wear.primary, 0, 'good as new');
  assert.equal(s.equipment.primary, 'bat', 'the weapon stays equipped');
  assert.equal(s.repairWear('nope'), false, 'unknown slots refuse');
});

test('deserialize drops wear for empty slots and invalid values', () => {
  const s = PlayerStats.deserialize({
    equipment: { primary: 'bat' },
    wear: { primary: 3, secondary: 5, extra: 'x', injection: -2 },
  });
  assert.deepEqual(s.wear, { primary: 3, secondary: 0, extra: 0, injection: 0 });
});

test('ammo inventory starts empty and clamps to the type max stack', () => {
  const s = new PlayerStats();
  assert.equal(s.ammo.pistol, 0, 'fresh game carries no ammo — packs provide it');
  assert.equal(s.ammo.shotgun, 0);

  s.addAmmo('pistol', 500);
  assert.equal(s.ammo.pistol, 120, 'pistol ammo caps at its 120 max stack');

  assert.equal(s.takeAmmo('pistol', 50), 50);
  assert.equal(s.ammo.pistol, 70);
  assert.equal(s.takeAmmo('pistol', 500), 70, 'take never goes below zero');
  assert.equal(s.takeAmmo('plasma', 5), 0, 'unknown ammo types cannot be taken');
});

test('deserialize clamps invalid ammo values', () => {
  const s = PlayerStats.deserialize({ ammo: { pistol: 9999, rifle: -5, plasma: 10 } });
  assert.equal(s.ammo.pistol, 120);
  assert.equal(s.ammo.rifle, 0);
  assert.equal(s.ammo.shotgun, 0, 'missing ammo falls back to zero');
});

test('deserialize tolerates missing/invalid data', () => {
  assert.ok(PlayerStats.deserialize(null) instanceof PlayerStats);
  const s = PlayerStats.deserialize({ health: 'x', equipment: null });
  assert.equal(s.health, MAX_HEALTH);
  assert.equal(s.armor, 0, 'missing/invalid armor falls back to zero');
});

test('weaponFor returns fists for an empty hand and a profile otherwise', () => {
  clearItems();
  assert.equal(weaponFor(null), FISTS);
  assert.equal(weaponFor(''), FISTS);
  registerItem({ id: 'sword', name: 'Sword', size: 'small', microVoxels: [], light: null });
  const w = weaponFor('sword');
  assert.equal(w.name, 'Sword');
  assert.ok(w.damage > 0);
  assert.ok(w.range > 0);
  assert.ok(w.cooldown > 0);
  clearItems();
});

test('weaponFor exposes durability for melee weapons only', () => {
  clearEquipItems();
  assert.equal(FISTS.durability, 0, 'fists never break');
  registerEquipItem({
    id: 'bat',
    name: 'Bat',
    kind: 'weapon',
    microVoxels: [],
    stats: { damage: 18, reach: 2.6, cooldown: 0.8, durability: 6 },
    weapon: { kind: 'melee' },
  });
  registerEquipItem({
    id: 'gun',
    name: 'Gun',
    kind: 'weapon',
    microVoxels: [],
    stats: { damage: 10, reach: 100, cooldown: 0.5, durability: 6 },
    weapon: { kind: 'ranged' },
  });
  assert.equal(weaponFor('bat').durability, 6, 'melee weapons carry their durability');
  assert.equal(weaponFor('gun').durability, 0, 'guns never wear');
  clearEquipItems();
});
