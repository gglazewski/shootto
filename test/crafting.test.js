// crafting.test.js — recipes, craftable items and consumable healing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerBuiltinMaterials, MATERIAL_IDS,
} from '../src/engine/Materials.js';
import {
  registerBuiltinCraftables, BUILTIN_CRAFTABLES,
} from '../src/engine/Craftables.js';
import {
  registerBuiltinRecipes, BUILTIN_RECIPES, listRecipes, getRecipe,
  registerRecipe, clearRecipes, normalizeRecipe, craftPlan, applyCraft,
  selfCraftDecay, recipeAvailable, serializeRecipeRegistry,
  deserializeRecipeRegistry, CRAFT_CATEGORIES, SELF_CRAFT_DECAY_FRACTION,
} from '../src/engine/Crafting.js';
import {
  registerEquipItem, getEquipItem, clearEquipItems, normalizeKind,
} from '../src/engine/EquipmentRegistry.js';
import { PlayerStats } from '../src/game/PlayerStats.js';
import { weaponFor } from '../src/game/weapons.js';

function registerAll() {
  clearEquipItems();
  clearRecipes();
  registerBuiltinMaterials();
  registerBuiltinCraftables();
  registerBuiltinRecipes();
}

test('built-in craftables register with art and their kinds survive', () => {
  registerAll();
  for (const def of BUILTIN_CRAFTABLES) {
    const stored = getEquipItem(def.id);
    assert.ok(stored, `${def.id} is registered`);
    assert.equal(stored.kind, def.kind, `${def.id} keeps its kind`);
    assert.ok(stored.microVoxels.length > 0, `${def.id} has voxel art`);
    const [gx, gy, gz] = stored.grid;
    for (const v of stored.microVoxels) {
      assert.ok(v.x >= 0 && v.x < gx && v.y >= 0 && v.y < gy && v.z >= 0 && v.z < gz,
        `${def.id} voxel in bounds`);
    }
  }
  clearEquipItems();
  clearRecipes();
});

test('consumables normalize: kind kept, damage pinned to 0, heal pack valid', () => {
  registerEquipItem({
    id: 'test-tonic', name: 'Tonic', kind: 'consumable',
    grid: [8, 8, 8], microVoxels: [{ x: 0, y: 0, z: 0, color: [1, 2, 3] }],
    consumable: { health: 55, armor: 5 },
  });
  const def = getEquipItem('test-tonic');
  assert.equal(normalizeKind('consumable'), 'consumable');
  assert.equal(def.kind, 'consumable');
  assert.equal(def.stats.damage, 0, 'consumables never deal damage');
  assert.deepEqual(def.consumable, { health: 55, armor: 5 });
  // A pack with no effects falls back to the default heal.
  registerEquipItem({
    id: 'test-dud', name: 'Dud', kind: 'consumable',
    grid: [8, 8, 8], microVoxels: [], consumable: {},
  });
  assert.ok(getEquipItem('test-dud').consumable.health > 0);
  // Non-consumables keep an inert zero pack.
  registerEquipItem({
    id: 'test-bat', name: 'Bat', kind: 'weapon',
    grid: [8, 8, 8], microVoxels: [], consumable: { health: 90 },
  });
  assert.deepEqual(getEquipItem('test-bat').consumable, { health: 0, armor: 0 });
  clearEquipItems();
});

test('built-in recipes reference registered items and valid materials', () => {
  registerAll();
  for (const recipe of BUILTIN_RECIPES) {
    const stored = getRecipe(recipe.id);
    assert.ok(stored, `${recipe.id} is registered`);
    assert.ok(getEquipItem(recipe.output.id), `${recipe.id} output exists`);
    assert.ok(CRAFT_CATEGORIES.some((c) => c.id === stored.category), 'category valid');
    for (const input of stored.inputs) {
      assert.ok(MATERIAL_IDS.includes(input.id), `${recipe.id} input ${input.id} is a material`);
    }
  }
  // Every category and both stations are represented.
  const cats = new Set(listRecipes().map((r) => r.category));
  for (const c of CRAFT_CATEGORIES) assert.ok(cats.has(c.id), `category ${c.id} used`);
  const stations = new Set(listRecipes().map((r) => r.station));
  assert.ok(stations.has('field') && stations.has('npc'));
  clearEquipItems();
  clearRecipes();
});

test('craftPlan reports what is missing; applyCraft consumes materials', () => {
  registerAll();
  const recipe = getRecipe('plank-club'); // 3 scrap-wood + 1 duck-tape
  const stats = new PlayerStats();
  let plan = craftPlan(recipe, stats);
  assert.equal(plan.ok, false);
  assert.equal(plan.missing.length, 2);

  stats.addMaterial('scrap-wood', 3);
  plan = craftPlan(recipe, stats);
  assert.equal(plan.ok, false);
  assert.equal(plan.missing.length, 1);
  assert.equal(plan.missing[0].id, 'duck-tape');

  stats.addMaterial('duck-tape', 1);
  plan = craftPlan(recipe, stats);
  assert.equal(plan.ok, true);
  const taken = applyCraft(recipe, stats);
  assert.ok(taken, 'craft consumes');
  assert.equal(stats.materialCount('scrap-wood'), 0);
  assert.equal(stats.materialCount('duck-tape'), 0);
  // Not affordable twice.
  assert.equal(applyCraft(recipe, stats), null);
  clearEquipItems();
  clearRecipes();
});

test('recipeAvailable gates npc recipes to the bench', () => {
  clearRecipes();
  registerBuiltinRecipes();
  const bench = getRecipe('rebar-spear');
  const field = getRecipe('bandage');
  assert.equal(bench.station, 'npc');
  assert.equal(recipeAvailable(bench, false), false);
  assert.equal(recipeAvailable(bench, true), true);
  assert.equal(field.station, 'field');
  assert.equal(recipeAvailable(field, false), true);
  clearRecipes();
});

test('self-crafted weapons decay; bench weapons and non-weapons do not', () => {
  registerAll();
  const shiv = getEquipItem('shiv');
  const spear = getEquipItem('rebar-spear');
  const vest = getEquipItem('scrap-vest');
  const bandage = getEquipItem('bandage');
  const expect = (def) => Math.max(1, Math.ceil(def.stats.durability * SELF_CRAFT_DECAY_FRACTION));
  assert.equal(selfCraftDecay(shiv), expect(shiv));
  assert.equal(selfCraftDecay(spear), expect(spear));
  assert.equal(selfCraftDecay(vest), 0, 'armor never decays');
  assert.equal(selfCraftDecay(bandage), 0, 'consumables never decay');
  assert.equal(selfCraftDecay(null), 0);
  // The penalty always leaves the weapon usable.
  for (const def of [shiv, spear]) {
    assert.ok(selfCraftDecay(def) < def.stats.durability);
  }
  clearEquipItems();
  clearRecipes();
});

test('recipe registry round-trips through serialize/deserialize', () => {
  clearRecipes();
  registerBuiltinRecipes();
  const custom = registerRecipe({
    id: 'custom-club', name: 'Club', category: 'weapon', station: 'field',
    desc: 'A test.',
    inputs: [{ id: 'scrap-wood', count: 2 }],
    output: { id: 'plank-club', count: 1 },
  });
  assert.ok(custom);
  const text = serializeRecipeRegistry();
  const saved = JSON.parse(text);
  assert.ok(saved.some((r) => r.id === 'custom-club'), 'authored recipe persists');
  assert.ok(!saved.some((r) => r.builtin === true && r.id === 'bandage'), 'built-ins are skipped');
  clearRecipes();
  const loaded = deserializeRecipeRegistry(text);
  assert.ok(loaded.some((r) => r.id === 'custom-club'));
  assert.equal(getRecipe('custom-club').name, 'Club');
  // Bad input leaves the registry alone.
  assert.deepEqual(deserializeRecipeRegistry('{nope'), []);
  assert.ok(getRecipe('custom-club'));
  clearRecipes();
});

test('normalizeRecipe rejects junk and clamps counts', () => {
  assert.equal(normalizeRecipe(null), null);
  assert.equal(normalizeRecipe({ id: 'Bad Id!' }), null);
  assert.equal(normalizeRecipe({ id: 'ok', inputs: [], output: { id: 'x' } }), null);
  assert.equal(normalizeRecipe({ id: 'ok', inputs: [{ id: 'rag' }], output: null }), null);
  const r = normalizeRecipe({
    id: 'ok', inputs: [{ id: 'rag', count: 500 }, { id: 'nope', count: 0 }],
    output: { id: 'bandage', count: -3 },
  });
  assert.equal(r.inputs.length, 2, 'a zero count still means "one of it"');
  assert.equal(r.inputs[0].count, 99, 'counts clamp to 99');
  assert.equal(r.inputs[1].count, 1, 'counts clamp up to 1');
  assert.equal(r.output.count, 1);
  assert.equal(r.station, 'field', 'unknown station defaults to field');
});

test('consumables fight as fists and use their heal pack via the injection slot', () => {
  registerAll();
  const w = weaponFor('bandage');
  assert.equal(w.kind, 'melee');
  assert.equal(w.durability, 0, 'swinging a bandage never breaks anything');
  assert.ok(w.damage <= 5, 'no better than fists');

  const stats = new PlayerStats({ health: 30 });
  stats.equip('injection', 'first-aid');
  assert.equal(stats.useInjection(getEquipItem('first-aid').consumable), true);
  assert.equal(stats.health, 90, 'heals the pack amount, not the default 40');
  assert.equal(stats.equipment.injection, null, 'consumed');

  // Armor-granting consumable pack.
  registerEquipItem({
    id: 'test-patch', name: 'Patch', kind: 'consumable',
    grid: [8, 8, 8], microVoxels: [], consumable: { health: 0, armor: 20 },
  });
  const s2 = new PlayerStats({ health: 100 });
  s2.equip('injection', 'test-patch');
  assert.equal(s2.useInjection(getEquipItem('test-patch').consumable), true);
  assert.equal(s2.health, 100, 'no over-heal');
  assert.equal(s2.armor, 20);
  clearEquipItems();
  clearRecipes();
});

test('crafted melee weapons keep their authored combat stats', () => {
  registerAll();
  const spear = weaponFor('rebar-spear');
  assert.equal(spear.kind, 'melee');
  assert.equal(spear.damage, 24);
  assert.equal(spear.anim, 'stab');
  assert.equal(spear.durability, 60);
  const shiv = weaponFor('shiv');
  assert.equal(shiv.damage, 12);
  assert.equal(shiv.cooldown, 0.25);
  clearEquipItems();
  clearRecipes();
});
