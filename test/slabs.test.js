// slabs.test.js — slab variants (full / lower half / upper half) of cube
// blocks: storage, solid-range rule, meshing, collision, save format and
// the V keybinding.

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { solidYRange } from '../src/engine/VoxelShape.js';
import { CELL_SIZE } from '../src/engine/Space.js';
import { buildChunkMesh } from '../src/engine/ChunkMeshBuilder.js';
import { collides, moveAxis, groundedAt } from '../src/engine/Physics.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';
import { resolveBinding } from '../src/editor/Keybindings.js';

const tileIndexFor = () => 0;
const atlas = { width: 4, height: 2 };

const yBounds = (positions) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    lo = Math.min(lo, positions[i]);
    hi = Math.max(hi, positions[i]);
  }
  return [lo, hi];
};

test('solidYRange honors variant and voxel height', () => {
  assert.deepEqual(solidYRange({ size: SIZE.SMALL, anchor: [0, 4, 0] }), [4, 5]);
  assert.deepEqual(solidYRange({ size: SIZE.SMALL, anchor: [0, 4, 0], variant: 'lower' }), [4, 4.5]);
  assert.deepEqual(solidYRange({ size: SIZE.SMALL, anchor: [0, 4, 0], variant: 'upper' }), [4.5, 5]);
  assert.deepEqual(solidYRange({ size: SIZE.BIG, anchor: [0, 2, 0], variant: 'lower' }), [2, 3]);
  assert.deepEqual(solidYRange({ size: SIZE.BIG, anchor: [0, 2, 0], variant: 'upper' }), [3, 4]);
});

test('world stores the variant on cubes only and copies it', () => {
  const world = new World();
  assert.ok(world.place('brick', SIZE.SMALL, 0, 0, 0, 0, 'lower'));
  assert.equal(world.get(0, 0, 0).variant, 'lower');
  // panes never take a variant
  assert.ok(world.place('fence', SIZE.SMALL, 2, 0, 0, 0, 'upper'));
  assert.equal(world.get(2, 0, 0).variant, undefined);
  // bogus variants are dropped
  assert.ok(world.place('brick', SIZE.SMALL, 4, 0, 0, 0, 'sideways'));
  assert.equal(world.get(4, 0, 0).variant, undefined);

  const copy = new World();
  copy.copyFrom(world);
  assert.equal(copy.get(0, 0, 0).variant, 'lower');
  assert.equal(copy.get(2, 0, 0).variant, undefined);
});

test('mesher shrinks slab geometry to the placed half', () => {
  const mesh = (variant) => {
    const world = new World();
    world.place('brick', SIZE.SMALL, 0, 0, 0, 0, variant);
    return buildChunkMesh(world, null, [0, 0, 0], 4, tileIndexFor, atlas);
  };
  // full block: 6 faces, spans the whole cell
  const full = mesh(null);
  assert.equal(full.indices.length, 36);
  assert.deepEqual(yBounds(full.positions), [0, CELL_SIZE]);
  // lower slab: still 6 faces (top face pulled inside the cell)
  const lower = mesh('lower');
  assert.equal(lower.indices.length, 36);
  assert.deepEqual(yBounds(lower.positions), [0, CELL_SIZE / 2]);
  const upper = mesh('upper');
  assert.equal(upper.indices.length, 36);
  assert.deepEqual(yBounds(upper.positions), [CELL_SIZE / 2, CELL_SIZE]);
});

test('a BIG lower slab keeps its bottom cell layer and empties the top', () => {
  const world = new World();
  world.place('brick', SIZE.BIG, 0, 0, 0, 0, 'lower');
  const data = buildChunkMesh(world, null, [0, 0, 0], 4, tileIndexFor, atlas);
  assert.deepEqual(yBounds(data.positions), [0, 2 * CELL_SIZE / 2]);
  // the top cell layer is occupied for placement but renders nothing
  assert.ok(world.get(0, 1, 0));
  assert.equal(world.isAreaFree(0, 1, 0, SIZE.SMALL), false);
});

test('mesher culls covered slab faces and keeps visible ones', () => {
  // full block with a lower slab on top: the block's top face is hidden by
  // the slab bottom, the slab's own top face stays (it is inside its cell)
  const world = new World();
  world.place('brick', SIZE.SMALL, 0, 0, 0);
  world.place('brick', SIZE.SMALL, 0, 1, 0, 0, 'lower');
  const stacked = buildChunkMesh(world, null, [0, 0, 0], 4, tileIndexFor, atlas);
  // 12 faces total minus the two touching ones = 10 quads
  assert.equal(stacked.indices.length / 6, 10);

  // two lower slabs side by side hide their shared side faces
  const row = new World();
  row.place('brick', SIZE.SMALL, 0, 0, 0, 0, 'lower');
  row.place('brick', SIZE.SMALL, 1, 0, 0, 0, 'lower');
  const rowMesh = buildChunkMesh(row, null, [0, 0, 0], 4, tileIndexFor, atlas);
  assert.equal(rowMesh.indices.length / 6, 10);

  // a lower next to an upper shares no surface — all 12 faces emit
  const stagger = new World();
  stagger.place('brick', SIZE.SMALL, 0, 0, 0, 0, 'lower');
  stagger.place('brick', SIZE.SMALL, 1, 0, 0, 0, 'upper');
  const staggerMesh = buildChunkMesh(stagger, null, [0, 0, 0], 4, tileIndexFor, atlas);
  assert.equal(staggerMesh.indices.length / 6, 12);

  // a full block next to a lower slab keeps the uncovered side face
  const pair = new World();
  pair.place('brick', SIZE.SMALL, 0, 0, 0);
  pair.place('brick', SIZE.SMALL, 1, 0, 0, 0, 'lower');
  const pairMesh = buildChunkMesh(pair, null, [0, 0, 0], 4, tileIndexFor, atlas);
  // block: 6 faces (slab does not cover its side), slab: 5 (its side is covered)
  assert.equal(pairMesh.indices.length / 6, 11);
});

test('collision treats slabs as half-height boxes', () => {
  const world = new World();
  world.place('stone', SIZE.SMALL, 0, 0, 0, 0, 'lower'); // solid y 0..0.25 m
  world.place('stone', SIZE.SMALL, 2, 0, 0, 0, 'upper'); // solid y 0.25..0.5 m

  // hovering above the lower slab's top does not collide, overlapping does
  assert.equal(collides(world, { minX: 0.1, minY: 0.3, minZ: 0.1, maxX: 0.4, maxY: 0.6, maxZ: 0.4 }), false);
  assert.equal(collides(world, { minX: 0.1, minY: 0.2, minZ: 0.1, maxX: 0.4, maxY: 0.6, maxZ: 0.4 }), true);
  // the gap under an upper slab is free
  assert.equal(collides(world, { minX: 1.1, minY: 0.0, minZ: 0.1, maxX: 1.4, maxY: 0.24, maxZ: 0.4 }), false);
  assert.equal(collides(world, { minX: 1.1, minY: 0.0, minZ: 0.1, maxX: 1.4, maxY: 0.3, maxZ: 0.4 }), true);

  // falling onto a lower slab lands on the slab top, not the cell top
  const box = { minX: 0.1, minY: 0.6, minZ: 0.1, maxX: 0.4, maxY: 1.0, maxZ: 0.4 };
  const r = moveAxis(world, box, 'y', -0.5);
  assert.ok(r.hit);
  assert.equal(box.minY, 0.25);
  assert.ok(groundedAt(world, box));

  // walking over a lower slab is unobstructed above 0.25 m
  const stroll = { minX: -0.6, minY: 0.26, minZ: 0.1, maxX: -0.2, maxY: 1.0, maxZ: 0.4 };
  assert.equal(moveAxis(world, stroll, 'x', 1.0).hit, false);
  // ...but a box on the ground hits the slab's side
  const bump = { minX: -0.6, minY: 0.0, minZ: 0.1, maxX: -0.2, maxY: 1.0, maxZ: 0.4 };
  const rb = moveAxis(world, bump, 'x', 1.0);
  assert.ok(rb.hit);
  assert.equal(bump.maxX, 0);
});

test('variant survives the save roundtrip and full blocks stay untouched', () => {
  const world = new World();
  world.place('brick', SIZE.SMALL, 1, 2, 3, 1, 'upper');
  world.place('stone', SIZE.SMALL, 5, 0, 0);
  const data = JSON.parse(serialize(world));
  const slab = data.blocks.find((b) => b.type === 'brick');
  const full = data.blocks.find((b) => b.type === 'stone');
  assert.equal(slab.variant, 'upper');
  assert.equal('variant' in full, false);

  const { world: loaded, errors } = deserialize(serialize(world));
  assert.deepEqual(errors, []);
  assert.equal(loaded.get(1, 2, 3).variant, 'upper');
  assert.equal(loaded.get(5, 0, 0).variant, undefined);

  // malformed variants load as full blocks instead of erroring
  data.blocks[data.blocks.indexOf(slab)].variant = 'diagonal';
  const relaxed = deserialize(JSON.stringify(data));
  assert.deepEqual(relaxed.errors, []);
  assert.equal(relaxed.world.get(1, 2, 3).variant, undefined);
});

test('V resolves to the variant cycle action', () => {
  const ev = (o) => ({ code: o.code, key: o.key ?? '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
  assert.equal(resolveBinding(ev({ code: 'KeyV' })).action, 'variant.cycle');
});
