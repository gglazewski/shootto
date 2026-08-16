// carkit.test.js — the Nysa van kit: the connected car-window glazing
// (neighbouring window blocks dissolve the shared frame edge) and the
// per-colour body/light blocks landing in the atlas.

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE, getBlock, isConnecting, isMixedAlpha, isGlass } from '../src/engine/VoxelTypes.js';
import { buildChunkMesh } from '../src/engine/ChunkMeshBuilder.js';
import { tilesForBlocks, renderAtlasRGBA, generateTilePixels } from '../src/textures/TextureAtlas.js';

const COLORS = ['blue', 'red', 'cream'];

test('car kit blocks are registered and their tiles land in the atlas', () => {
  const names = tilesForBlocks();
  for (const c of COLORS) {
    for (const part of ['body', 'trim', 'grille', 'light', 'tail']) {
      assert.ok(getBlock(`car_${part}_${c}`), `car_${part}_${c} registered`);
      assert.ok(names.includes(`car_${part}_${c}`), `car_${part}_${c} tile in atlas`);
    }
  }
  for (const id of ['car_window', 'car_wheel', 'car_bumper']) {
    assert.ok(getBlock(id), `${id} registered`);
  }
  const { map } = renderAtlasRGBA(names);
  for (const t of ['car_window', 'car_wheel', 'car_tire', 'car_bumper']) {
    assert.ok(map.has(t), `${t} packed`);
  }
});

test('car window is connecting glazing with 15 atlas frame variants', () => {
  assert.equal(isConnecting('car_window'), true);
  assert.equal(isMixedAlpha('car_window'), true);
  assert.equal(isGlass('car_window'), true);
  const names = tilesForBlocks();
  const { map } = renderAtlasRGBA(names);
  for (let m = 1; m < 16; m++) {
    assert.ok(names.includes(`car_window_${m}`), `car_window_${m} referenced`);
    assert.ok(map.has(`car_window_${m}`), `car_window_${m} packed`);
  }
  // an open edge trades its gasket for glass: variant 15 (all edges open)
  // has translucent texels where the base tile's frame is opaque
  const alphaAt = (px, x, y) => px[(y * 16 + x) * 4 + 3];
  const base = generateTilePixels('car_window');
  const open = generateTilePixels('car_window_15');
  assert.equal(alphaAt(base, 0, 8), 255, 'base frames its left edge');
  assert.ok(alphaAt(open, 0, 8) < 128, 'open variant runs glass to the edge');
});

const meshWindows = (placements) => {
  const world = new World();
  for (const [x, y, z, rot] of placements) {
    world.place('car_window', SIZE.SMALL, x, y, z, rot ?? 0);
  }
  const used = [];
  const rec = (id) => { used.push(String(id)); return 0; };
  const mesh = buildChunkMesh(world, null, [0, 0, 0], 4, rec, { width: 8, height: 40 });
  return { mesh, tiles: used.filter((id) => id.startsWith('car_window')).sort() };
};

test('the car window is an edge pane: rotation walks it around the cell', () => {
  assert.equal(getBlock('car_window').shape, 'pane');
  assert.equal(getBlock('car_window').edge, true);
  // one pane = one quad, double-winded into the opaque cutout pass (8 verts)
  // plus a single winding in the transparent pass for the glass texels
  const planes = [
    [0, { axis: 2, at: 1 }], // along x, hugging +z
    [1, { axis: 0, at: 1 }], // along z, hugging +x
    [2, { axis: 2, at: 0 }], // along x, hugging -z
    [3, { axis: 0, at: 0 }], // along z, hugging -x
  ];
  for (const [rot, { axis, at }] of planes) {
    const { mesh } = meshWindows([[0, 0, 0, rot]]);
    assert.equal(mesh.positions.length / 3, 8, `rot ${rot} double-winded frame`);
    assert.ok(mesh.transparent, `rot ${rot} has a glass pass`);
    assert.equal(mesh.transparent.positions.length / 3, 4, `rot ${rot} glass single-winded`);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      // CELL_SIZE = 0.5 m: the pane sits exactly on the cell edge
      assert.equal(mesh.positions[i + axis], at * 0.5, `rot ${rot} hugs its edge`);
    }
  }
});

test('adjacent car windows dissolve the shared frame edge', () => {
  // a run of two along x: the left pane opens its art-right edge (mask 2),
  // the right its art-left (mask 1) — the shared frame edge disappears
  const along = meshWindows([[0, 0, 0], [1, 0, 0]]);
  assert.deepEqual(along.tiles, ['car_window_1', 'car_window_2']);
  // stacked: the lower pane opens its art-top (mask 4), the upper its
  // art-bottom (mask 8)
  const stacked = meshWindows([[0, 0, 0], [0, 1, 0]]);
  assert.deepEqual(stacked.tiles, ['car_window_4', 'car_window_8']);
  // a lone pane stays fully framed
  assert.deepEqual(meshWindows([[0, 0, 0]]).tiles, ['car_window']);
  // different edges never merge: same cells, opposite planes
  const split = meshWindows([[0, 0, 0, 0], [1, 0, 0, 2]]);
  assert.deepEqual(split.tiles, ['car_window', 'car_window']);
  // perpendicular meetings keep the corner pillar framed
  const corner = meshWindows([[0, 0, 0, 0], [1, 0, 0, 1]]);
  assert.ok(corner.tiles.every((t) => t === 'car_window'), 'no merge across the corner');
});
