// materials.test.js — built-in repair materials (drops that fuel weapon repair).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerBuiltinMaterials, BUILTIN_MATERIALS, MATERIAL_IDS, isMaterialId,
  ADHESIVE_IDS, SCRAP_IDS, REPAIR_COST, REPAIR_DECAY_FRACTION,
} from '../src/engine/Materials.js';
import {
  getEquipItem, clearEquipItems, serializeEquipRegistry,
} from '../src/engine/EquipmentRegistry.js';

test('built-in materials register with kind material and survive normalizeKind', () => {
  clearEquipItems();
  registerBuiltinMaterials();
  assert.equal(MATERIAL_IDS.length, 6);
  for (const id of ['duck-tape', 'glue', 'scrap-wood', 'scrap-glass', 'scrap-metal', 'rag']) {
    const def = getEquipItem(id);
    assert.ok(def, `${id} is registered`);
    assert.equal(def.kind, 'material', `${id} keeps its material kind`);
    assert.ok(def.microVoxels.length > 0, `${id} has voxel art`);
    assert.ok(isMaterialId(id));
  }
  assert.equal(isMaterialId('bat'), false);
  clearEquipItems();
});

test('material art stays inside the 8³ build volume', () => {
  for (const def of BUILTIN_MATERIALS) {
    for (const v of def.microVoxels) {
      for (const axis of ['x', 'y', 'z']) {
        assert.ok(v[axis] >= 0 && v[axis] < 8, `${def.id} voxel in bounds on ${axis}`);
      }
    }
  }
});

test('built-in materials never serialize as authored content', () => {
  clearEquipItems();
  registerBuiltinMaterials();
  const saved = JSON.parse(serializeEquipRegistry());
  assert.deepEqual(saved, [], 'built-ins are skipped entirely');
  clearEquipItems();
});

test('the repair cost is coverable by the defined materials', () => {
  assert.ok(REPAIR_COST.adhesive > 0 && REPAIR_COST.scrap > 0);
  assert.ok(REPAIR_DECAY_FRACTION > 0 && REPAIR_DECAY_FRACTION <= 1);
  for (const id of [...ADHESIVE_IDS, ...SCRAP_IDS]) {
    assert.ok(MATERIAL_IDS.includes(id), `${id} names a built-in material`);
  }
});
