import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyEquipItem,
  normalizeStats,
  normalizeWeapon,
  normalizeAmmo,
  registerEquipItem,
  getEquipItem,
  isEquipId,
  listEquipItems,
  clearEquipItems,
  removeEquipItem,
  serializeEquipRegistry,
  deserializeEquipRegistry,
  serializeEquipItem,
  deserializeEquipItem,
  EQUIP_FORMAT,
  DEFAULT_EQUIP_STATS,
  DEFAULT_WEAPON,
  DEFAULT_ARMOR_PACK,
  normalizeKind,
  normalizeArmorPack,
  ATTACK_ANIMS,
} from '../src/engine/EquipmentRegistry.js';
import {
  listAmmoTypes,
} from '../src/engine/AmmoTypes.js';
import { World } from '../src/engine/World.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';

// --- equippable item data model ---

test('empty equippable item has defaults and no grip', () => {
  const item = emptyEquipItem('Club');
  assert.equal(item.name, 'Club');
  assert.equal(item.id, null);
  assert.deepEqual(item.microVoxels, []);
  assert.equal(item.grip, null);
  assert.equal(item.grip2, null);
  assert.equal(item.yaw, 0);
  assert.deepEqual(item.stats, DEFAULT_EQUIP_STATS);
});

test('normalizeStats clamps out-of-range weapon stats', () => {
  // Reach is in meters and may go up to sniper range (1000 m).
  assert.deepEqual(normalizeStats({ damage: 5, reach: 99, cooldown: 0 }), { damage: 5, reach: 99, cooldown: 0.1 });
  assert.deepEqual(normalizeStats({ damage: 500, reach: 0.1, cooldown: 20 }), { damage: 100, reach: 0.5, cooldown: 3 });
  assert.deepEqual(normalizeStats({ reach: 1000 }), { ...DEFAULT_EQUIP_STATS, reach: 1000 });
  assert.equal(normalizeStats({ reach: 9999 }).reach, 1000, 'reach must clamp at 1000 m');
  assert.deepEqual(normalizeStats({}), DEFAULT_EQUIP_STATS);
});

test('normalizeWeapon builds a canonical composable profile', () => {
  assert.deepEqual(normalizeWeapon(undefined), DEFAULT_WEAPON);
  assert.deepEqual(normalizeWeapon({}), DEFAULT_WEAPON);
  assert.deepEqual(
    normalizeWeapon({ kind: 'ranged', hands: 'two', muzzle: { x: 3, y: 4, z: 7 }, anim: 'gun', recoil: 0.12, magazine: 30, ammo: 'rifle' }),
    { kind: 'ranged', hands: 'two', orientation: 'horizontal', muzzle: { x: 3, y: 4, z: 7 }, anim: 'gun', recoil: 0.12, magazine: 30, ammo: 'rifle', reload: 1.4, spread: 0.02, pellets: 1 },
  );
  // invalid anims fall back per kind; muzzle is validated as integer cells.
  assert.equal(normalizeWeapon({ kind: 'ranged', anim: 'slash' }).anim, 'gun');
  assert.equal(normalizeWeapon({ kind: 'melee', anim: 'gun' }).anim, 'punch');
  assert.equal(normalizeWeapon({ kind: 'melee', anim: 'slash' }).anim, 'slash');
  assert.equal(normalizeWeapon({ muzzle: { x: 1.5, y: 0, z: 0 } }).muzzle, null);
  assert.equal(normalizeWeapon({ recoil: 99 }).recoil, 0.3);
  assert.equal(normalizeWeapon({ magazine: 9999 }).magazine, 500, 'magazine clamps at 500');
  assert.equal(normalizeWeapon({ magazine: -2 }).magazine, 0);
  assert.equal(normalizeWeapon({ ammo: 'pistol' }).ammo, 'pistol');
  assert.equal(normalizeWeapon({ ammo: 'plasma' }).ammo, '', 'unknown ammo types are dropped');
  assert.equal(normalizeWeapon({ reload: 99 }).reload, 10, 'reload clamps at 10 s');
  assert.equal(normalizeWeapon({ reload: 0.05 }).reload, 0.2, 'reload clamps at 0.2 s');
  assert.equal(normalizeWeapon({ reload: 2.5 }).reload, 2.5, 'a custom reload time survives');
  assert.equal(normalizeWeapon({ kind: 'ranged' }).spread, 0.02, 'ranged weapons get default spread');
  assert.equal(normalizeWeapon({ kind: 'melee' }).spread, 0, 'melee weapons have no spread');
  assert.equal(normalizeWeapon({ kind: 'ranged', spread: 0.5 }).spread, 0.2, 'spread clamps at 0.2 rad');
  assert.equal(normalizeWeapon({ kind: 'ranged', spread: 0 }).spread, 0, 'spread can be set to zero');
  assert.equal(normalizeWeapon({}).pellets, 1, 'default is a single projectile');
  assert.equal(normalizeWeapon({ kind: 'ranged', pellets: 6 }).pellets, 6, 'shotgun pellet count survives');
  assert.equal(normalizeWeapon({ pellets: 99 }).pellets, 20, 'pellets clamp at 20');
  assert.equal(normalizeWeapon({ pellets: 0 }).pellets, 1, 'at least one projectile');
  assert.equal(normalizeWeapon({ pellets: 2.7 }).pellets, 3, 'pellet counts are whole numbers');
  assert.equal(normalizeWeapon({}).orientation, 'horizontal', 'weapons point forward by default');
  assert.equal(normalizeWeapon({ kind: 'melee', orientation: 'vertical' }).orientation, 'vertical', 'melee weapons can stand upright');
  assert.equal(normalizeWeapon({ kind: 'ranged', orientation: 'vertical' }).orientation, 'horizontal', 'guns always point forward');
  assert.equal(normalizeWeapon({ orientation: 'sideways' }).orientation, 'horizontal', 'unknown orientations fall back');
  assert.deepEqual(ATTACK_ANIMS.ranged, ['gun']);
});

// --- registry store ---

test('register/get/list/remove round-trip an equippable item', () => {
  clearEquipItems();
  const club = emptyEquipItem('Club');
  club.id = 'club';
  club.microVoxels = [{ x: 0, y: 0, z: 0, color: [180, 110, 60] }];
  club.grip = { x: 0, y: 0, z: 0 };
  club.yaw = 90;
  club.stats = { damage: 22, reach: 2.5, cooldown: 0.4 };

  registerEquipItem(club);
  assert.equal(isEquipId('club'), true);
  assert.equal(getEquipItem('club').name, 'Club');
  assert.deepEqual(getEquipItem('club').grip, { x: 0, y: 0, z: 0 });
  assert.equal(getEquipItem('club').yaw, 90);
  assert.equal(listEquipItems().length, 1);

  assert.equal(removeEquipItem('club'), true);
  assert.equal(isEquipId('club'), false);
  assert.equal(listEquipItems().length, 0);
});

test('registerItem normalizes a fresh copy (caller can keep mutating)', () => {
  clearEquipItems();
  const item = emptyEquipItem('Stick');
  item.id = 'stick';
  item.yaw = 999; // out of range
  registerEquipItem(item);
  assert.equal(getEquipItem('stick').yaw, 360, 'yaw must be clamped on register');
  item.name = 'Changed after register';
  assert.equal(getEquipItem('stick').name, 'Stick', 'registry must hold a copy');
});

// --- serialization ---

test('single item serialize/deserialize round-trips grip, yaw and stats', () => {
  const item = emptyEquipItem('Hammer');
  item.id = 'hammer';
  item.microVoxels = [
    { x: 1, y: 1, z: 1, color: [120, 90, 60] },
    { x: 1, y: 2, z: 1, color: [200, 200, 200] },
  ];
  item.grip = { x: 1, y: 1, z: 1 };
  item.grip2 = { x: 1, y: 2, z: 1 };
  item.yaw = 270;
  item.stats = { damage: 34, reach: 1.5, cooldown: 0.6 };
  item.weapon = { kind: 'ranged', hands: 'one', orientation: 'horizontal', muzzle: { x: 3, y: 4, z: 5 }, anim: 'gun', recoil: 0.1, magazine: 12, ammo: 'pistol', reload: 0.8, spread: 0.02, pellets: 6 };

  const text = serializeEquipItem(item);
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, EQUIP_FORMAT);

  const { item: back, errors } = deserializeEquipItem(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(back.grip, item.grip);
  assert.deepEqual(back.grip2, item.grip2, 'left-hand grip must round-trip');
  assert.equal(back.yaw, item.yaw);
  assert.deepEqual(back.stats, item.stats);
  assert.deepEqual(back.weapon, item.weapon);
  assert.deepEqual(back.microVoxels, item.microVoxels);
});

test('deserializeEquipItem rejects non-equipment files', () => {
  assert.deepEqual(deserializeEquipItem('not json').errors[0].includes('Invalid'), true);
  const { item } = deserializeEquipItem(JSON.stringify({ format: 'voxelitem', id: 'x' }));
  assert.equal(item, null);
});

test('registry serialize/deserialize reloads saved equipment', () => {
  clearEquipItems();
  registerEquipItem({ ...emptyEquipItem('Club'), id: 'club', grip: { x: 2, y: 2, z: 2 } });
  registerEquipItem({ ...emptyEquipItem('Shiv'), id: 'shiv', stats: { damage: 18, reach: 1.2, cooldown: 0.5 } });

  const text = serializeEquipRegistry();
  clearEquipItems();
  assert.equal(listEquipItems().length, 0);

  const loaded = deserializeEquipRegistry(text);
  assert.equal(loaded.length, 2);
  assert.deepEqual(getEquipItem('club').grip, { x: 2, y: 2, z: 2 });
  assert.equal(getEquipItem('shiv').stats.damage, 18);
});

test('deserializeEquipRegistry drops malformed entries', () => {
  const good = { id: 'ok', name: 'Ok', microVoxels: [{ x: 0, y: 0, z: 0, color: [1, 2, 3] }], grip: null, yaw: 0, stats: {} };
  const bad = { id: '', name: 'No id' };
  const noId = { name: 'No id' };
  clearEquipItems();
  deserializeEquipRegistry(JSON.stringify([good, bad, noId, null, 'x']));
  assert.deepEqual(listEquipItems().map((i) => i.id), ['ok']);
});

// --- ammo-kind items (packs) ---

test('ammo packs store the type they grant and the amount per pickup', () => {
  clearEquipItems();
  const pack = emptyEquipItem('Pistol Ammo Pack');
  pack.id = 'pistol_pack';
  pack.kind = 'ammo';
  pack.ammo = { type: 'pistol', amount: 6 };
  registerEquipItem(pack);

  assert.equal(getEquipItem('pistol_pack').kind, 'ammo');
  assert.deepEqual(getEquipItem('pistol_pack').ammo, { type: 'pistol', amount: 6 });

  // Packs reference existing ammo types; they do not add new ones.
  assert.deepEqual(listAmmoTypes().map((t) => t.id), ['pistol', 'rifle', 'shotgun']);
  clearEquipItems();
});

test('normalizeAmmo keeps a known type and clamps the amount', () => {
  assert.deepEqual(normalizeAmmo({ type: 'shotgun', amount: 12 }), { type: 'shotgun', amount: 12 });
  assert.deepEqual(normalizeAmmo({ type: 'plasma', amount: 50 }), { type: '', amount: 0 }, 'unknown ammo types are dropped');
  assert.deepEqual(normalizeAmmo({ type: 'pistol', amount: -3 }), { type: 'pistol', amount: 1 });
  assert.deepEqual(normalizeAmmo({ type: 'pistol', amount: 99999 }), { type: 'pistol', amount: 9999 });
  assert.deepEqual(normalizeAmmo({ type: 'pistol' }), { type: 'pistol', amount: 6 }, 'missing amount falls back to 6');
  assert.deepEqual(normalizeAmmo({}), { type: '', amount: 0 });
});

test('ammo packs serialize type + amount and reload cleanly', () => {
  clearEquipItems();
  const pack = { ...emptyEquipItem('Shotgun Shells'), id: 'shells', kind: 'ammo', ammo: { type: 'shotgun', amount: 8 } };

  const parsed = JSON.parse(serializeEquipItem(pack));
  assert.equal(parsed.kind, 'ammo');
  assert.deepEqual(parsed.ammo, { type: 'shotgun', amount: 8 });

  const { item: back } = deserializeEquipItem(serializeEquipItem(pack));
  assert.deepEqual(back.ammo, { type: 'shotgun', amount: 8 });

  clearEquipItems();
  const loaded = deserializeEquipRegistry(JSON.stringify([pack]));
  assert.deepEqual(loaded[0].ammo, { type: 'shotgun', amount: 8 });
  clearEquipItems();
});

// --- map serialization keeps placed equippable items ---

test('a placed equippable item survives map serialize/deserialize', () => {
  clearEquipItems();
  registerEquipItem({ ...emptyEquipItem('Pistol'), id: 'pistol', grip: { x: 3, y: 3, z: 4 }, yaw: 90 });

  const world = new World();
  world.place('grass', 'big', 0, 0, 0);
  world.placeItem('pistol', 'small', 0, 2, 0);

  const { world: loaded, errors } = deserialize(serialize(world));
  assert.deepEqual(errors, [], 'map with a placed equippable item must load cleanly');
  const placed = [];
  loaded.forEachItem((it) => placed.push(it.itemId));
  assert.deepEqual(placed, ['pistol'], 'equippable item must not be skipped on load');
});

test('map deserialize drops items from neither registry', () => {
  clearEquipItems();
  const { world, errors } = deserialize(JSON.stringify({
    format: 'voxelmap', version: 1, cellSize: 0.5, spawn: null, blocks: [],
    items: [{ itemId: 'ghost', x: 0, y: 2, z: 0, size: 'small', rotation: 0 }],
  }));
  let count = 0;
  world.forEachItem(() => count++);
  assert.equal(count, 0, 'unknown item ids are still skipped');
  assert.equal(errors.length, 1, 'the skip is reported as a warning');
});

// --- armor items ---

test('armor kind normalizes and survives serialize round-trips', () => {
  assert.equal(normalizeKind('armor'), 'armor');
  assert.equal(normalizeKind('junk'), 'weapon');
  assert.deepEqual(normalizeArmorPack({}), { amount: DEFAULT_ARMOR_PACK.amount });
  assert.deepEqual(normalizeArmorPack({ amount: 999 }), { amount: 100 });
  assert.deepEqual(normalizeArmorPack({ amount: 0.4 }), { amount: 1 });

  clearEquipItems();
  const vest = { ...emptyEquipItem('Vest'), id: 'vest', kind: 'armor', armor: { amount: 40 } };
  registerEquipItem(vest);
  assert.equal(getEquipItem('vest').kind, 'armor');
  assert.equal(getEquipItem('vest').armor.amount, 40);

  // single-file round-trip
  const { item, errors } = deserializeEquipItem(serializeEquipItem(getEquipItem('vest')));
  assert.deepEqual(errors, []);
  assert.equal(item.kind, 'armor');
  assert.equal(item.armor.amount, 40);

  // registry round-trip
  const text = serializeEquipRegistry();
  clearEquipItems();
  deserializeEquipRegistry(text);
  assert.equal(getEquipItem('vest').armor.amount, 40);
});

test('empty items carry a default armor pack', () => {
  assert.deepEqual(emptyEquipItem().armor, { amount: DEFAULT_ARMOR_PACK.amount });
});
