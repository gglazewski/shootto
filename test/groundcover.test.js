// groundcover.test.js — grass-family ground cover (tufts / flowers meshed as
// crossed cutout quads above exposed tops), the biome shade blocks and their
// atlas tiles.

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE, getBlock, coverFor, isBlockId } from '../src/engine/VoxelTypes.js';
import { buildChunkMesh } from '../src/engine/ChunkMeshBuilder.js';
import { generateTilePixels, tilesForBlocks, renderAtlasRGBA } from '../src/textures/TextureAtlas.js';

const tileIndexFor = () => 0;
const atlas = { width: 4, height: 2 };

const vertCount = (mesh) => mesh.positions.length / 3;

const meshSingle = (type) => {
  const world = new World();
  world.place(type, SIZE.SMALL, 0, 0, 0, 0);
  return buildChunkMesh(world, null, [0, 0, 0], 4, tileIndexFor, atlas);
};

test('biome shade blocks are registered', () => {
  for (const id of ['grass_dry', 'grass_lush', 'stone_dark', 'stone_light', 'dirt_dry', 'dirt_dark', 'sand_red', 'sand_dark']) {
    assert.ok(isBlockId(id), `${id} registered`);
    assert.ok(!getBlock(id).hidden, `${id} visible in the palette`);
  }
});

test('grass family carries the cover config, other ground does not', () => {
  for (const id of ['grass', 'grass_dry', 'grass_lush']) {
    const c = coverFor(id);
    assert.ok(c, `${id} has cover`);
    assert.equal(c.tuftChance, 0.6);
    assert.equal(c.flowerChance, 0.2);
    assert.ok(c.flowers.length >= 2, 'several flower types');
  }
  for (const id of ['dirt', 'stone', 'sand', 'sand_red', 'concrete']) {
    assert.equal(coverFor(id), null, `${id} stays bare`);
  }
});

test('cover tiles generate cutout art, shade tiles differ from their base', () => {
  for (const name of ['tuft_grass', 'tuft_grass_dry', 'tuft_grass_lush',
    'flower_dandelion', 'flower_poppy', 'flower_cornflower', 'flower_daisy']) {
    const px = generateTilePixels(name);
    let clear = 0;
    let solid = 0;
    for (let i = 3; i < px.length; i += 4) (px[i] === 0 ? clear++ : solid++);
    assert.ok(clear > 0, `${name} has transparent texels`);
    assert.ok(solid > 8, `${name} has visible art`);
  }
  const sum = (name, ch) => {
    const px = generateTilePixels(name);
    let s = 0;
    for (let i = ch; i < px.length; i += 4) s += px[i];
    return s;
  };
  assert.ok(sum('grass_dry', 0) > sum('grass_top', 0), 'dry grass is redder');
  assert.ok(sum('grass_lush', 0) < sum('grass_top', 0), 'lush grass is deeper');
  assert.ok(sum('sand_red', 2) < sum('sand', 2), 'red sand loses blue');
  assert.ok(sum('stone_dark', 1) < sum('stone', 1), 'dark rock is darker');
});

test('atlas includes the cover tiles and still packs', () => {
  const names = tilesForBlocks();
  for (const t of ['tuft_grass', 'flower_dandelion', 'flower_poppy', 'grass_dry', 'sand_red']) {
    assert.ok(names.includes(t), `${t} in atlas set`);
  }
  const r = renderAtlasRGBA(names); // throws if the atlas overflows
  assert.ok(r.map.has('tuft_grass'));
  assert.ok(r.map.has('flower_daisy'));
});

test('grass tops sprout cover quads, bare blocks do not', () => {
  // hash3(0,0,0) = 0 -> the origin cell always grows a tuft.
  const grass = meshSingle('grass');
  const dirt = meshSingle('dirt');
  // cube faces are identical; the cover X adds 2 quads x 2 windings x 4 verts
  assert.equal(vertCount(grass) - vertCount(dirt), 16);
  // the cover stands in the cell above the block (cells 1..2 in world y)
  let above = 0;
  for (let i = 1; i < grass.positions.length; i += 3) {
    if (grass.positions[i] > 0.51) above++; // above the block top (y=1 cell * 0.5m)
  }
  assert.ok(above >= 8, 'cover verts sit above the top face');
});

test('cover is suppressed under another block and on carved slab tops', () => {
  const stacked = new World();
  stacked.place('grass', SIZE.SMALL, 0, 0, 0, 0);
  stacked.place('dirt', SIZE.SMALL, 0, 1, 0, 0);
  const withLid = buildChunkMesh(stacked, null, [0, 0, 0], 4, tileIndexFor, atlas);

  const plainStack = new World();
  plainStack.place('dirt', SIZE.SMALL, 0, 0, 0, 0);
  plainStack.place('dirt', SIZE.SMALL, 0, 1, 0, 0);
  const plain = buildChunkMesh(plainStack, null, [0, 0, 0], 4, tileIndexFor, atlas);
  assert.equal(vertCount(withLid), vertCount(plain), 'buried grass grows nothing');

  const slab = new World();
  slab.place('grass', SIZE.SMALL, 0, 0, 0, 0, 'lower');
  const dirtSlab = new World();
  dirtSlab.place('dirt', SIZE.SMALL, 0, 0, 0, 0, 'lower');
  assert.equal(
    vertCount(buildChunkMesh(slab, null, [0, 0, 0], 4, tileIndexFor, atlas)),
    vertCount(buildChunkMesh(dirtSlab, null, [0, 0, 0], 4, tileIndexFor, atlas)),
    'lower-slab grass grows nothing',
  );
});

test('cover scatter is deterministic and lands near 80% of cells', () => {
  const world = new World();
  const N = 24;
  for (let x = 0; x < N; x++)
    for (let z = 0; z < N; z++)
      world.place('grass', SIZE.SMALL, x, 0, z, 0);
  const a = buildChunkMesh(world, null, [0, 0, 0], N, tileIndexFor, atlas);
  const b = buildChunkMesh(world, null, [0, 0, 0], N, tileIndexFor, atlas);
  assert.deepEqual([...a.positions], [...b.positions], 'stable across rebuilds');

  const bare = new World();
  for (let x = 0; x < N; x++)
    for (let z = 0; z < N; z++)
      bare.place('dirt', SIZE.SMALL, x, 0, z, 0);
  const base = buildChunkMesh(bare, null, [0, 0, 0], N, tileIndexFor, atlas);
  const covered = (vertCount(a) - vertCount(base)) / 16;
  const ratio = covered / (N * N);
  assert.ok(ratio > 0.7 && ratio < 0.9, `~80% covered, got ${(ratio * 100).toFixed(1)}%`);
});
