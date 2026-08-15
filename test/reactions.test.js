// reactions.test.js — the action/reaction system: game flags, quest-authored
// flag lists, and world objects (flag-gated doors) reacting to them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GameFlags, applyFlagList, bindWorldReactions } from '../src/game/Reactions.js';
import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { isDoorLocked, setDoorLocked, isDoorVoxel, doorHinge } from '../src/engine/Doors.js';
import { normalizeQuest, normalizeQuestFlags } from '../src/engine/QuestRegistry.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';
import { serializePrefab, deserializePrefab } from '../src/persistence/PrefabSerializer.js';
import { stampPrefab } from '../src/engine/PrefabStamp.js';
import { QuestLog } from '../src/game/quests.js';

// --- GameFlags store ---

test('flags default to false and fire listeners only on change', () => {
  const flags = new GameFlags();
  assert.equal(flags.get('nope'), false);

  const seen = [];
  flags.on('a', (v) => seen.push(v));
  assert.deepEqual(seen, [false], 'subscription catches up with the current value');

  assert.equal(flags.set('a', true), true);
  assert.equal(flags.set('a', true), false, 'no change, no event');
  assert.equal(flags.set('a', false), true);
  assert.deepEqual(seen, [false, true, false]);
});

test('a listener bound after the raise still hears about it (catch-up)', () => {
  const flags = new GameFlags();
  flags.set('opened');
  const seen = [];
  const off = flags.on('opened', (v) => seen.push(v));
  assert.deepEqual(seen, [true]);
  off();
  flags.set('opened', false);
  assert.deepEqual(seen, [true], 'unsubscribed listeners stay silent');
});

test('flags survive a serialize round-trip', () => {
  const flags = new GameFlags();
  flags.set('a');
  flags.set('b');
  flags.set('b', false);
  const back = GameFlags.deserialize(JSON.parse(JSON.stringify(flags.serialize())));
  assert.equal(back.get('a'), true);
  assert.equal(back.get('b'), false);
  // Older saves carry no flags — a fresh store, not a crash.
  assert.equal(GameFlags.deserialize(null).get('a'), false);
  assert.equal(GameFlags.deserialize({ raised: ['x', 7, ''] }).get('x'), true);
});

test('applyFlagList raises names and clears !names', () => {
  const flags = new GameFlags();
  flags.set('old');
  applyFlagList(flags, ['fresh', '!old']);
  assert.equal(flags.get('fresh'), true);
  assert.equal(flags.get('old'), false);
  applyFlagList(flags, null); // tolerated: quests without flags
});

// --- doors as reaction consumers ---

/** A locked door gated by `flag`, in a fresh world. */
function flaggedDoorWorld(flag) {
  const world = new World();
  world.place('door_wood', SIZE.DOOR, 2, 0, 3, 0);
  const door = world.get(2, 0, 3);
  setDoorLocked(door, true);
  door.unlockFlag = flag;
  return { world, door };
}

test('raising a door\'s unlockFlag unlocks it; clearing locks it again', () => {
  const { world, door } = flaggedDoorWorld('cellar-open');
  const flags = new GameFlags();
  let unlocks = 0;
  bindWorldReactions(world, flags, { onDoorUnlock: () => unlocks++ });

  assert.equal(isDoorLocked(door), true, 'still locked after binding');
  flags.set('cellar-open');
  assert.equal(isDoorLocked(door), false);
  assert.equal(unlocks, 1);
  flags.set('cellar-open', false);
  assert.equal(isDoorLocked(door), true, 'the flag drives the lock both ways');
  assert.equal(unlocks, 1, 'locking is not an unlock event');
});

test('a door bound after its flag was raised settles unlocked (load order)', () => {
  const { world, door } = flaggedDoorWorld('cellar-open');
  const flags = new GameFlags();
  flags.set('cellar-open');
  let unlocks = 0;
  bindWorldReactions(world, flags, { onDoorUnlock: () => unlocks++ });
  assert.equal(isDoorLocked(door), false);
  assert.equal(unlocks, 1);
});

test('unbinding stops the reactions', () => {
  const { world, door } = flaggedDoorWorld('cellar-open');
  const flags = new GameFlags();
  const unbind = bindWorldReactions(world, flags);
  unbind();
  flags.set('cellar-open');
  assert.equal(isDoorLocked(door), true);
});

test('doors without a flag, and non-doors, are left alone', () => {
  const world = new World();
  world.place('door_wood', SIZE.DOOR, 2, 0, 3, 0);
  world.place('brick', SIZE.SMALL, 0, 0, 0);
  setDoorLocked(world.get(2, 0, 3), true);
  const flags = new GameFlags();
  bindWorldReactions(world, flags);
  flags.set('anything');
  assert.equal(isDoorLocked(world.get(2, 0, 3)), true);
});

// --- quests as flag producers ---

test('normalizeQuest keeps a cleaned flags field', () => {
  const q = normalizeQuest({
    id: 'q1',
    objective: { type: 'kill', target: 'any', count: 1, noun: 'Zombies' },
    flags: { accept: ' cellar-open , !dark ', complete: ['done-flag', '', 3] },
  }, 'granny');
  assert.deepEqual(q.flags, { accept: ['cellar-open', '!dark'], complete: ['done-flag'] });

  const bare = normalizeQuest({ id: 'q2', objective: { type: 'kill', count: 1 } }, 'granny');
  assert.equal('flags' in bare, false, 'no flags authored, none stored');
  assert.equal(normalizeQuestFlags({ accept: [], complete: '' }), null);
});

test('accepting a flagged quest unlocks the door it gates (the whole chain)', () => {
  const { world, door } = flaggedDoorWorld('cellar-open');
  const flags = new GameFlags();
  bindWorldReactions(world, flags);

  const quests = new QuestLog({
    granny: [normalizeQuest({
      id: 'q1',
      objective: { type: 'kill', target: 'any', count: 1, noun: 'Zombies' },
      flags: { accept: ['cellar-open'] },
    }, 'granny')],
  });

  assert.equal(isDoorLocked(door), true);
  const result = quests.accept('granny');
  applyFlagList(flags, result.accepted.flags?.accept); // what GameApp does on accept
  assert.equal(isDoorLocked(door), false, 'accepting the quest opened the way');
});

// --- persistence of the door's unlockFlag ---

test('unlockFlag survives the world save format', () => {
  const { world } = flaggedDoorWorld('cellar-open');
  const { world: back, errors } = deserialize(serialize(world));
  assert.deepEqual(errors, []);
  const door = back.get(2, 0, 3);
  assert.equal(door.unlockFlag, 'cellar-open');
  assert.equal(isDoorLocked(door), true);
  // Doors without the field stay clean after a round-trip.
  delete world.get(2, 0, 3).unlockFlag;
  const again = deserialize(serialize(world)).world.get(2, 0, 3);
  assert.equal('unlockFlag' in again, false);
});

test('unlockFlag rides prefabs through save, load and stamping', () => {
  const source = new World();
  source.place('door_wood', SIZE.DOOR, 0, 0, 0, 0);
  const door = source.get(0, 0, 0);
  setDoorLocked(door, true);
  door.unlockFlag = 'vault-open';

  const { prefab } = serializePrefab(source, { id: 'p', name: 'P', dims: [4, 4, 4] });
  assert.equal(prefab.blocks[0].unlockFlag, 'vault-open');
  const { prefab: reloaded } = deserializePrefab(JSON.stringify(prefab));

  const target = new World();
  stampPrefab(target, reloaded, [10, 0, 10], 1);
  let stamped = null;
  target.forEachVoxel((v) => {
    if (isDoorVoxel(v)) stamped = v;
  });
  assert.ok(stamped, 'the door landed');
  assert.equal(stamped.unlockFlag, 'vault-open');
  assert.ok(isDoorLocked(stamped));
  assert.equal(doorHinge(stamped), 'left');
});
