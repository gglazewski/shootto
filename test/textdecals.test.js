// textdecals.test.js — pixel font, runtime text sign decals, atlas packing
// and save/load round-trip.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderTextMask, measureText, normalizeText, GLYPH_W, GLYPH_H } from '../src/textures/PixelFont.js';
import {
  normalizeSpec, signLayout, renderSignPixels, textDecalId, createTextDecal,
  textSpecOf, isTextDecal, listTextDecalIds, parseHexColor,
} from '../src/engine/TextDecals.js';
import {
  generateTilePixels, tileSpan, listTileNames, renderAtlasRGBA, tilesForBlocks,
  hasRuntimeTile, TILE_SIZE,
} from '../src/textures/TextureAtlas.js';
import { getDecal, isDecalId, getBlock, shapeFor, tileFor } from '../src/engine/VoxelTypes.js';
import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';

// --- pixel font ---

test('pixel font renders masks with Polish diacritics', () => {
  assert.equal(normalizeText('rzeźnik'), 'RZEŹNIK');
  const [w, h] = measureText('KWIATY');
  assert.equal(w, 6 * GLYPH_W + 5); // 6 glyphs + 5 gaps
  assert.equal(h, GLYPH_H);
  for (const text of ['KWIATY', 'RZEŹNIK', 'SKLEP', 'ŁÓDŹ 24', 'ŻABKA', 'MIĘSO']) {
    const mask = renderTextMask(text);
    assert.ok(mask.data.some((v) => v === 1), `"${text}" renders pixels`);
  }
  // unknown characters fall back to '?', never throw
  const mask = renderTextMask('日本');
  assert.ok(mask.data.some((v) => v === 1));
});

// --- specs and layout ---

test('normalizeSpec canonicalizes text, colors and size', () => {
  const spec = normalizeSpec({ text: '  kwiaty ', fg: '#FFF', bg: 'e8a820', height: '2', width: '4.7' });
  assert.equal(spec.text, 'KWIATY');
  assert.equal(spec.fg, '#ffffff');
  assert.equal(spec.bg, '#e8a820');
  assert.equal(spec.height, 2);
  assert.equal(spec.width, 5);
  assert.equal(normalizeSpec({ text: 'X', bg: null }).bg, null);
  assert.equal(normalizeSpec({ text: 'X' }).width, null, 'width defaults to auto');
  assert.deepEqual(parseHexColor('#102030', null), [16, 32, 48]);
  assert.deepEqual(parseHexColor('junk', [1, 2, 3]), [1, 2, 3]);
});

test('signLayout scales text to the band and hugs auto width', () => {
  const one = signLayout(normalizeSpec({ text: 'KWIATY', height: 1 }));
  assert.equal(one.scale, 2); // 7px glyphs doubled fill a 16px band
  assert.deepEqual(one.span, [5, 1]); // 35px * 2 = 70px -> 5 cells
  const two = signLayout(normalizeSpec({ text: 'KWIATY', height: 2 }));
  assert.equal(two.span[1], 2);
  assert.ok(two.scale > one.scale, 'taller band, bigger letters');
  const fixed = signLayout(normalizeSpec({ text: 'KWIATY', height: 1, width: 3 }));
  assert.deepEqual(fixed.span, [3, 1]);
  assert.equal(fixed.scale, 1, 'fixed width shrinks the text to fit');
});

test('renderSignPixels paints fg text on bg with a rim, or on transparency', () => {
  const art = renderSignPixels({ text: 'A', fg: '#ffffff', bg: '#000080', height: 1 });
  assert.equal(art.width, TILE_SIZE);
  assert.equal(art.height, TILE_SIZE);
  const px = (x, y) => [...art.data.slice((y * art.width + x) * 4, (y * art.width + x) * 4 + 4)];
  assert.equal(px(0, 0)[3], 255, 'bg sign is fully opaque');
  const noBg = renderSignPixels({ text: 'A', fg: '#ffffff', bg: null, height: 1 });
  assert.equal(noBg.data[3], 0, 'transparent background outside the letters');
  assert.ok([...noBg.data].some((v, i) => i % 4 === 3 && v === 255), 'letters are opaque');
});

// --- runtime decal registration ---

test('createTextDecal registers a decal + runtime tile, idempotently', () => {
  const spec = { text: 'KWIATY', fg: '#181410', bg: '#e8a820', height: 1 };
  const a = createTextDecal(spec);
  assert.ok(a.id.startsWith('decal_text_'));
  assert.ok(isDecalId(a.id));
  assert.ok(isTextDecal(a.id));
  assert.ok(hasRuntimeTile(a.id));
  assert.deepEqual(getDecal(a.id).span, [5, 1]);
  assert.deepEqual(tileSpan(a.id), [5, 1]);
  assert.ok(listTileNames().includes(a.id));
  assert.ok(listTextDecalIds().includes(a.id));
  const pixels = generateTilePixels(a.id);
  assert.equal(pixels.length, 5 * TILE_SIZE * TILE_SIZE * 4);

  const b = createTextDecal(spec);
  assert.equal(b.id, a.id, 'same spec -> same decal');
  assert.equal(textDecalId(spec), a.id);
  assert.equal(textSpecOf(a.id).text, 'KWIATY');

  assert.equal(createTextDecal({ text: '   ' }), null, 'empty text refused');
});

test('atlas packs runtime sign tiles next to the static set', () => {
  const sign = createTextDecal({ text: 'RZEŹNIK', fg: '#ffffff', bg: '#7a1f1f', height: 2 });
  const { map } = renderAtlasRGBA(tilesForBlocks());
  assert.ok(map.has(sign.id), 'sign tile placed in the atlas');
  // every static + runtime tile got a slot (no "Atlas full" throw)
  for (const name of tilesForBlocks()) assert.ok(map.has(name), `tile ${name} packed`);
});

// --- persistence ---

test('text sign decals survive a save/load round-trip', () => {
  const sign = createTextDecal({ text: 'SKLEP 7', fg: '#ffffff', bg: '#20406a', height: 1 });
  const world = new World();
  for (let x = 0; x < 6; x++) world.place('panel', SIZE.SMALL, x, 0, 0);
  assert.ok(world.placeDecal(sign.id, 0, 0, 0, 'pz', 0));
  world.placeDecal('decal_crack', 5, 0, 0, 'pz', 0);

  const json = serialize(world);
  const data = JSON.parse(json);
  assert.equal(data.textDecals.length, 1, 'only the placed sign spec is written');
  assert.equal(data.textDecals[0].id, sign.id);
  assert.equal(data.textDecals[0].text, 'SKLEP 7');

  const { world: loaded, errors } = deserialize(json);
  assert.deepEqual(errors, []);
  assert.equal(loaded.decalAt(0, 0, 0, 'pz').decalId, sign.id);
  assert.equal(textSpecOf(sign.id).bg, '#20406a');
  assert.equal(serialize(loaded), json, 'round-trip is stable');
});

test('maps without signs stay free of the textDecals field', () => {
  const world = new World();
  world.place('brick', SIZE.SMALL, 0, 0, 0);
  world.placeDecal('decal_crack', 0, 0, 0, 'py', 0);
  assert.ok(!('textDecals' in JSON.parse(serialize(world))));
});

test('malformed text decal entries are skipped with an error', () => {
  const base = JSON.parse(serialize(new World()));
  base.textDecals = [{ id: 'decal_text_ok?!', text: 'X' }, { id: 'decal_text_abc' }];
  const { errors } = deserialize(JSON.stringify(base));
  assert.equal(errors.length, 2);
});

// --- new blocks ---

test('new estate blocks are registered with atlas tiles', () => {
  const ids = ['plaster_yellow', 'plaster_orange', 'plaster_green', 'plaster_blue',
    'brick_yellow', 'papa', 'garage_brown', 'garage_green', 'garage_red',
    'window_white', 'balcony_rail', 'door_steel'];
  for (const id of ids) {
    const def = getBlock(id);
    assert.ok(def, `block ${id} registered`);
    const tile = tileFor(id, 'px');
    assert.ok(listTileNames().includes(tile), `tile ${tile} generated`);
    generateTilePixels(tile); // must not throw
  }
  assert.equal(shapeFor('balcony_rail'), 'pane');
  assert.equal(shapeFor('door_steel'), 'door');
  assert.equal(getBlock('door_steel').doorOpen, 'door_steel_open');
  assert.equal(getBlock('door_steel_open').doorClosed, 'door_steel');
  assert.ok(getBlock('window_white').transparent);
});
