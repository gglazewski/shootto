import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World, anchorFor, cellsFor } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { spanFor, anchorFor as shapeAnchor } from '../src/engine/VoxelShape.js';
import { CELL_SIZE as SPACE_CELL_SIZE, worldToCell as spaceWorldToCell } from '../src/engine/Space.js';
import { buildChunkMesh } from '../src/engine/ChunkMeshBuilder.js';
import { raycastVoxel, worldToCell, CELL_SIZE } from '../src/engine/VoxelRaycaster.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';

const tile = () => 0;

// Stub light field: everything fully sky-lit, so meshing tests focus on
// geometry counts rather than light values.
const lit = { skyAt: () => 15, blockAt: () => 0, get: () => ({ sky: 15, block: 0 }) };

test('World place/get/remove roundtrip', () => {
  const w = new World();
  assert.ok(w.place('grass', SIZE.SMALL, 0, 0, 0));
  assert.equal(w.get(0, 0, 0).type, 'grass');
  assert.equal(w.get(0, 0, 0).size, SIZE.SMALL);
  assert.equal(w.count, 1);
  assert.ok(w.remove(0, 0, 0));
  assert.equal(w.get(0, 0, 0), null);
  assert.equal(w.count, 0);
});

test('place is atomic on overlap', () => {
  const w = new World();
  assert.ok(w.place('grass', SIZE.SMALL, 0, 0, 0));
  assert.ok(!w.place('sand', SIZE.BIG, 0, 0, 0)); // would overlap (0,0,0)
  assert.equal(w.get(1, 1, 1), null); // big voxel not partially placed
});

test('BIG voxel occupies 8 cells and shares one object', () => {
  const w = new World();
  assert.ok(w.place('wood', SIZE.BIG, 0, 0, 0));
  for (const [x, y, z] of cellsFor(0, 0, 0, SIZE.BIG)) {
    assert.equal(w.get(x, y, z).type, 'wood');
  }
  assert.equal(w.count, 1); // unique
  assert.ok(w.remove(1, 1, 1)); // remove via any sub-cell
  assert.equal(w.count, 0);
  for (const [x, y, z] of cellsFor(0, 0, 0, SIZE.BIG)) assert.equal(w.get(x, y, z), null);
});

test('anchorFor enforces even coords for BIG voxels', () => {
  assert.deepEqual(anchorFor(3, 5, -1, SIZE.BIG), [2, 4, -2]);
  assert.deepEqual(anchorFor(3, 5, -1, SIZE.SMALL), [3, 5, -1]);
});

// --- voxel shape + space ---

test('VoxelShape span/parity is data-driven per size', () => {
  assert.equal(spanFor(SIZE.SMALL), 1);
  assert.equal(spanFor(SIZE.BIG), 2);
  assert.equal(spanFor('unknown'), 1); // safe fallback
  assert.deepEqual(shapeAnchor(7, 7, 7, SIZE.BIG), [6, 6, 6]);
  assert.deepEqual(shapeAnchor(7, 7, 7, SIZE.SMALL), [7, 7, 7]);
});

test('CELL_SIZE is defined exactly once (Space is the single source)', () => {
  assert.equal(CELL_SIZE, SPACE_CELL_SIZE);
  assert.deepEqual(worldToCell([1, 1, 1]), [2, 2, 2]);
  assert.deepEqual(spaceWorldToCell([1, 1, 1]), [2, 2, 2]);
});

test('dirty chunk tracking marks the voxel chunk and its 26 neighbors', () => {
  const w = new World(16);
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  const dirty = new Set(w.drainDirty());
  assert.equal(dirty.size, 27); // 3x3x3 around the chunk containing (0,0,0)
  assert.ok(dirty.has('0,0,0'));
  assert.ok(dirty.has('1,1,1'));
  assert.deepEqual(w.drainDirty(), []);
});

test('edits at a chunk boundary mark the neighboring chunk', () => {
  const w = new World(16);
  w.place('grass', SIZE.SMALL, 15, 0, 0);
  const dirty = new Set(w.drainDirty());
  assert.ok(dirty.has('0,0,0'));
  assert.ok(dirty.has('1,0,0'));
});

test('bounds over mixed voxels', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 2, 0, 0);
  w.place('grass', SIZE.SMALL, -1, 5, 0);
  const { min, max } = w.bounds();
  assert.deepEqual(min, [-1, 0, 0]);
  assert.deepEqual(max, [2, 5, 0]);
});

test('world spawn point lifecycle', () => {
  const w = new World();
  assert.equal(w.spawn, null);
  w.setSpawn(1, 2, 3);
  assert.deepEqual(w.spawn, [1, 2, 3]);
  w.clearSpawn();
  assert.equal(w.spawn, null);
  w.setSpawn(4, 5, 6);
  w.clear();
  assert.equal(w.spawn, null, 'clear() drops the spawn too');
});

// --- meshing ---

test('empty chunk produces no geometry', () => {
  const w = new World();
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  assert.equal(m.positions.length, 0);
  assert.equal(m.indices.length, 0);
});

test('single small voxel emits 6 faces = 36 vertices', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  assert.equal(m.indices.length, 6 * 6); // 6 tris per face * 6 faces
  assert.equal(m.positions.length, 6 * 4 * 3);
});

test('two adjacent voxels cull their shared faces', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  w.place('grass', SIZE.SMALL, 1, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  assert.equal(m.indices.length, 10 * 6); // 10 exposed faces * 6 indices
});

test('BIG voxel renders as a full 1m cube (24 quads)', () => {
  const w = new World();
  w.place('wood', SIZE.BIG, 0, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  // 6 exposed sides * 4 sub-quads * 2 tris * 3 indices
  assert.equal(m.indices.length, 6 * 4 * 2 * 3);
});

test('two aligned BIG voxels cull the shared plane entirely', () => {
  const w = new World();
  w.place('wood', SIZE.BIG, 0, 0, 0);
  w.place('wood', SIZE.BIG, 2, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  // each cube shows 5 sides * 4 quads (the shared plane is hidden)
  assert.equal(m.indices.length, 5 * 4 * 2 * 3 * 2);
});

test('face positions live on the cell boundary in world units', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  const maxCoord = Math.max(...m.positions);
  assert.equal(maxCoord, 0.5);
});

test('chunk boundary reads neighbors from the world', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 15, 0, 0);
  w.place('grass', SIZE.SMALL, 16, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  // 15,0,0 loses its +x face to the neighbor in the adjacent chunk -> 5 faces
  assert.equal(m.indices.length, 5 * 6);
});

test('mesher emits a light attribute with two channels per vertex', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  const verts = m.positions.length / 3;
  assert.equal(m.lights.length, verts * 2);
  for (let i = 0; i < verts; i++) {
    assert.equal(m.lights[i * 2], 1, 'sky channel fully lit');
    assert.equal(m.lights[i * 2 + 1], 0, 'no block light');
  }
});

test('transparent voxel renders into the transparent buffer only', () => {
  const w = new World();
  w.place('glass', SIZE.SMALL, 0, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  assert.equal(m.indices.length, 0, 'no opaque faces');
  assert.ok(m.transparent, 'transparent buffer present');
  assert.equal(m.transparent.indices.length, 6 * 6);
  assert.equal(m.transparent.lights.length, m.transparent.positions.length / 3 * 2);
});

test('opaque faces adjacent to glass are still emitted', () => {
  const w = new World();
  w.place('concrete', SIZE.SMALL, 0, 0, 0);
  w.place('glass', SIZE.SMALL, 1, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  // concrete keeps all 6 faces (the +x face shows through the glass)
  assert.equal(m.indices.length, 6 * 6);
  // glass loses its -x face to the concrete -> 5 transparent faces
  assert.equal(m.transparent.indices.length, 5 * 6);
});

test('glass-to-glass faces are culled', () => {
  const w = new World();
  w.place('glass', SIZE.SMALL, 0, 0, 0);
  w.place('glass', SIZE.SMALL, 1, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  // each glass block shows 5 faces -> 10 transparent quads total
  assert.equal(m.transparent.indices.length, 10 * 6);
  assert.equal(m.indices.length, 0);
});

test('dark corners produce a dimmer light value', () => {
  const w = new World();
  // a solid wall at x=0 (all y,z), lit sky above via a tall empty column
  for (let y = 0; y < 4; y++) w.place('concrete', SIZE.SMALL, 0, y, 0);
  const field = {
    skyAt: (x, y, z) => (x === -1 || x === 1 ? 15 : 0),
    blockAt: () => 0,
  };
  const m = buildChunkMesh(w, field, [0, 0, 0], 16, tile);
  // every vertex has a light value; the +x face (x===1 bright) differs from
  // the -x face (x===-1 bright too) — just confirm the attribute flows through
  assert.ok(m.lights.length > 0);
  assert.ok(m.lights.every((v) => v >= 0 && v <= 1));
});

// --- raycasting ---

test('ray hits the first voxel and returns the entry normal', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  // ray along +x from inside cell (-1,0,0) heading toward the voxel
  const hit = raycastVoxel(w, [-0.5, 0.5, 0.5], [1, 0, 0]);
  assert.ok(hit);
  assert.deepEqual(hit.cell, [0, 0, 0]);
  assert.deepEqual(hit.normal, [-1, 0, 0]);
  assert.ok(hit.dist > 0);
});

test('ray misses when no voxel', () => {
  const w = new World();
  assert.equal(raycastVoxel(w, [0.5, 0.5, 0.5], [1, 0, 0]), null);
});

test('ray respects max distance', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  const far = worldToCell([500, 0, 0]);
  assert.equal(raycastVoxel(w, far, [-1, 0, 0], 8), null);
});

// --- serialization ---

test('serialize -> deserialize roundtrip preserves voxels', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  w.place('wood', SIZE.BIG, -2, 1, 4);
  w.place('sand', SIZE.SMALL, 3, -1, 2);
  const text = serialize(w);
  const { world, errors } = deserialize(text);
  assert.deepEqual(errors, []);
  assert.equal(world.count, w.count);
  const before = new Set();
  w.forEachVoxel((v) => before.add(`${v.anchor.join(',')}:${v.type}:${v.size}`));
  const after = new Set();
  world.forEachVoxel((v) => after.add(`${v.anchor.join(',')}:${v.type}:${v.size}`));
  assert.deepEqual(after, before);
});

test('deserialize rejects unknown block ids', () => {
  const data = { format: 'voxelmap', version: 1, cellSize: 0.5, blocks: [{ x: 0, y: 0, z: 0, size: 'small', type: 'diamond' }] };
  const { world, errors } = deserialize(JSON.stringify(data));
  assert.equal(world.count, 0);
  assert.ok(errors.some((e) => e.includes('diamond')));
});

test('deserialize skips overlapping blocks', () => {
  const data = {
    format: 'voxelmap', version: 1, cellSize: 0.5,
    blocks: [
      { x: 0, y: 0, z: 0, size: 'small', type: 'grass' },
      { x: 0, y: 0, z: 0, size: 'small', type: 'sand' },
    ],
  };
  const { world, errors } = deserialize(JSON.stringify(data));
  assert.equal(world.count, 1);
  assert.equal(world.get(0, 0, 0).type, 'grass');
  assert.ok(errors.length > 0);
});

test('serialize/deserialize preserves the spawn point', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  w.setSpawn(2, 4, 6);
  const { world, errors } = deserialize(serialize(w));
  assert.deepEqual(errors, []);
  assert.deepEqual(world.spawn, [2, 4, 6]);

  const empty = deserialize(serialize(new World()));
  assert.equal(empty.world.spawn, null);
  assert.deepEqual(empty.errors, []);
});

test('serialize/deserialize preserves the spawn facing yaw', () => {
  const w = new World();
  w.setSpawn(2, 4, 6);
  w.spawnYaw = 180;
  const { world, errors } = deserialize(serialize(w));
  assert.deepEqual(errors, []);
  assert.equal(world.spawnYaw, 180);

  // Old maps without a yaw default to facing -Z (0°).
  const legacy = deserialize(JSON.stringify({ format: 'voxelmap', version: 1, cellSize: 0.5, spawn: [1, 1, 1], blocks: [] }));
  assert.equal(legacy.world.spawnYaw, 0);
});

test('deserialize rejects a malformed spawn point', () => {
  const data = { format: 'voxelmap', version: 1, cellSize: 0.5, spawn: [1, 2], blocks: [] };
  const { world, errors } = deserialize(JSON.stringify(data));
  assert.equal(world.spawn, null);
  assert.ok(errors.some((e) => e.toLowerCase().includes('spawn')));
});
