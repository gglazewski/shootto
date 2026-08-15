// prefab.test.js — prefab serializer, stamp rotation math, paste command.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { registerItem, clearItems } from '../src/engine/ItemRegistry.js';
import {
  serializePrefab,
  deserializePrefab,
  normalizePrefabDims,
  slugifyPrefabName,
} from '../src/persistence/PrefabSerializer.js';
import {
  rotatedDims,
  rotateAnchor,
  rotateFace,
  mirrorFaceX,
  flipPlacement,
  prefabPlacements,
  stampPrefab,
  unstampPrefab,
  countBlocked,
} from '../src/engine/PrefabStamp.js';
import { pastePrefabCommand, prefabResizeCommand } from '../src/editor/commands.js';
import {
  contentBounds,
  resizeLimits,
  resizePlan,
  clampDelta,
  pickBoxFace,
  translatePrefabContent,
  faceLabel,
} from '../src/editor/prefabResize.js';

const ITEM = {
  id: 'test_crate', name: 'Test Crate', cells: [2, 1, 1],
  microVoxels: [{ x: 0, y: 0, z: 0, color: [100, 80, 60] }],
};

function buildPrefabWorld() {
  const world = new World();
  // L-shape marker: distinguishable under rotation.
  world.place('brick', SIZE.SMALL, 0, 0, 0);
  world.place('brick', SIZE.SMALL, 1, 0, 0);
  world.place('wood', SIZE.SMALL, 0, 0, 1);
  world.place('stone', SIZE.SMALL, 0, 1, 0, 2); // rotated block
  return world;
}

describe('PrefabSerializer', () => {
  beforeEach(() => {
    clearItems();
    registerItem(ITEM);
  });

  test('round-trips blocks, items and dims', () => {
    const world = buildPrefabWorld();
    world.placeItem('test_crate', [2, 1, 1], 2, 0, 2, 0);
    const { prefab, outside } = serializePrefab(world, { id: 'test', name: 'Test', dims: [4, 4, 4] });
    assert.equal(outside, 0);
    assert.ok(prefab);
    assert.equal(prefab.format, 'voxelprefab');
    assert.deepEqual(prefab.dims, [4, 4, 4]);
    assert.equal(prefab.blocks.length, 4);
    assert.equal(prefab.items.length, 1);

    const { prefab: back, errors } = deserializePrefab(JSON.stringify(prefab));
    assert.deepEqual(errors, []);
    assert.equal(back.blocks.length, 4);
    assert.equal(back.items.length, 1);
    const rotated = back.blocks.find((b) => b.type === 'stone');
    assert.equal(rotated.rotation, 2);
  });

  test('refuses content outside dims instead of clipping', () => {
    const world = buildPrefabWorld();
    world.place('brick', SIZE.SMALL, 9, 0, 0); // beyond a 4-cell box
    const { prefab, outside } = serializePrefab(world, { id: 't', name: 'T', dims: [4, 4, 4] });
    assert.equal(prefab, null);
    assert.equal(outside, 1);
  });

  test('ignores the session baseplate below y=0', () => {
    const world = buildPrefabWorld();
    world.place('concrete', SIZE.SMALL, 0, -1, 0);
    const { prefab, outside } = serializePrefab(world, { id: 't', name: 'T', dims: [4, 4, 4] });
    assert.equal(outside, 0);
    assert.equal(prefab.blocks.length, 4); // the baseplate block is not content
  });

  test('rejects non-prefab json', () => {
    assert.equal(deserializePrefab('{"format":"voxelmap"}').prefab, null);
    assert.equal(deserializePrefab('nope').prefab, null);
  });

  test('skips unknown block types but keeps the rest', () => {
    const world = buildPrefabWorld();
    const { prefab } = serializePrefab(world, { id: 't', name: 'T', dims: [4, 4, 4] });
    prefab.blocks.push({ x: 1, y: 1, z: 1, size: 'small', type: 'not_a_block' });
    const { prefab: back, errors } = deserializePrefab(JSON.stringify(prefab));
    assert.equal(back.blocks.length, 4);
    assert.equal(errors.length, 1);
  });

  test('normalizes dims and slugs', () => {
    assert.deepEqual(normalizePrefabDims([0, 3.7, 9999]), [1, 4, 128]);
    assert.deepEqual(normalizePrefabDims(null), [16, 16, 16]);
    assert.equal(slugifyPrefabName('Kiosk Ruchu \'94!'), 'kiosk_ruchu_94');
  });
});

describe('PrefabStamp rotation math', () => {
  test('rotatedDims swaps on odd turns', () => {
    assert.deepEqual(rotatedDims([3, 5, 7], 0), [3, 5, 7]);
    assert.deepEqual(rotatedDims([3, 5, 7], 1), [7, 5, 3]);
    assert.deepEqual(rotatedDims([3, 5, 7], 2), [3, 5, 7]);
  });

  test('rotateAnchor cycles a cell through all four turns and back', () => {
    const dims = [4, 1, 6];
    // one CCW step in a [W=4, D=6] box: (x,z) -> (z, W-1-x)
    assert.deepEqual(rotateAnchor(1, 0, 2, 1, 1, dims, 1), [2, 0, 2]);
    // four turns = identity
    assert.deepEqual(rotateAnchor(1, 0, 2, 1, 1, dims, 4), [1, 0, 2]);
    // two turns = point reflection: (x,z) -> (W-1-x, D-1-z)
    assert.deepEqual(rotateAnchor(1, 0, 2, 1, 1, dims, 2), [2, 0, 3]);
  });

  test('rotateAnchor keeps multi-cell boxes inside the footprint', () => {
    const dims = [4, 4, 6];
    // a 2x2 box at (2,0,4) in a 4x6 box; after one turn it must sit inside [6,4]
    const [x, , z] = rotateAnchor(2, 0, 4, 2, 2, dims, 1);
    assert.ok(x >= 0 && x + 2 <= 6);
    assert.ok(z >= 0 && z + 2 <= 4);
    assert.deepEqual([x, z], [4, 0]);
  });

  test('rotateFace follows the CCW side cycle, py/ny fixed', () => {
    assert.equal(rotateFace('px', 1), 'nz');
    assert.equal(rotateFace('pz', 1), 'px');
    assert.equal(rotateFace('nz', 1), 'nx');
    assert.equal(rotateFace('nx', 1), 'pz');
    assert.equal(rotateFace('py', 3), 'py');
    assert.equal(rotateFace('px', 4), 'px');
  });

  test('four quarter turns land every block back on itself', () => {
    const world = buildPrefabWorld();
    const { prefab } = serializePrefab(world, { id: 't', name: 'T', dims: [4, 4, 4] });
    const p0 = prefabPlacements(prefab, [0, 0, 0], 0);
    const p4 = prefabPlacements(prefab, [0, 0, 0], 4);
    assert.deepEqual(p4, p0);
  });

  test('one turn moves blocks to rotated positions and bumps block rotation', () => {
    const world = new World();
    world.place('brick', SIZE.SMALL, 3, 0, 0); // corner marker in a 4x4 footprint
    const { prefab } = serializePrefab(world, { id: 't', name: 'T', dims: [4, 1, 4] });
    const { blocks } = prefabPlacements(prefab, [0, 0, 0], 1);
    // (3,0) -> (z, W-1-x) = (0, 0)
    assert.deepEqual([blocks[0].x, blocks[0].y, blocks[0].z], [0, 0, 0]);
    assert.equal(blocks[0].rotation, 1);
  });

  test('stamp + unstamp restores an empty world', () => {
    clearItems();
    registerItem(ITEM);
    const src = buildPrefabWorld();
    src.placeItem('test_crate', [2, 1, 1], 2, 0, 2, 0);
    const { prefab } = serializePrefab(src, { id: 't', name: 'T', dims: [4, 4, 4] });

    const world = new World();
    const receipt = stampPrefab(world, prefab, [10, 0, 10], 1);
    assert.equal(receipt.skipped, 0);
    assert.equal(receipt.blocks.length, 4);
    assert.equal(receipt.items.length, 1);
    assert.ok(world.count > 0);

    unstampPrefab(world, receipt);
    assert.equal(world.count, 0);
    let items = 0;
    world.forEachItem(() => items++);
    assert.equal(items, 0);
  });

  test('occupied cells skip their entry and are counted', () => {
    const src = buildPrefabWorld();
    const { prefab } = serializePrefab(src, { id: 't', name: 'T', dims: [4, 4, 4] });

    const world = new World();
    world.place('stone', SIZE.SMALL, 10, 0, 10); // collides with block at prefab (0,0,0)
    assert.equal(countBlocked(world, prefab, [10, 0, 10], 0), 1);
    const receipt = stampPrefab(world, prefab, [10, 0, 10], 0);
    assert.equal(receipt.skipped, 1);
    assert.equal(receipt.blocks.length, 3);
    // The pre-existing block survives.
    assert.equal(world.get(10, 0, 10).type, 'stone');
  });
});

describe('PrefabStamp mirroring', () => {
  test('flipPlacement is its own undo and two different flips make a half turn', () => {
    assert.deepEqual(flipPlacement({ turns: 0, mirror: false }, 'x'), { turns: 0, mirror: true });
    assert.deepEqual(flipPlacement({ turns: 0, mirror: false }, 'z'), { turns: 2, mirror: true });
    for (let turns = 0; turns < 4; turns++) {
      for (const axis of ['x', 'z']) {
        const once = flipPlacement({ turns, mirror: false }, axis);
        assert.deepEqual(flipPlacement(once, axis), { turns, mirror: false });
      }
    }
    // Mz·Mx = R_2: flipping both ways leaves no mirror, just a half turn.
    assert.deepEqual(flipPlacement(flipPlacement({ turns: 1, mirror: false }, 'x'), 'z'), { turns: 3, mirror: false });
  });

  test('mirrorFaceX swaps px/nx and leaves the mirror plane alone', () => {
    assert.equal(mirrorFaceX('px'), 'nx');
    assert.equal(mirrorFaceX('nx'), 'px');
    assert.equal(mirrorFaceX('pz'), 'pz');
    assert.equal(mirrorFaceX('py'), 'py');
  });

  test('a mirrored stamp reflects x in the footprint and reverses block spin', () => {
    const world = new World();
    world.place('brick', SIZE.SMALL, 0, 0, 1);
    world.place('stone', SIZE.SMALL, 3, 0, 0, 1); // rotated corner marker
    const { prefab } = serializePrefab(world, { id: 't', name: 'T', dims: [4, 1, 4] });
    const { blocks } = prefabPlacements(prefab, [0, 0, 0], 0, true);
    const brick = blocks.find((b) => b.type === 'brick');
    const stone = blocks.find((b) => b.type === 'stone');
    assert.deepEqual([brick.x, brick.y, brick.z], [3, 0, 1]); // x -> W-1-x
    assert.deepEqual([stone.x, stone.y, stone.z], [0, 0, 0]);
    assert.equal(stone.rotation, 3); // a reflection turns R_1 into R_-1
  });

  test('every block lands on its reflection, mirror plus turns included', () => {
    const src = buildPrefabWorld();
    const { prefab } = serializePrefab(src, { id: 't', name: 'T', dims: [4, 4, 4] });
    const plain = prefabPlacements(prefab, [0, 0, 0], 0).blocks;
    const flipped = prefabPlacements(prefab, [0, 0, 0], 0, true).blocks;
    assert.equal(flipped.length, plain.length);
    for (const [i, b] of plain.entries()) {
      assert.deepEqual([flipped[i].x, flipped[i].y, flipped[i].z], [3 - b.x, b.y, b.z]);
    }
    // Mirrored then turned twice = mirrored across z: only the z coord moves.
    const half = prefabPlacements(prefab, [0, 0, 0], 2, true).blocks;
    for (const [i, b] of plain.entries()) {
      assert.deepEqual([half[i].x, half[i].y, half[i].z], [b.x, b.y, 3 - b.z]);
    }
  });

  test('a mirror flips painted and decalled side faces with the wall', () => {
    const prefab = {
      dims: [2, 1, 1],
      blocks: [{ x: 0, y: 0, z: 0, size: SIZE.SMALL, type: 'brick' }],
      items: [],
      decals: [],
      paint: [{ x: 0, y: 0, z: 0, face: 'px', type: 'grass' }],
    };
    const { paint } = prefabPlacements(prefab, [10, 0, 10], 0, true);
    assert.deepEqual(paint, [{ type: 'grass', x: 11, y: 0, z: 10, face: 'nx' }]);
  });

  test('a mirrored stamp is undoable and collision-checked like any other', () => {
    const src = buildPrefabWorld();
    const { prefab } = serializePrefab(src, { id: 't', name: 'T', dims: [4, 4, 4] });

    const world = new World();
    world.place('stone', SIZE.SMALL, 13, 0, 10); // where the mirrored (0,0,0) block lands
    assert.equal(countBlocked(world, prefab, [10, 0, 10], 0, true), 1);
    assert.equal(countBlocked(world, prefab, [10, 0, 10], 0, false), 0);

    const cmd = pastePrefabCommand(world, prefab, [10, 0, 10], 0, null, true);
    assert.equal(cmd.do(), true);
    assert.equal(cmd.skipped, 1);
    assert.equal(world.get(13, 0, 11)?.type, 'wood'); // (0,0,1) reflected to (3,0,1)
    cmd.undo();
    assert.equal(world.get(13, 0, 11), null);
    assert.equal(world.get(13, 0, 10)?.type, 'stone'); // the squatter is untouched
  });
});

describe('pastePrefabCommand', () => {
  test('do/undo/redo round-trip as one history entry', () => {
    const src = buildPrefabWorld();
    const { prefab } = serializePrefab(src, { id: 't', name: 'T', dims: [4, 4, 4] });

    const world = new World();
    const cmd = pastePrefabCommand(world, prefab, [5, 0, 5], 2);
    assert.equal(cmd.do(), true);
    const afterDo = world.count;
    assert.ok(afterDo > 0);
    assert.equal(cmd.placed, 4);

    cmd.undo();
    assert.equal(world.count, 0);

    assert.equal(cmd.do(), true);
    assert.equal(world.count, afterDo);
  });

  test('resize round-trips dims, content and the side that moved', () => {
    const world = buildPrefabWorld(); // blocks at x=0..1, y=0..1, z=0..1
    world.place('concrete', SIZE.SMALL, 0, -1, 0); // baseplate scaffolding
    const applied = [];
    const cmd = prefabResizeCommand(world, {
      dims: [7, 4, 4],
      prevDims: [4, 4, 4],
      shift: [3, 0, 0], // grabbed the −X wall and pulled 3 cells out
      apply: (dims, shift) => applied.push([dims, shift]),
    });

    cmd.do();
    assert.equal(world.get(3, 0, 0)?.type, 'brick'); // content slid with the wall
    assert.equal(world.get(0, 0, 0), null);
    assert.equal(world.get(0, -1, 0)?.type, 'concrete'); // baseplate stayed put
    assert.deepEqual(applied[0], [[7, 4, 4], [3, 0, 0]]);

    cmd.undo();
    assert.equal(world.get(0, 0, 0)?.type, 'brick');
    assert.deepEqual(applied[1], [[4, 4, 4], [-3, 0, 0]]);

    cmd.do();
    assert.equal(world.get(3, 0, 0)?.type, 'brick');
  });

  test('redo does not resurrect entries skipped on first do', () => {
    const src = buildPrefabWorld();
    const { prefab } = serializePrefab(src, { id: 't', name: 'T', dims: [4, 4, 4] });

    const world = new World();
    world.place('stone', SIZE.SMALL, 0, 0, 0);
    const cmd = pastePrefabCommand(world, prefab, [0, 0, 0], 0);
    cmd.do();
    assert.equal(cmd.skipped, 1);
    cmd.undo();
    // Blocker still there, prefab gone.
    assert.equal(world.count, 1);
    cmd.do();
    assert.equal(cmd.skipped, 1);
    assert.equal(world.get(0, 0, 0).type, 'stone');
  });
});

describe('prefabResize', () => {
  beforeEach(() => {
    clearItems();
    registerItem(ITEM);
  });

  test('contentBounds spans blocks, items and decals, ignoring the baseplate', () => {
    const world = new World();
    world.place('brick', SIZE.SMALL, 2, 0, 3);
    world.place('concrete', SIZE.SMALL, 0, -1, 0); // baseplate: not content
    world.placeItem('test_crate', [2, 1, 1], 5, 1, 3, 0); // 2 cells wide
    world.placeDecal('decal_crack', 2, 0, 3, 'px', 0);
    assert.deepEqual(contentBounds(world), { min: [2, 0, 3], max: [6, 1, 3] });
    assert.equal(contentBounds(new World()), null);
  });

  test('resizeLimits stop a side at the content, both ways', () => {
    const world = new World();
    world.place('brick', SIZE.SMALL, 2, 0, 0);
    world.place('brick', SIZE.SMALL, 5, 0, 0);
    const bounds = contentBounds(world);
    const dims = [8, 4, 4];

    // +X may come in until just past x=5, and out to the 128-cell ceiling.
    assert.deepEqual(resizeLimits(dims, bounds, 0, 1), { min: -2, max: 120 });
    // −X may come in until it reaches x=2.
    assert.deepEqual(resizeLimits(dims, bounds, 0, -1), { min: -2, max: 120 });
    // An empty axis only stops at one cell.
    assert.equal(resizeLimits(dims, bounds, 1, 1).min, -3);
    assert.equal(resizeLimits(dims, null, 0, -1).min, -7);
    assert.equal(clampDelta(-99, resizeLimits(dims, bounds, 0, -1)), -2);
    assert.equal(clampDelta(2.4, resizeLimits(dims, bounds, 0, -1)), 2);
  });

  test('only a min side shifts the content', () => {
    assert.deepEqual(resizePlan([8, 4, 4], 0, 1, 3), { dims: [11, 4, 4], shift: [0, 0, 0] });
    assert.deepEqual(resizePlan([8, 4, 4], 0, -1, 3), { dims: [11, 4, 4], shift: [3, 0, 0] });
    assert.deepEqual(resizePlan([8, 4, 4], 2, -1, -2), { dims: [8, 4, 2], shift: [0, 0, -2] });
    assert.equal(faceLabel(1, -1), 'bottom (−Y)');
  });

  test('pickBoxFace names the wall aimed at, from outside and inside', () => {
    const dims = [10, 6, 8];
    const outside = pickBoxFace([-5, 3, 4], [1, 0, 0], dims);
    assert.equal(outside.axis, 0);
    assert.equal(outside.sign, -1);
    assert.equal(outside.inside, false);

    const inside = pickBoxFace([5, 3, 4], [-1, 0, 0], dims);
    assert.equal(inside.axis, 0);
    assert.equal(inside.sign, -1);
    assert.equal(inside.inside, true);

    const ceiling = pickBoxFace([5, 3, 4], [0, 1, 0], dims);
    assert.equal(ceiling.axis, 1);
    assert.equal(ceiling.sign, 1);
    assert.equal(pickBoxFace([-5, 3, 4], [-1, 0, 0], dims), null); // looking away
  });

  test('translatePrefabContent moves everything but the baseplate', () => {
    const world = new World();
    world.place('brick', SIZE.SMALL, 0, 0, 0);
    world.place('wood', SIZE.SMALL, 1, 0, 0);
    world.place('concrete', SIZE.SMALL, 0, -1, 0);
    world.placeItem('test_crate', [2, 1, 1], 0, 1, 0, 0);
    world.placeDecal('decal_crack', 1, 0, 0, 'py', 0);
    world.addMobSpawn('zombie', 1, 0, 1);

    const moved = translatePrefabContent(world, [2, 0, 0]);
    assert.equal(moved, 5);
    assert.equal(world.get(2, 0, 0)?.type, 'brick');
    assert.equal(world.get(3, 0, 0)?.type, 'wood');
    assert.equal(world.get(0, 0, 0), null);
    assert.equal(world.get(0, -1, 0)?.type, 'concrete');
    assert.equal(world.itemAt(2, 1, 0)?.itemId, 'test_crate');
    assert.ok(world.decalAt(3, 0, 0, 'py'));
    assert.ok(world.mobSpawnAt(3, 0, 1));
    assert.equal(translatePrefabContent(world, [0, 0, 0]), 0);
  });

  test('a shift smaller than the build does not eat its own cells', () => {
    const world = new World();
    for (let x = 0; x < 5; x++) world.place('brick', SIZE.SMALL, x, 0, 0);
    translatePrefabContent(world, [1, 0, 0]);
    for (let x = 1; x <= 5; x++) assert.equal(world.get(x, 0, 0)?.type, 'brick', `cell ${x}`);
    assert.equal(world.get(0, 0, 0), null);
    assert.equal(world.count, 5);
  });
});
