import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SLOT_COUNT, readSlot, writeSlot, hasSlot, listSlots, makeSlot, slotKey } from '../src/game/SaveSlots.js';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

test('slots start empty and can be written/read round-trip', () => {
  const storage = fakeStorage();
  assert.equal(SLOT_COUNT, 3);
  for (let i = 0; i < SLOT_COUNT; i++) {
    assert.equal(readSlot(i, storage), null);
    assert.equal(hasSlot(i, storage), false);
  }
  const slot = makeSlot({ bundle: '{"b":1}', player: { x: 1, y: 2, z: 3, yaw: 0, pitch: 0 } });
  assert.equal(writeSlot(1, slot, storage), true);
  const read = readSlot(1, storage);
  assert.equal(read.bundle, '{"b":1}');
  assert.deepEqual(read.player, { x: 1, y: 2, z: 3, yaw: 0, pitch: 0 });
  assert.equal(hasSlot(1, storage), true);
});

test('each slot is independent', () => {
  const storage = fakeStorage();
  writeSlot(0, makeSlot({ bundle: 'a', player: null }), storage);
  assert.equal(readSlot(1, storage), null);
  assert.equal(readSlot(2, storage), null);
  assert.equal(readSlot(0, storage).bundle, 'a');
});

test('corrupt slot data reads as empty', () => {
  const storage = fakeStorage();
  storage.setItem(slotKey(2), 'not json{');
  assert.equal(readSlot(2, storage), null);
  assert.equal(hasSlot(2, storage), false);
});

test('listSlots returns one entry per slot in order', () => {
  const storage = fakeStorage();
  writeSlot(0, makeSlot({ bundle: 'a', player: null }), storage);
  writeSlot(2, makeSlot({ bundle: 'c', player: null }), storage);
  const slots = listSlots(storage);
  assert.equal(slots.length, SLOT_COUNT);
  assert.equal(slots[0].bundle, 'a');
  assert.equal(slots[1], null);
  assert.equal(slots[2].bundle, 'c');
});

test('writeSlot returns false without storage', () => {
  assert.equal(writeSlot(0, { bundle: 'x' }, null), false);
});
