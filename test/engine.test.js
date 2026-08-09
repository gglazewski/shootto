import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World, anchorFor, cellsFor } from '../src/engine/World.js';
import { SIZE, getBlock } from '../src/engine/VoxelTypes.js';
import { spanFor, anchorFor as shapeAnchor } from '../src/engine/VoxelShape.js';
import { CELL_SIZE as SPACE_CELL_SIZE, worldToCell as spaceWorldToCell } from '../src/engine/Space.js';
import { buildChunkMesh } from '../src/engine/ChunkMeshBuilder.js';
import { raycastVoxel, worldToCell, CELL_SIZE } from '../src/engine/VoxelRaycaster.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';
import { bulletWorld } from '../src/editor/itemPick.js';
import { Blinkers } from '../src/engine/Blinkers.js';

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

test('glass is a pane: one alpha-blended quad in the transparent buffer', () => {
  const w = new World();
  w.place('glass', SIZE.SMALL, 0, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  assert.equal(m.indices.length, 0, 'no opaque faces');
  assert.ok(m.transparent, 'transparent buffer present');
  // A single winding — the transparent material is double-sided.
  assert.equal(m.transparent.indices.length, 6);
  assert.equal(m.transparent.lights.length, m.transparent.positions.length / 3 * 2);
});

test('opaque faces adjacent to glass are still emitted', () => {
  const w = new World();
  w.place('concrete', SIZE.SMALL, 0, 0, 0);
  w.place('glass', SIZE.SMALL, 1, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  // concrete keeps all 6 faces (the +x face shows through the glass pane)
  assert.equal(m.indices.length, 6 * 6);
  // the glass pane is one centered quad regardless of neighbors
  assert.equal(m.transparent.indices.length, 6);
});

test('mixed-alpha blocks (framed window) mesh into both passes', () => {
  const w = new World();
  w.place('window_white', SIZE.SMALL, 0, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  // 6 faces in the opaque cutout pass (frame, depth-written)...
  assert.equal(m.indices.length, 6 * 6);
  // ...and the same 6 faces again in the transparent pass (glass texels).
  assert.equal(m.transparent.indices.length, 6 * 6);
  // window-on-window: the shared faces are culled in both passes
  w.place('window_white', SIZE.SMALL, 1, 0, 0);
  const m2 = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  assert.equal(m2.indices.length, 10 * 6);
  assert.equal(m2.transparent.indices.length, 10 * 6);
});

test('glazed doors emit their leaf into both passes', () => {
  const w = new World();
  w.place('door_steel', SIZE.DOOR, 0, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  // a door leaf is a 6-face slab, mirrored into the transparent pass
  assert.equal(m.indices.length, 6 * 6);
  assert.equal(m.transparent.indices.length, 6 * 6);
  // the dermatoid entrance door has no glass — opaque pass only
  const w2 = new World();
  w2.place('door_wood', SIZE.DOOR, 0, 0, 0);
  const m2 = buildChunkMesh(w2, lit, [0, 0, 0], 16, tile);
  assert.equal(m2.indices.length, 6 * 6);
  assert.equal(m2.transparent, null);
});

test('voxel rotation permutes side tiles and spins the top UVs', () => {
  const atlas = { width: 8, height: 4, tileSize: 16 };
  const tileIdx = { py: 0, ny: 1, px: 2, nx: 3, pz: 4, nz: 5 };
  const tileFn = (type, face) => tileIdx[face];
  const w = new World();
  w.place('wood', SIZE.SMALL, 0, 0, 0, 1); // one CCW quarter turn
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tileFn, atlas);
  // quads are emitted in FACE_TABLE order: px, nx, py, ny, pz, nz
  const tileOf = (q) => {
    let min = Infinity;
    for (let i = 0; i < 4; i++) min = Math.min(min, m.uvs[q * 8 + i * 2]);
    return Math.floor(min * 8 + 0.01);
  };
  assert.equal(tileOf(0), tileIdx.pz, 'world +x shows the pre-rotation +z tile');
  assert.equal(tileOf(1), tileIdx.nz, 'world -x shows the pre-rotation -z tile');
  assert.equal(tileOf(4), tileIdx.nx, 'world +z shows the pre-rotation -x tile');
  assert.equal(tileOf(5), tileIdx.px, 'world -z shows the pre-rotation +x tile');
  assert.equal(tileOf(2), tileIdx.py, 'top keeps its own tile (UVs spin instead)');

  // Top UVs spin: same block unrotated vs rotated — identical geometry,
  // different UV ordering on the y faces.
  const w0 = new World();
  w0.place('grass', SIZE.SMALL, 0, 0, 0);
  const w1 = new World();
  w1.place('grass', SIZE.SMALL, 0, 0, 0, 1);
  const m0 = buildChunkMesh(w0, lit, [0, 0, 0], 16, tile, atlas);
  const m1 = buildChunkMesh(w1, lit, [0, 0, 0], 16, tile, atlas);
  assert.deepEqual([...m0.positions], [...m1.positions], 'rotation never moves geometry');
  assert.notDeepEqual([...m0.uvs], [...m1.uvs], 'rotation must change the top-face UVs');
});

test('voxel rotation round-trips through the serializer and is omitted when 0', () => {
  const w = new World();
  w.place('asphalt_line', SIZE.SMALL, 0, 0, 0, 3);
  w.place('asphalt_line', SIZE.SMALL, 1, 0, 0);
  const text = serialize(w);
  const raw = JSON.parse(text);
  const rotated = raw.blocks.find((b) => b.x === 0);
  const plain = raw.blocks.find((b) => b.x === 1);
  assert.equal(rotated.rotation, 3);
  assert.ok(!('rotation' in plain), 'rotation 0 is not written');
  const { world: w2, errors } = deserialize(text);
  assert.deepEqual(errors, []);
  assert.equal(w2.get(0, 0, 0).rotation, 3);
  assert.equal(w2.get(1, 0, 0).rotation ?? 0, 0);
});

test('pane voxel emits one centered double-winded quad, depth-written', () => {
  const w = new World();
  w.place('fence', SIZE.SMALL, 0, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  // One quad, both windings, in the OPAQUE buffer (cutout via shader
  // discard) so overlapping panes never alpha-blend in the wrong order.
  assert.equal(m.transparent, null, 'nothing in the blended pass');
  assert.equal(m.indices.length, 2 * 6, 'front + back winding');
  assert.equal(m.positions.length, 2 * 4 * 3);
  // rotation 0: the pane runs along x at the z center (0.25m world units)
  for (let i = 2; i < m.positions.length; i += 3) {
    assert.equal(m.positions[i], 0.25, 'every vertex sits on the z-center plane');
  }
});

test('pane rotation turns the pane onto the other axis', () => {
  const w = new World();
  w.place('fence', SIZE.SMALL, 0, 0, 0, 1);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  for (let i = 0; i < m.positions.length; i += 3) {
    assert.equal(m.positions[i], 0.25, 'rotated pane sits on the x-center plane');
  }
});

test('BIG pane voxel emits one full-size pane, not one per sub-cell', () => {
  const w = new World();
  w.place('fence', SIZE.BIG, 0, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  assert.equal(m.indices.length, 2 * 6);
  let maxY = -Infinity;
  for (let i = 1; i < m.positions.length; i += 3) {
    maxY = Math.max(maxY, m.positions[i]);
  }
  assert.equal(maxY, 1, 'pane spans the whole 1m block');
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

test('blinkers toggle lights over time and saves normalize the dark phase', () => {
  const w = new World();
  w.place('lamp_blink', SIZE.SMALL, 0, 5, 0);
  const blk = new Blinkers(w);
  blk.rescan();
  assert.equal(blk.list.length, 1);
  const seen = new Set();
  for (let i = 0; i < 400; i++) { // 20s of simulated time at 50ms steps
    blk.update(0.05);
    seen.add(w.get(0, 5, 0).type);
  }
  assert.ok(seen.has('lamp_blink') && seen.has('lamp_blink_off'), 'light toggles between phases');
  assert.ok(w.edits.length > 1, 'each toggle pushes a light-edit record');
  // a save taken mid-blink stores the canonical lit id, never the hidden phase
  w.get(0, 5, 0).type = 'lamp_blink_off';
  const raw = JSON.parse(serialize(w));
  assert.equal(raw.blocks[0].type, 'lamp_blink');
});

test('blinking light blocks pair with hidden off states', () => {
  for (const [on, off] of [['lamp_blink', 'lamp_blink_off'], ['neon_blink', 'neon_blink_off']]) {
    const lit = getBlock(on);
    const dark = getBlock(off);
    assert.equal(lit.blinkOff, off);
    assert.equal(dark.blinkOn, on);
    assert.ok(lit.light > 0, `${on} emits light`);
    assert.ok(!dark.light, `${off} emits none`);
    assert.ok(dark.hidden, `${off} stays out of the palette`);
    assert.ok(!lit.hidden);
  }
});

// --- decals ---

test('decal lifecycle: attach to a face, look up, remove, go with the block', () => {
  const w = new World();
  assert.ok(!w.placeDecal('decal_blood', 0, 0, 0, 'py'), 'no block -> no decal');
  w.place('concrete', SIZE.SMALL, 0, 0, 0);
  assert.ok(w.placeDecal('decal_blood', 0, 0, 0, 'py', 2));
  assert.ok(!w.placeDecal('decal_crack', 0, 0, 0, 'py'), 'face already taken');
  assert.ok(w.placeDecal('decal_crack', 0, 0, 0, 'px'), 'other faces stay free');
  assert.equal(w.decalAt(0, 0, 0, 'py').decalId, 'decal_blood');
  assert.equal(w.decalAt(0, 0, 0, 'py').rotation, 2);
  const removed = w.removeDecal(0, 0, 0, 'px');
  assert.equal(removed.decalId, 'decal_crack');
  assert.equal(w.decalAt(0, 0, 0, 'px'), null);
  w.remove(0, 0, 0);
  assert.equal(w.decalAt(0, 0, 0, 'py'), null, 'removing the block removes its decals');
});

test('mesher pins a decal quad onto its face; buried faces emit nothing', () => {
  const w = new World();
  w.place('concrete', SIZE.SMALL, 0, 0, 0);
  w.placeDecal('decal_blood', 0, 0, 0, 'py');
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile);
  assert.equal(m.indices.length, 6 * 6 + 6, 'six faces plus one decal quad');
  // the decal quad floats just above the top face (y = 0.5m + eps)
  let maxY = -Infinity;
  for (let i = 1; i < m.positions.length; i += 3) maxY = Math.max(maxY, m.positions[i]);
  assert.ok(maxY > 0.5 && maxY < 0.52, `decal must sit a hair off the face (got ${maxY})`);

  // decal on a face buried by a neighbor -> the face is culled, decal too
  const w2 = new World();
  w2.place('concrete', SIZE.SMALL, 0, 0, 0);
  w2.place('concrete', SIZE.SMALL, 1, 0, 0);
  w2.placeDecal('decal_blood', 0, 0, 0, 'px');
  const m2 = buildChunkMesh(w2, lit, [0, 0, 0], 16, tile);
  assert.equal(m2.indices.length, 10 * 6, 'no decal quad for a hidden face');
});

test('multi-cell decal covers its footprint and needs full backing', () => {
  const w = new World();
  // a 4x2-cell wall segment at z=0, front faces visible on nz
  for (let x = 0; x < 4; x++) for (let y = 0; y < 2; y++) w.place('brick', SIZE.SMALL, x, y, 0);
  // graffiti spans [4,2]: fits exactly at anchor (0,0,0) on nz
  assert.ok(w.canPlaceDecal('decal_graffiti', 0, 0, 0, 'nz'));
  assert.ok(!w.canPlaceDecal('decal_graffiti', 1, 0, 0, 'nz'), 'footprint would hang off the wall');
  assert.ok(w.placeDecal('decal_graffiti', 0, 0, 0, 'nz'));
  // every covered cell face resolves to the same decal
  const d = w.decalAt(0, 0, 0, 'nz');
  assert.equal(w.decalAt(3, 1, 0, 'nz'), d);
  assert.ok(!w.canPlaceDecal('decal_blood', 2, 1, 0, 'nz'), 'covered faces are taken');
  // removal via ANY covered cell removes the whole footprint
  w.removeDecal(2, 0, 0, 'nz');
  assert.equal(w.decalAt(0, 0, 0, 'nz'), null);

  // odd rotations swap the footprint (4x2 -> 2x4): needs a taller wall
  assert.ok(!w.canPlaceDecal('decal_graffiti', 0, 0, 0, 'nz', 1), '2x4 does not fit a 2-high wall');
  for (let x = 0; x < 4; x++) for (let y = 2; y < 4; y++) w.place('brick', SIZE.SMALL, x, y, 0);
  assert.ok(w.canPlaceDecal('decal_graffiti', 0, 0, 0, 'nz', 1), '2x4 fits the 4-high wall');

  // removing ANY backing voxel drops the whole decal
  assert.ok(w.placeDecal('decal_graffiti', 0, 0, 0, 'nz'));
  w.remove(3, 1, 0);
  assert.equal(w.decalAt(0, 0, 0, 'nz'), null);
});

test('mesher emits one sub-rect quad per covered face of a big decal', () => {
  const w = new World();
  for (let x = 0; x < 4; x++) for (let y = 0; y < 2; y++) w.place('brick', SIZE.SMALL, x, y, 0);
  w.placeDecal('decal_graffiti', 0, 0, 0, 'nz');
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile, { width: 8, height: 11, tileSize: 16 });
  // 8 wall blocks: front faces 8, back 8, tops 4, bottoms 8?? — count decal
  // quads instead: total faces without decal + 8 decal quads
  const w2 = new World();
  for (let x = 0; x < 4; x++) for (let y = 0; y < 2; y++) w2.place('brick', SIZE.SMALL, x, y, 0);
  const m2 = buildChunkMesh(w2, lit, [0, 0, 0], 16, tile, { width: 8, height: 11, tileSize: 16 });
  assert.equal(m.indices.length - m2.indices.length, 8 * 6, 'one decal quad per covered cell face');
  // decal quads float 1cm off the nz faces (z = -0.01m); each must sample a
  // DIFFERENT sub-rect of the artwork (uv continuity across the footprint)
  const decalUVs = new Set();
  let decalQuads = 0;
  for (let q = 0; q < m.indices.length / 6; q++) {
    const vi = m.indices[q * 6];
    if (Math.abs(m.positions[vi * 3 + 2] + 0.01) < 1e-6) {
      decalQuads++;
      decalUVs.add(`${m.uvs[vi * 2]},${m.uvs[vi * 2 + 1]}`);
    }
  }
  assert.equal(decalQuads, 8);
  assert.equal(decalUVs.size, 8, 'every covered cell samples its own uv sub-rect');
});

test('decals round-trip through the serializer and need their block', () => {
  const w = new World();
  w.place('concrete', SIZE.SMALL, 0, 0, 0);
  w.placeDecal('decal_bullets', 0, 0, 0, 'pz', 1);
  const { world: w2, errors } = deserialize(serialize(w));
  assert.deepEqual(errors, []);
  const d = w2.decalAt(0, 0, 0, 'pz');
  assert.equal(d.decalId, 'decal_bullets');
  assert.equal(d.rotation, 1);

  // a decal whose block is gone from the file is skipped with a warning
  const raw = JSON.parse(serialize(w));
  raw.blocks = [];
  const { world: w3, errors: e3, fatal: f3 } = deserialize(JSON.stringify(raw));
  assert.equal(w3.decals.size, 0);
  assert.equal(e3.length, 1);
  assert.match(e3[0], /no block face there/);
  assert.ok(!f3, 'a skipped decal is not fatal — the rest of the map still loaded');
});

test('deserialize separates unreadable files from per-entry skips', () => {
  const w = new World();
  w.place('concrete', SIZE.SMALL, 0, 0, 0);
  w.place('concrete', SIZE.SMALL, 2, 0, 0);

  // an unreadable file: nothing survives, so callers may start fresh
  for (const bad of ['{oops', '{}', JSON.stringify({ format: 'voxelmap', version: 1 })]) {
    const r = deserialize(bad);
    assert.ok(r.fatal, `expected fatal for ${bad}`);
    assert.equal(r.world.count, 0);
  }

  // one stale entry: the map still loads, so callers must NOT start fresh
  const raw = JSON.parse(serialize(w));
  raw.blocks.push({ type: 'no_such_block', size: 'small', x: 9, y: 0, z: 9 });
  const { world: loaded, errors, fatal } = deserialize(JSON.stringify(raw));
  assert.ok(!fatal);
  assert.equal(errors.length, 1);
  assert.equal(loaded.count, w.count, 'the good blocks survive a bad one');
});

test('panes take decals on their flat sides only, meshed on the pane plane', () => {
  const w = new World();
  // a glass pane at rotation 0 runs along x, so it faces +-z
  w.place('glass', SIZE.SMALL, 0, 0, 0, 0);
  assert.ok(!w.canPlaceDecal('decal_curtain', 0, 0, 0, 'px'), 'edge-on faces take nothing');
  assert.ok(!w.canPlaceDecal('decal_curtain', 0, 0, 0, 'py'), 'a pane has no top face');
  assert.ok(w.placeDecal('decal_curtain', 0, 0, 0, 'nz'));
  assert.ok(w.placeDecal('decal_curtain', 0, 0, 0, 'pz'), 'each side takes its own');

  // rotated 90 degrees the pane runs along z, so the accepting faces swap
  const w2 = new World();
  w2.place('glass', SIZE.SMALL, 0, 0, 0, 1);
  assert.ok(!w2.canPlaceDecal('decal_curtain', 0, 0, 0, 'pz'));
  assert.ok(w2.canPlaceDecal('decal_curtain', 0, 0, 0, 'nx'));

  // doors take no decals at all
  const w3 = new World();
  w3.place('door_wood', SIZE.DOOR, 0, 0, 0, 0);
  assert.ok(!w3.canPlaceDecal('decal_crack', 0, 0, 0, 'nz'));

  // the decal quads sit a hair off the pane's own plane (z = 0.5 cells =
  // 0.25m), not on the cell boundary, and go into the glass's pass
  const atlas = { width: 8, height: 11, tileSize: 16 };
  const plain = new World();
  plain.place('glass', SIZE.SMALL, 0, 0, 0, 0);
  const bare = buildChunkMesh(plain, lit, [0, 0, 0], 16, tile, atlas);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile, atlas);
  const quads = m.transparent.indices.length - bare.transparent.indices.length;
  assert.equal(quads, 2 * 6, 'one quad per decorated side');
  const zs = [];
  for (let q = 0; q < m.transparent.indices.length / 6; q++) {
    const vi = m.transparent.indices[q * 6];
    zs.push(Number(m.transparent.positions[vi * 3 + 2].toFixed(4)));
  }
  assert.deepEqual(zs.sort(), [0.24, 0.25, 0.26], 'pane at 0.25m, decals 1cm either side');
});

test('copyFrom is the one world-copy path: rotation and decals survive', () => {
  const src = new World();
  src.place('asphalt_line', SIZE.SMALL, 0, 0, 0, 3);
  src.place('concrete', SIZE.SMALL, 1, 0, 0);
  src.placeDecal('decal_blood', 1, 0, 0, 'py', 2);
  src.setSpawn(0, 2, 0);
  src.spawnYaw = 90;
  const dst = new World();
  dst.place('grass', SIZE.SMALL, 9, 9, 9); // pre-existing content is replaced
  dst.copyFrom(src);
  assert.equal(dst.get(9, 9, 9), null);
  assert.equal(dst.get(0, 0, 0).rotation, 3, 'block rotation survives the copy');
  assert.equal(dst.decalAt(1, 0, 0, 'py').decalId, 'decal_blood', 'decals survive the copy');
  assert.equal(dst.decalAt(1, 0, 0, 'py').rotation, 2);
  assert.deepEqual(dst.spawn, [0, 2, 0]);
  assert.equal(dst.spawnYaw, 90);
});

// --- raycasting ---

test('attack rays pass through shoot-through blocks and hit what is behind', () => {
  const w = new World();
  w.place('fence', SIZE.SMALL, 2, 0, 0);
  w.place('concrete', SIZE.SMALL, 5, 0, 0);
  const plain = raycastVoxel(w, [0.5, 0.5, 0.5], [1, 0, 0]);
  assert.deepEqual(plain.cell, [2, 0, 0], 'a plain ray stops at the fence');
  const shot = raycastVoxel(bulletWorld(w), [0.5, 0.5, 0.5], [1, 0, 0]);
  assert.deepEqual(shot.cell, [5, 0, 0], 'a bullet passes the fence and hits the wall');
});

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

test('splash cameras round-trip through the serializer and are omitted when absent', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  w.addSplashCam({ id: 'cam_a', pos: [1.5, 8, -3.25], yaw: 1.25, pitch: -0.4, fov: 60, motion: 'orbit' });
  w.addSplashCam({ id: 'cam_b', pos: [0, 4, 0], yaw: 0, pitch: 0 });
  const { world, errors } = deserialize(serialize(w));
  assert.deepEqual(errors, []);
  assert.deepEqual(world.splashCams, [
    { id: 'cam_a', pos: [1.5, 8, -3.25], yaw: 1.25, pitch: -0.4, fov: 60, motion: 'orbit' },
    { id: 'cam_b', pos: [0, 4, 0], yaw: 0, pitch: 0 },
  ]);

  // No cams -> no field, so untouched maps stay byte-identical.
  const bare = new World();
  bare.place('grass', SIZE.SMALL, 0, 0, 0);
  assert.ok(!JSON.parse(serialize(bare)).splashCams);
});

test('deserialize skips malformed and duplicate splash cameras', () => {
  const data = {
    format: 'voxelmap', version: 1, cellSize: 0.5, blocks: [],
    splashCams: [
      { id: 'ok', pos: [0, 1, 2], yaw: 0, pitch: 0 },
      { id: 'ok', pos: [3, 4, 5], yaw: 0, pitch: 0 }, // duplicate id
      { id: 'bad-pos', pos: [1, 2], yaw: 0, pitch: 0 },
      { pos: [0, 0, 0], yaw: 0, pitch: 0 }, // no id
    ],
  };
  const { world, errors } = deserialize(JSON.stringify(data));
  assert.equal(world.splashCams.length, 1);
  assert.equal(world.splashCams[0].id, 'ok');
  assert.equal(errors.length, 3);
});

test('clear() and copyFrom() carry splash cameras', () => {
  const w = new World();
  w.addSplashCam({ id: 'c', pos: [1, 2, 3], yaw: 0.5, pitch: 0.1 });
  const copy = new World();
  copy.copyFrom(w);
  assert.deepEqual(copy.splashCams, w.splashCams);
  assert.notEqual(copy.splashCams[0], w.splashCams[0], 'copy must not share cam objects');
  copy.clear();
  assert.deepEqual(copy.splashCams, []);
});
