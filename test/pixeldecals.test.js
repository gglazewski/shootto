// pixeldecals.test.js — user-drawn pixel decals: base64 codec, spec
// normalization, runtime registration, atlas packing, save/load round-trip
// and prefab ride-along.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodePixels, decodePixels, normalizePixelSpec, pixelDecalId,
  createPixelDecal, pixelSpecOf, isPixelDecal, listPixelDecalIds,
  MAX_SPAN_CELLS,
} from '../src/engine/PixelDecals.js';
import {
  generateTilePixels, tileSpan, renderAtlasRGBA, tilesForBlocks,
  hasRuntimeTile, TILE_SIZE,
} from '../src/textures/TextureAtlas.js';
import { getDecal, isDecalId, SIZE } from '../src/engine/VoxelTypes.js';
import { World } from '../src/engine/World.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';
import { serializePrefab, deserializePrefab } from '../src/persistence/PrefabSerializer.js';
import { stampPrefab } from '../src/engine/PrefabStamp.js';

/** Solid one-color art for a w x h cell decal, with one transparent pixel. */
function makeArt(wCells, hCells, [r, g, b] = [200, 40, 40]) {
  const W = wCells * TILE_SIZE, H = hCells * TILE_SIZE;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  data[3] = 0; // top-left pixel transparent — cutouts must survive the trip
  return data;
}

// --- base64 codec ---

test('encodePixels/decodePixels round-trip all byte values', () => {
  const bytes = new Uint8ClampedArray(256 + 3); // exercises both pad lengths
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 255;
  for (const len of [bytes.length, 256, 255]) {
    const enc = encodePixels(bytes.subarray(0, len));
    assert.deepEqual([...decodePixels(enc)], [...bytes.subarray(0, len)], `len ${len}`);
  }
  assert.equal(decodePixels('not base64!!'), null);
  assert.equal(decodePixels('abc'), null, 'length not a multiple of 4');
  assert.equal(decodePixels(42), null);
});

// --- spec normalization ---

test('normalizePixelSpec canonicalizes and rejects junk', () => {
  const px = encodePixels(makeArt(2, 1));
  const spec = normalizePixelSpec({ name: '  Mural  ', span: ['2', 1.2], px });
  assert.equal(spec.name, 'Mural');
  assert.deepEqual(spec.span, [2, 1]);
  assert.equal(spec.px, px);
  assert.equal(normalizePixelSpec({ span: [1, 1], px: encodePixels(makeArt(1, 1)) }).name, 'Drawn Decal');
  // pixel data must match the span
  assert.equal(normalizePixelSpec({ span: [1, 1], px }), null);
  assert.equal(normalizePixelSpec({ span: [2, 1] }), null, 'missing pixels');
  // fully transparent art is rejected
  const blank = encodePixels(new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4));
  assert.equal(normalizePixelSpec({ span: [1, 1], px: blank }), null);
  // spans clamp to the registry limit
  const big = normalizePixelSpec({
    span: [99, 0],
    px: encodePixels(makeArt(MAX_SPAN_CELLS, 1)),
  });
  assert.deepEqual(big.span, [MAX_SPAN_CELLS, 1]);
});

test('pixelDecalId is content-addressed', () => {
  const a = { name: 'A', span: [1, 1], px: encodePixels(makeArt(1, 1)) };
  const b = { name: 'B', span: [1, 1], px: encodePixels(makeArt(1, 1)) };
  const c = { name: 'A', span: [1, 1], px: encodePixels(makeArt(1, 1, [1, 2, 3])) };
  assert.equal(pixelDecalId(a), pixelDecalId(b), 'name does not change identity');
  assert.notEqual(pixelDecalId(a), pixelDecalId(c), 'different art, different id');
  assert.match(pixelDecalId(a), /^decal_pix_[a-z0-9]+$/);
});

// --- registration ---

test('createPixelDecal registers a decal with a runtime tile', () => {
  const made = createPixelDecal({ name: 'Test Mural', span: [2, 2], px: encodePixels(makeArt(2, 2)) });
  assert.ok(made);
  assert.ok(isDecalId(made.id));
  assert.ok(isPixelDecal(made.id));
  assert.ok(listPixelDecalIds().includes(made.id));
  assert.deepEqual(made.span, [2, 2]);
  assert.deepEqual(getDecal(made.id).span, [2, 2]);
  assert.equal(getDecal(made.id).name, 'Test Mural');
  assert.ok(hasRuntimeTile(made.id));
  assert.deepEqual(tileSpan(made.id), [2, 2]);
  // the tile renders the exact bytes that went in
  const pixels = generateTilePixels(made.id);
  assert.deepEqual([...pixels], [...makeArt(2, 2)]);
  // idempotent: same art comes back with the same id
  const again = createPixelDecal({ name: 'Renamed', span: [2, 2], px: encodePixels(makeArt(2, 2)) });
  assert.equal(again.id, made.id);
  assert.equal(createPixelDecal({ span: [1, 1], px: 'garbage!' }), null);
});

test('drawn decal tiles pack into the atlas', () => {
  const made = createPixelDecal({ name: 'Atlas Check', span: [3, 1], px: encodePixels(makeArt(3, 1)) });
  const { map } = renderAtlasRGBA(tilesForBlocks());
  assert.ok(map.has(made.id), 'drawn tile placed in the atlas');
  for (const name of tilesForBlocks()) assert.ok(map.has(name), `tile ${name} packed`);
});

// --- persistence ---

test('drawn decals survive a save/load round-trip', () => {
  const made = createPixelDecal({ name: 'Kafelki', span: [1, 2], px: encodePixels(makeArt(1, 2, [40, 90, 160])) });
  const world = new World();
  for (let y = 0; y < 4; y++) world.place('panel', SIZE.SMALL, 0, y, 0);
  assert.ok(world.placeDecal(made.id, 0, 0, 0, 'pz', 0));
  world.placeDecal('decal_crack', 0, 3, 0, 'pz', 0);

  const json = serialize(world);
  const data = JSON.parse(json);
  assert.equal(data.pixelDecals.length, 1, 'only the placed drawn spec is written');
  assert.equal(data.pixelDecals[0].id, made.id);
  assert.equal(data.pixelDecals[0].name, 'Kafelki');

  const { world: loaded, errors } = deserialize(json);
  assert.deepEqual(errors, []);
  assert.equal(loaded.decalAt(0, 0, 0, 'pz').decalId, made.id);
  assert.deepEqual(pixelSpecOf(made.id).span, [1, 2]);
  assert.equal(serialize(loaded), json, 'round-trip is stable');
});

test('maps without drawn decals stay free of the pixelDecals field', () => {
  const world = new World();
  world.place('brick', SIZE.SMALL, 0, 0, 0);
  world.placeDecal('decal_crack', 0, 0, 0, 'py', 0);
  assert.ok(!('pixelDecals' in JSON.parse(serialize(world))));
});

test('malformed pixel decal entries are skipped with an error', () => {
  const base = JSON.parse(serialize(new World()));
  base.pixelDecals = [
    { id: 'decal_pix_ok?!', px: 'AAAA' },               // bad id
    { id: 'decal_pix_abc' },                            // missing pixels
    { id: 'decal_pix_def', span: [1, 1], px: 'AAAA' },  // wrong data length
  ];
  const { errors } = deserialize(JSON.stringify(base));
  assert.equal(errors.length, 3);
});

// --- prefabs ---

test('drawn decals ride with prefabs and re-register on stamp', () => {
  const made = createPixelDecal({ name: 'Prefab Art', span: [1, 1], px: encodePixels(makeArt(1, 1, [10, 220, 90])) });
  const world = new World();
  world.place('panel', SIZE.SMALL, 0, 0, 0);
  world.placeDecal(made.id, 0, 0, 0, 'pz', 0);

  const { prefab } = serializePrefab(world, { id: 'p1', name: 'P1' });
  assert.equal(prefab.pixelDecals.length, 1);
  assert.equal(prefab.pixelDecals[0].id, made.id);

  // parse -> stamp round-trip (specs validated, then re-registered)
  const { prefab: parsed, errors } = deserializePrefab(JSON.stringify(prefab));
  assert.deepEqual(errors, []);
  assert.equal(parsed.pixelDecals.length, 1);
  const target = new World();
  const receipt = stampPrefab(target, parsed, [4, 0, 4], 0);
  assert.equal(receipt.skipped, 0);
  assert.equal(target.decalAt(4, 0, 4, 'pz').decalId, made.id);
});
