import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import {
  emptyItem,
  serializeItem,
  deserializeItem,
  MICRO_SIZE,
  cellsOf,
  gridOf,
  footprintCells,
  normalizeCells,
  quarterTurns,
  lightLevelForMeters,
  rotateMicroPoint,
  ITEM_PALETTE,
  LIGHT_COLORS,
  ITEM_FORMAT,
} from '../src/engine/ItemTypes.js';
import {
  registerItem,
  getItem,
  isItemId,
  listItems,
  clearItems,
  removeItem,
  serializeRegistry,
  deserializeRegistry,
} from '../src/engine/ItemRegistry.js';
import { buildItemGeometry } from '../src/engine/ItemMeshBuilder.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';
import { collisionWorld } from '../src/editor/itemPick.js';
import { registerEquipItem, clearEquipItems, emptyEquipItem } from '../src/engine/EquipmentRegistry.js';
import { collides } from '../src/engine/Physics.js';

// --- item data model ---

test('micro voxels have a uniform world size; footprints derive their grids', () => {
  assert.equal(MICRO_SIZE, 0.5 / 8);
  assert.deepEqual(gridOf({ cells: [1, 1, 1] }), [8, 8, 8]);
  assert.deepEqual(gridOf({ cells: [2, 4, 1] }), [16, 32, 8]);
  assert.deepEqual(gridOf({ grid: [8, 8, 16] }), [8, 8, 16], 'equipment defs keep their explicit grid');
});

test('footprint specs coerce: cells arrays, legacy strings, clamping', () => {
  assert.deepEqual(footprintCells('small'), [1, 1, 1]);
  assert.deepEqual(footprintCells('big'), [2, 2, 2]);
  assert.deepEqual(footprintCells(null), [1, 1, 1]);
  assert.deepEqual(footprintCells([2, 4, 1]), [2, 4, 1]);
  assert.deepEqual(normalizeCells([0, 99, 2.4]), [1, 8, 2], 'clamped to 1..8 and rounded');
});

test('light strength in meters maps to block-light levels', () => {
  assert.equal(lightLevelForMeters(0.5), 1);
  assert.equal(lightLevelForMeters(3), 6);
  assert.equal(lightLevelForMeters(7.5), 15);
  assert.equal(lightLevelForMeters(100), 15); // clamped
  assert.equal(lightLevelForMeters(0), 0); // clamped low
});

test('emptyItem builds a blank model', () => {
  const it = emptyItem('Lamp');
  assert.equal(it.name, 'Lamp');
  assert.deepEqual(it.cells, [1, 1, 1]);
  assert.equal(it.solid, true, 'new items are blocking by default');
  assert.deepEqual(it.microVoxels, []);
  assert.equal(it.light, null);
});

test('item serialization round-trips micro voxels, light and solidity', () => {
  const item = {
    id: 'lamp',
    name: 'Lamp',
    cells: [2, 4, 1],
    solid: false,
    microVoxels: [
      { x: 0, y: 0, z: 0, color: [220, 40, 30] },
      { x: 15, y: 31, z: 7, color: [40, 90, 200] },
    ],
    light: { x: 1, y: 2, z: 3, color: [255, 224, 178], strength: 4.5 },
  };
  const { item: out, errors } = deserializeItem(serializeItem(item));
  assert.deepEqual(errors, []);
  assert.equal(out.id, 'lamp');
  assert.deepEqual(out.cells, [2, 4, 1]);
  assert.equal(out.solid, false);
  assert.deepEqual(out.microVoxels, item.microVoxels);
  assert.deepEqual(out.light, item.light);
  assert.equal(JSON.parse(serializeItem(item)).format, ITEM_FORMAT);
});

test('items without a solid flag load as blocking', () => {
  const { item } = deserializeItem(JSON.stringify({ format: ITEM_FORMAT, name: 'M', size: 'big' }));
  assert.equal(item.solid, true);
  assert.deepEqual(item.cells, [2, 2, 2], 'legacy big maps to a 2×2×2 footprint');
  assert.equal(JSON.parse(serializeItem({ ...item, id: 'm' })).solid, true);
});

test('legacy v1 items migrate losslessly to cells', () => {
  const { item: small } = deserializeItem(JSON.stringify({
    format: ITEM_FORMAT, name: 'S', size: 'small',
    microVoxels: [{ x: 7, y: 0, z: 3, color: [1, 2, 3] }],
  }));
  assert.deepEqual(small.cells, [1, 1, 1]);
  assert.deepEqual(small.microVoxels, [{ x: 7, y: 0, z: 3, color: [1, 2, 3] }], 'small voxels are untouched');

  const { item: big } = deserializeItem(JSON.stringify({
    format: ITEM_FORMAT, name: 'B', size: 'big',
    microVoxels: [{ x: 7, y: 7, z: 7, color: [9, 9, 9] }],
    light: { x: 3, y: 4, z: 5, color: [255, 200, 100], strength: 2 },
  }));
  assert.deepEqual(big.cells, [2, 2, 2]);
  assert.equal(big.microVoxels.length, 8, 'each big voxel upscales to a 2×2×2 block');
  const keys = big.microVoxels.map((v) => `${v.x},${v.y},${v.z}`).sort();
  assert.deepEqual(keys, ['14,14,14', '14,14,15', '14,15,14', '14,15,15', '15,14,14', '15,14,15', '15,15,14', '15,15,15']);
  assert.deepEqual(big.light, { x: 6, y: 8, z: 10, color: [255, 200, 100], strength: 2 }, 'light position doubles');
});

test('voxels outside the build volume are dropped on load', () => {
  const { item } = deserializeItem(JSON.stringify({
    format: ITEM_FORMAT, name: 'C', cells: [1, 2, 1],
    microVoxels: [{ x: 0, y: 15, z: 0, color: [1, 1, 1] }, { x: 0, y: 16, z: 0, color: [1, 1, 1] }, { x: 8, y: 0, z: 0, color: [1, 1, 1] }],
  }));
  assert.deepEqual(item.microVoxels, [{ x: 0, y: 15, z: 0, color: [1, 1, 1] }]);
});

test('item deserialization tolerates malformed entries', () => {
  const { item } = deserializeItem(
    JSON.stringify({
      format: ITEM_FORMAT,
      name: 'M',
      microVoxels: [{ x: 'bad', y: 0, z: 0, color: [1, 2, 3] }, { x: 1, y: 1, z: 1 }],
      light: { x: 0, y: 0, z: 0, color: 'nope' },
    }),
  );
  assert.deepEqual(item.microVoxels, []); // bad voxels dropped
  assert.equal(item.light, null); // bad light dropped
});

test('item deserialization rejects non-voxelitem files', () => {
  const { item, errors } = deserializeItem('{"format":"voxelmap"}');
  assert.equal(item, null);
  assert.ok(errors.length > 0);
});

test('palette and light color lists have a reasonable size', () => {
  assert.ok(ITEM_PALETTE.length >= 16, `palette has ${ITEM_PALETTE.length} colors`);
  assert.ok(LIGHT_COLORS.length >= 4, `light colors have ${LIGHT_COLORS.length}`);
});

test('rotateMicroPoint spins a cell 90° around the grid centre', () => {
  // Grid centre is (4,4); a 90° yaw maps (x,z) -> (8-z, x).
  assert.deepEqual(rotateMicroPoint(2, 3, Math.PI / 2), [5, 2]);
  assert.deepEqual(rotateMicroPoint(5, 3, Math.PI / 2), [5, 5]);
  // 180° mirrors through the centre.
  assert.deepEqual(rotateMicroPoint(2, 3, Math.PI), [6, 5]);
  // 0° is the identity.
  assert.deepEqual(rotateMicroPoint(2, 3, 0), [2, 3]);
  // Rotating by 90° four times lands back on the start.
  let [x, z] = [2, 3];
  for (let i = 0; i < 4; i++) [x, z] = rotateMicroPoint(x, z, Math.PI / 2);
  assert.deepEqual([x, z], [2, 3]);
});

// --- item registry ---

test('registry registers, looks up and lists items', () => {
  clearItems();
  registerItem({ id: 'a', name: 'A', size: 'small', microVoxels: [{ x: 0, y: 0, z: 0, color: [1, 1, 1] }], light: null });
  registerItem({ id: 'b', name: 'B', size: 'big', microVoxels: [], light: null });
  assert.equal(isItemId('a'), true);
  assert.equal(getItem('b').name, 'B');
  assert.deepEqual(listItems().map((i) => i.id).sort(), ['a', 'b']);
  clearItems();
  assert.equal(listItems().length, 0);
});

test('registry registration copies so later edits do not leak in', () => {
  clearItems();
  const working = { id: 'w', name: 'W', size: 'small', microVoxels: [{ x: 0, y: 0, z: 0, color: [1, 1, 1] }], light: null };
  registerItem(working);
  working.microVoxels[0].color = [9, 9, 9];
  assert.deepEqual(getItem('w').microVoxels[0].color, [1, 1, 1]);
  clearItems();
});

test('registry serializes and reloads (legacy sizes migrate on register)', () => {
  clearItems();
  registerItem({ id: 'x', name: 'X', size: 'big', microVoxels: [{ x: 2, y: 2, z: 2, color: [5, 6, 7] }], light: { x: 1, y: 1, z: 1, color: [8, 9, 10], strength: 2 } });
  assert.deepEqual(getItem('x').cells, [2, 2, 2], 'legacy big migrates at registration');
  assert.equal(getItem('x').microVoxels.length, 8);
  assert.deepEqual(getItem('x').light, { x: 2, y: 2, z: 2, color: [8, 9, 10], strength: 2 });
  const text = serializeRegistry();
  clearItems();
  const loaded = deserializeRegistry(text);
  assert.equal(loaded.length, 1);
  assert.equal(getItem('x').name, 'X');
  assert.equal(getItem('x').microVoxels.length, 8, 'migration is idempotent across reloads');
  assert.deepEqual(getItem('x').light, { x: 2, y: 2, z: 2, color: [8, 9, 10], strength: 2 });
  clearItems();
});

test('registry removes items by id', () => {
  clearItems();
  registerItem({ id: 'a', name: 'A', size: 'small', microVoxels: [], light: null });
  registerItem({ id: 'b', name: 'B', size: 'small', microVoxels: [], light: null });
  assert.equal(removeItem('a'), true);
  assert.equal(removeItem('missing'), false);
  assert.equal(isItemId('a'), false);
  assert.deepEqual(listItems().map((i) => i.id), ['b']);
  clearItems();
});

// --- item mesh builder ---

test('single micro voxel builds 6 faces', () => {
  const d = buildItemGeometry([{ x: 0, y: 0, z: 0, color: [255, 0, 0] }]);
  assert.equal(d.positions.length / 3, 24); // 6 faces * 4 verts
  assert.equal(d.indices.length, 36); // 6 faces * 2 tris * 3
  assert.equal(d.colors.length, 72);
});

test('interior faces between adjacent micro voxels are culled', () => {
  const d = buildItemGeometry([
    { x: 0, y: 0, z: 0, color: [255, 0, 0] },
    { x: 1, y: 0, z: 0, color: [0, 255, 0] },
  ]);
  assert.equal(d.positions.length / 3, 40); // 10 exposed faces
});

test('item geometry bakes per-face brightness into colors', () => {
  const d = buildItemGeometry([{ x: 0, y: 0, z: 0, color: [255, 255, 255] }]);
  // top face (normal +y) is brightest = 1.0
  let top = null;
  for (let i = 0; i < d.normals.length / 3; i++) {
    if (d.normals[i * 3 + 1] > 0.9) {
      top = d.colors[i * 3];
      break;
    }
  }
  assert.equal(top, 1.0);
});

// --- world item placement ---

function makeItemWorld() {
  const world = new World();
  registerItem({ id: 'lamp', name: 'Lamp', size: 'small', microVoxels: [{ x: 0, y: 0, z: 0, color: [10, 20, 30] }], light: { x: 0, y: 0, z: 0, color: [255, 200, 100], strength: 3 } });
  return world;
}

test('world places and removes items, resolving any footprint cell', () => {
  const world = makeItemWorld();
  assert.equal(world.placeItem('lamp', SIZE.SMALL, 5, 3, 5, Math.PI / 2), true);
  assert.ok(world.itemAt(5, 3, 5));
  assert.equal(world.itemAt(5, 3, 5).rotation, Math.PI / 2, 'placement keeps the yaw');
  assert.equal(world.count, 0, 'items are not voxels');
  let itemsSeen = 0;
  world.forEachItem(() => itemsSeen++);
  assert.equal(itemsSeen, 1);
  const removed = world.removeItemAt(5, 3, 5);
  assert.equal(removed.itemId, 'lamp');
  assert.equal(world.itemAt(5, 3, 5), null);
});

test('placeItem defaults the yaw to 0', () => {
  const world = makeItemWorld();
  world.placeItem('lamp', SIZE.SMALL, 5, 3, 5);
  assert.equal(world.itemAt(5, 3, 5).rotation, 0);
});

test('items occupy space: blocks cannot be placed where an item is', () => {
  const world = makeItemWorld();
  world.placeItem('lamp', SIZE.SMALL, 5, 3, 5);
  assert.equal(world.isAreaFree(5, 3, 5, SIZE.SMALL), false);
  assert.equal(world.place('grass', SIZE.SMALL, 5, 3, 5), false);
  assert.equal(world.get(5, 3, 5), null);
  world.place('grass', SIZE.SMALL, 5, 3, 6); // free neighbour works
  assert.ok(world.get(5, 3, 6));
});

test('big items occupy a 2x2x2 footprint and reject overlaps', () => {
  const world = makeItemWorld();
  assert.equal(world.placeItem('lamp', SIZE.BIG, 10, 0, 10), true);
  assert.ok(world.itemAt(11, 1, 11), 'sub-cell resolves to the item');
  assert.equal(world.placeItem('lamp', SIZE.SMALL, 11, 0, 10), false, 'overlaps big footprint');
  assert.equal(world.place('grass', SIZE.SMALL, 11, 1, 11), false);
});

test('cells footprints occupy their w×h×d cells and store the span', () => {
  const world = makeItemWorld();
  assert.equal(world.placeItem('lamp', [2, 4, 1], 10, 0, 10), true);
  assert.deepEqual(world.itemAt(10, 0, 10).cells, [2, 4, 1]);
  assert.ok(world.itemAt(11, 3, 10), 'top corner cell resolves to the item');
  assert.equal(world.itemAt(10, 0, 11), null, 'depth stays 1 cell');
  assert.equal(world.itemAt(10, 4, 10), null, 'nothing above the footprint');
  assert.equal(world.place('grass', SIZE.SMALL, 11, 3, 10), false, 'blocks respect the tall footprint');
});

test('odd quarter-turn rotations swap a footprint\'s x/z span', () => {
  const world = makeItemWorld();
  assert.equal(world.placeItem('lamp', [2, 4, 1], 10, 0, 10, Math.PI / 2), true);
  assert.ok(world.itemAt(10, 0, 11), 'rotated footprint extends into z');
  assert.equal(world.itemAt(11, 0, 10), null, 'rotated footprint is 1 cell wide in x');
  const world2 = makeItemWorld();
  assert.equal(world2.placeItem('lamp', [2, 4, 1], 10, 0, 10, Math.PI), true);
  assert.ok(world2.itemAt(11, 0, 10), '180° keeps the original span');
  assert.equal(world2.itemAt(10, 0, 11), null);
});

test('quarterTurns maps yaw radians to 0..3', () => {
  assert.equal(quarterTurns(0), 0);
  assert.equal(quarterTurns(Math.PI / 2), 1);
  assert.equal(quarterTurns(Math.PI), 2);
  assert.equal(quarterTurns(-Math.PI / 2), 3);
  assert.equal(quarterTurns(2 * Math.PI), 0);
});

test('rotateMicroPoint re-centres into the swapped volume on non-square grids', () => {
  // 16×8 grid rotated 90° → the point lands inside the swapped 8×16 box.
  const [x, z] = rotateMicroPoint(0, 0, Math.PI / 2, 16, 8);
  assert.deepEqual([Math.round(x) + 0, Math.round(z) + 0], [8, 0]);
  const [x2, z2] = rotateMicroPoint(15, 7, Math.PI / 2, 16, 8);
  assert.deepEqual([Math.round(x2), Math.round(z2)], [1, 15]);
});

test('world.clear removes items and their occupancy', () => {
  const world = makeItemWorld();
  world.placeItem('lamp', SIZE.SMALL, 1, 1, 1);
  world.clear();
  assert.equal(world.itemAt(1, 1, 1), null);
  assert.equal(world.isAreaFree(1, 1, 1, SIZE.SMALL), true);
});

test('world removes all placements of an item id', () => {
  const world = makeItemWorld();
  registerItem({ id: 'post', name: 'Post', size: 'small', microVoxels: [], light: null });
  world.placeItem('lamp', SIZE.SMALL, 1, 1, 1);
  world.placeItem('lamp', SIZE.SMALL, 5, 1, 1);
  world.placeItem('post', SIZE.SMALL, 1, 1, 5);
  assert.equal(world.removeItemsById('lamp'), 2);
  assert.equal(world.itemAt(1, 1, 1), null);
  assert.equal(world.itemAt(5, 1, 1), null);
  assert.equal(world.itemAt(1, 1, 5).itemId, 'post', 'other items must be untouched');
  assert.equal(world.isAreaFree(1, 1, 1, SIZE.SMALL), true, 'removed item cells must be free again');
  clearItems();
});

// --- item collision (blocking vs traversable) ---

test('blocking items are solid to the player, traversable items are not', () => {
  clearItems();
  registerItem({ id: 'wall', name: 'Wall', size: 'small', solid: true, microVoxels: [], light: null });
  registerItem({ id: 'rug', name: 'Rug', size: 'small', solid: false, microVoxels: [], light: null });
  registerItem({ id: 'prop', name: 'Prop', size: 'small', microVoxels: [], light: null });
  const world = new World();
  const cw = collisionWorld(world);
  const box = { minX: 0, minY: 0, minZ: 0, maxX: 0.5, maxY: 1.8, maxZ: 0.5 };

  world.placeItem('wall', SIZE.SMALL, 0, 0, 0);
  assert.equal(collides(cw, box), true, 'blocking item must block the player');

  world.removeItemAt(0, 0, 0);
  world.placeItem('rug', SIZE.SMALL, 0, 0, 0);
  assert.equal(collides(cw, box), false, 'traversable item must let the player through');

  world.removeItemAt(0, 0, 0);
  world.placeItem('prop', SIZE.SMALL, 0, 0, 0);
  assert.equal(collides(cw, box), true, 'items without a solid flag default to blocking');
  clearItems();
});

test('pickable (equipment) items are traversable even when solid', () => {
  clearItems();
  clearEquipItems();
  registerItem({ id: 'medkit', name: 'Medkit', size: 'small', solid: true, microVoxels: [], light: null });
  registerEquipItem({ ...emptyEquipItem('Medkit'), id: 'medkit' });
  const world = new World();
  const cw = collisionWorld(world);
  const box = { minX: 0, minY: 0, minZ: 0, maxX: 0.5, maxY: 1.8, maxZ: 0.5 };

  world.placeItem('medkit', SIZE.SMALL, 0, 0, 0);
  assert.equal(collides(cw, box), false, 'pickable items must not block the player');
  clearEquipItems();
  clearItems();
});

test('collision world still respects plain voxels next to items', () => {
  clearItems();
  registerItem({ id: 'rug', name: 'Rug', size: 'small', solid: false, microVoxels: [], light: null });
  const world = new World();
  const cw = collisionWorld(world);
  world.place('grass', SIZE.SMALL, 5, 0, 5);
  world.placeItem('rug', SIZE.SMALL, 5, 1, 5); // on top of the block, traversable
  // Box spanning cells (5,0,5) and (5,1,5): the grass below stays solid.
  assert.equal(collides(cw, { minX: 2.5, minY: 0, minZ: 2.5, maxX: 3, maxY: 1, maxZ: 3 }), true, 'the voxel underneath stays solid');
  clearItems();
});

// --- world serialization with items ---

test('world serializer round-trips placed items and their yaw', () => {
  clearItems();
  registerItem({ id: 'lamp', name: 'Lamp', size: 'small', microVoxels: [{ x: 0, y: 0, z: 0, color: [10, 20, 30] }], light: null });
  registerItem({ id: 'post', name: 'Post', size: 'big', microVoxels: [], light: null });
  const world = new World();
  world.place('grass', SIZE.BIG, 0, 0, 0);
  world.placeItem('lamp', SIZE.SMALL, 0, 2, 0, Math.PI / 2);
  world.placeItem('post', SIZE.BIG, 4, 2, 4, Math.PI);

  const text = serialize(world);
  assert.ok(text.includes('"items"'));
  const { world: loaded, errors } = deserialize(text);
  assert.deepEqual(errors, []);
  assert.equal(loaded.count, world.count);
  const found = [];
  loaded.forEachItem((it) => found.push(it.itemId));
  assert.deepEqual(found.sort(), ['lamp', 'post']);
  assert.deepEqual(loaded.itemAt(0, 2, 0).itemId, 'lamp');
  assert.equal(loaded.itemAt(0, 2, 0).rotation, Math.PI / 2, 'lamp yaw survives the round trip');
  assert.equal(loaded.itemAt(4, 2, 4).rotation, Math.PI, 'post yaw survives the round trip');
  clearItems();
});

test('world deserialization defaults missing rotation to 0', () => {
  clearItems();
  registerItem({ id: 'lamp', name: 'Lamp', size: 'small', microVoxels: [], light: null });
  const text = JSON.stringify({
    format: 'voxelmap',
    version: 1,
    cellSize: 0.5,
    blocks: [],
    items: [{ itemId: 'lamp', x: 0, y: 2, z: 0, size: 'small' }],
  });
  const { world } = deserialize(text);
  assert.equal(world.itemAt(0, 2, 0).rotation, 0);
  clearItems();
});

test('world deserialization skips items that are not registered', () => {
  clearItems();
  registerItem({ id: 'known', name: 'Known', size: 'small', microVoxels: [], light: null });
  const text = JSON.stringify({
    format: 'voxelmap',
    version: 1,
    cellSize: 0.5,
    blocks: [],
    items: [{ itemId: 'known', x: 0, y: 0, z: 0, size: 'small' }, { itemId: 'missing', x: 1, y: 0, z: 0, size: 'small' }],
  });
  const { world, errors } = deserialize(text);
  assert.equal(world.itemAt(0, 0, 0).itemId, 'known');
  assert.equal(world.itemAt(1, 0, 0), null);
  assert.ok(errors.some((e) => e.includes('missing')));
  clearItems();
});

test('world serializer round-trips cells footprints', () => {
  clearItems();
  registerItem({ id: 'closet', name: 'Closet', cells: [2, 4, 1], microVoxels: [], light: null });
  const world = new World();
  assert.equal(world.placeItem('closet', [2, 4, 1], 0, 0, 0, Math.PI / 2), true);
  const { world: loaded, errors } = deserialize(serialize(world));
  assert.deepEqual(errors, []);
  assert.deepEqual(loaded.itemAt(0, 0, 0).cells, [2, 4, 1]);
  assert.ok(loaded.itemAt(0, 3, 1), 'rotated footprint occupancy survives the round trip');
  assert.equal(loaded.itemAt(1, 0, 0), null);
  clearItems();
});

test('old maps without an items array still load', () => {
  const text = JSON.stringify({ format: 'voxelmap', version: 1, cellSize: 0.5, blocks: [{ x: 0, y: 0, z: 0, size: 'big', type: 'grass' }] });
  const { world, errors } = deserialize(text);
  assert.deepEqual(errors, []);
  assert.equal(world.count, 1);
});
