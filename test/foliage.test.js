// foliage.test.js — the leaves canopy blocks and the shape:'cross' bush
// blocks (crossed cutout quads as a placeable block).

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE, getBlock, shapeFor, coverFor, isShootThrough, opacityFor, decalFacesFor } from '../src/engine/VoxelTypes.js';
import { buildChunkMesh } from '../src/engine/ChunkMeshBuilder.js';
import { collides } from '../src/engine/Physics.js';
import { generateTilePixels, tilesForBlocks } from '../src/textures/TextureAtlas.js';

const tileIndexFor = () => 0;
const atlas = { width: 4, height: 2 };
const vertCount = (mesh) => mesh.positions.length / 3;

test('leaves are plain opaque cubes without ground cover', () => {
  for (const id of ['leaves', 'leaves_dark', 'leaves_autumn']) {
    const def = getBlock(id);
    assert.ok(def, `${id} registered`);
    assert.equal(shapeFor(id), 'cube');
    assert.equal(opacityFor(id), 255, `${id} blocks light like the grass it replaces`);
    assert.equal(coverFor(id), null, `${id} sprouts nothing on top`);
  }
});

test('bushes are cross-shaped, shoot-through and light-transparent', () => {
  for (const id of ['bush', 'bush_berry', 'bush_dry']) {
    assert.equal(shapeFor(id), 'cross');
    assert.equal(isShootThrough(id), true);
    assert.equal(opacityFor(id), 0);
    assert.deepEqual([...decalFacesFor(id)], [], 'crosses take no decals');
  }
});

test('leaves tiles are opaque and darker than grass; bush tiles are cutouts', () => {
  const stats = (name) => {
    const px = generateTilePixels(name);
    let clear = 0;
    let lum = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) clear++;
      else lum += px[i] + px[i + 1] + px[i + 2];
    }
    return { clear, lum };
  };
  for (const name of ['leaves', 'leaves_dark', 'leaves_autumn']) {
    assert.equal(stats(name).clear, 0, `${name} fully opaque`);
  }
  assert.ok(stats('leaves').lum < stats('grass_top').lum, 'foliage reads darker than lawn');
  for (const name of ['bush', 'bush_berry', 'bush_dry']) {
    const s = stats(name);
    assert.ok(s.clear > 30, `${name} has air around the silhouette`);
    assert.ok(s.clear < 256, `${name} has visible art`);
  }
  // berry variant carries red dots the plain bush lacks
  const reds = (name) => {
    const px = generateTilePixels(name);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] > 0 && px[i] > 150 && px[i + 1] < 90) n++;
    }
    return n;
  };
  assert.ok(reds('bush_berry') > reds('bush'), 'berries visible');
  for (const t of ['leaves', 'leaves_autumn', 'bush', 'bush_dry']) {
    assert.ok(tilesForBlocks().includes(t), `${t} lands in the atlas`);
  }
});

test('a bush meshes as one X: 2 quads, both windings, no cube faces', () => {
  const world = new World();
  world.place('bush', SIZE.SMALL, 0, 0, 0);
  const m = buildChunkMesh(world, null, [0, 0, 0], 4, tileIndexFor, atlas);
  assert.equal(vertCount(m), 16); // 2 diagonals x 2 windings x 4 corners
  assert.equal(m.indices.length, 24);
  // inset from the cell corners (0.15 cells = 0.075 m) and one cell tall
  for (let i = 0; i < m.positions.length; i += 3) {
    assert.ok(m.positions[i] > 0.05 && m.positions[i] < 0.45, 'x inset');
    assert.ok(m.positions[i + 2] > 0.05 && m.positions[i + 2] < 0.45, 'z inset');
    assert.ok(m.positions[i + 1] === 0 || m.positions[i + 1] === 0.5, 'base to top');
  }
});

test('a BIG bush emits one 1m X at its anchor', () => {
  const world = new World();
  world.place('bush', SIZE.BIG, 0, 0, 0);
  const m = buildChunkMesh(world, null, [0, 0, 0], 4, tileIndexFor, atlas);
  assert.equal(vertCount(m), 16, 'one X, not one per covered cell');
  let top = 0;
  for (let i = 1; i < m.positions.length; i += 3) top = Math.max(top, m.positions[i]);
  assert.equal(top, 1, 'spans the full 2-cell height');
});

test('a bush neither culls its neighbors nor blocks movement-free cells', () => {
  const world = new World();
  world.place('dirt', SIZE.SMALL, 0, 0, 0);
  world.place('bush', SIZE.SMALL, 1, 0, 0);
  const m = buildChunkMesh(world, null, [0, 0, 0], 4, tileIndexFor, atlas);
  // dirt keeps all 6 faces (24 verts) — the bush hides nothing — plus the X
  assert.equal(vertCount(m), 24 + 16);
  // ...but the bush cell is still solid for collision
  assert.equal(collides(world, { minX: 0.6, minY: 0.1, minZ: 0.1, maxX: 0.9, maxY: 0.4, maxZ: 0.4 }), true);
});

test('a bush standing on grass suppresses the ground cover beneath it', () => {
  const asked = new Set();
  const spy = (typeId) => { asked.add(typeId); return 0; };

  const open = new World();
  open.place('grass', SIZE.SMALL, 0, 0, 0); // hash3(0,0,0)=0 -> always a tuft
  buildChunkMesh(open, null, [0, 0, 0], 4, spy, atlas);
  assert.ok(asked.has('tuft_grass'), 'bare grass grows its tuft');

  asked.clear();
  const shaded = new World();
  shaded.place('grass', SIZE.SMALL, 0, 0, 0);
  shaded.place('bush', SIZE.SMALL, 0, 1, 0);
  buildChunkMesh(shaded, null, [0, 0, 0], 4, spy, atlas);
  assert.ok(!asked.has('tuft_grass'), 'the bush occupies the cell above');
  assert.ok(asked.has('bush'), 'the bush itself is meshed');
});

test('bushes ignore slab variants like panes do', () => {
  const world = new World();
  assert.ok(world.place('bush', SIZE.SMALL, 0, 0, 0, 0, 'lower'));
  assert.equal(world.get(0, 0, 0).variant, undefined);
});
