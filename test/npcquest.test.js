// npcquest.test.js — NPC/quest registries, world NPC spawns (serialize +
// bundle round-trips) and the editor's NpcTool.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as THREE from '../vendor/three.module.js';
import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { CELL_SIZE } from '../src/engine/Space.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';
import { serializeBundle, deserializeBundle } from '../src/persistence/WorldBundle.js';
import {
  BUILTIN_NPCS, resetNpcRegistry, registerNpc, getNpc, isNpcId, listNpcs, removeNpc,
  serializeNpcRegistry, deserializeNpcRegistry, normalizeNpc,
} from '../src/engine/NpcRegistry.js';
import {
  BUILTIN_QUESTLINES, resetQuestRegistry, setQuestline, getQuestline, getQuestlines,
  serializeQuestRegistry, deserializeQuestRegistry, normalizeQuest,
} from '../src/engine/QuestRegistry.js';
import { QuestLog } from '../src/game/quests.js';
import { registerBuiltinQuestItems } from '../src/engine/QuestItems.js';
import {
  getEquipItem, clearEquipItems, normalizeKind,
  serializeEquipRegistry, deserializeEquipRegistry,
} from '../src/engine/EquipmentRegistry.js';
import { NpcTool } from '../src/editor/tools/NpcTool.js';
import { SelectionGhost } from '../src/editor/SelectionGhost.js';
import { EditorState } from '../src/editor/EditorState.js';
import { History } from '../src/editor/History.js';

function fresh() {
  resetNpcRegistry();
  resetQuestRegistry();
}

// --- NPC registry ---

test('the granny ships as a built-in NPC', () => {
  fresh();
  assert.ok(isNpcId('granny'));
  assert.equal(getNpc('granny').name, 'Granny');
  assert.ok(BUILTIN_NPCS.granny.dialog.length >= 2);
});

test('bolek — the player’s father — ships as a built-in NPC', () => {
  fresh();
  assert.ok(isNpcId('bolek'));
  const bolek = getNpc('bolek');
  assert.equal(bolek.name, 'Bolek');
  assert.equal(bolek.skin, 'bolek', 'wears his own wheelchair sheet');
  assert.ok(bolek.height < BUILTIN_NPCS.granny.height, 'seated, so shorter than the granny');
  assert.ok(bolek.dialog.length >= 2);
  assert.ok(bolek.topics.length >= 1);
});

test('registerNpc normalizes and rejects bad ids', () => {
  fresh();
  assert.equal(registerNpc({ id: 'Bad Id!' }), null);
  assert.equal(normalizeNpc(null), null);
  const def = registerNpc({ id: 'doc', name: '  Doc  ', skin: 'granny', height: 99, dialog: ['hi', '  ', 'there'] });
  assert.equal(def.name, 'Doc');
  assert.ok(def.height <= 2.2, 'height clamped');
  assert.deepEqual(def.dialog, ['hi', 'there']);
  assert.ok(isNpcId('doc'));
});

test('services normalize: unknown types drop, labels default, flags trim', () => {
  fresh();
  const def = registerNpc({
    id: 'smith',
    name: 'Smith',
    skin: 'granny',
    dialog: ['hi'],
    services: [
      { type: 'repair', label: '  ', flag: ' workshop-open ' },
      { type: 'teleport', label: 'Beam me up' }, // not a thing (yet)
      'garbage',
    ],
  });
  assert.deepEqual(def.services, [{ type: 'repair', label: 'Could you fix up my gear?', flag: 'workshop-open' }]);

  const ungated = registerNpc({ id: 'fixer', skin: 'granny', dialog: ['hi'], services: [{ type: 'repair', label: 'Fix it?' }] });
  assert.deepEqual(ungated.services, [{ type: 'repair', label: 'Fix it?' }], 'no flag field when ungated');

  const none = registerNpc({ id: 'plain', skin: 'granny', dialog: ['hi'], services: [] });
  assert.ok(!('services' in none), 'empty services stay off the def');
});

test('services survive the registry round-trip', () => {
  fresh();
  registerNpc({ id: 'smith', skin: 'granny', dialog: ['hi'], services: [{ type: 'repair', flag: 'workshop-open' }] });
  const text = serializeNpcRegistry();
  fresh();
  deserializeNpcRegistry(text);
  assert.deepEqual(getNpc('smith').services, [{ type: 'repair', label: 'Could you fix up my gear?', flag: 'workshop-open' }]);
});

test('NPC registry round-trips, and deletion is authoritative', () => {
  fresh();
  registerNpc({ id: 'doc', name: 'Doc', skin: 'granny', height: 1.7, dialog: ['hi'] });
  removeNpc('granny');
  const text = serializeNpcRegistry();

  fresh(); // granny is back...
  assert.ok(isNpcId('granny'));
  deserializeNpcRegistry(text);
  assert.ok(!isNpcId('granny'), '...but the saved roster wins on load');
  assert.ok(isNpcId('doc'));
  assert.ok(isNpcId('bolek'), 'the untouched built-in rode along in the roster');
  assert.equal(listNpcs().length, 2);
});

// --- quest registry ---

test('the granny questline ships built in', () => {
  fresh();
  assert.ok(getQuestline('granny').length >= 3);
  assert.equal(BUILTIN_QUESTLINES.granny.length, getQuestline('granny').length);
});

test('bolek’s questline opens with the trip downstairs', () => {
  fresh();
  const [first] = getQuestline('bolek');
  assert.equal(first.id, 'bolek-downstairs');
  assert.equal(first.objectives[0].type, 'kill');
  assert.equal(first.objectives[0].count, 1);
  assert.ok(first.offer.some((l) => l.includes('baseball bat')), 'dad reminds the player to take the bat');

  // The line plays through: accept, put down what's downstairs, turn in.
  const log = new QuestLog();
  assert.equal(log.statusFor('bolek'), 'available');
  log.accept('bolek');
  const [event] = log.onKill('zombie');
  assert.equal(event.ready, true, 'one kill fulfills the look-see');
  const { reward } = log.complete('bolek');
  assert.equal(reward.health, 25);
  assert.equal(log.statusFor('bolek'), 'available', 'the stairwell tier unlocks');
  assert.equal(log.questFor('bolek').id, 'bolek-stairwell');
});

test('normalizeQuest fills defaults and drops garbage', () => {
  fresh();
  assert.equal(normalizeQuest({ title: 'no id' }, 'granny'), null);
  assert.equal(normalizeQuest({ id: 'q' }, ''), null);
  const q = normalizeQuest({ id: 'q1', objective: { type: 'collect', kinds: ['ammo'], count: '4' }, reward: { armor: '10', ammo: { type: 'nope', amount: 5 } } }, 'doc');
  assert.equal(q.objectives[0].count, 4, 'legacy single `objective` folds into the objectives array');
  assert.deepEqual(q.reward, { armor: 10 }, 'unknown ammo type dropped');
  assert.ok(q.offer.length && q.ready.length && q.progressLine.includes('{count}'));
});

test('normalizeQuest keeps item rewards and drops empty ones', () => {
  fresh();
  const q = normalizeQuest({ id: 'q1', reward: { items: ['medkit', ' shotgun ', '', 3] } }, 'doc');
  assert.deepEqual(q.reward, { items: ['medkit', 'shotgun'] }, 'ids trimmed, blanks and non-strings dropped');
  const none = normalizeQuest({ id: 'q2', reward: { items: [] } }, 'doc');
  assert.equal(none.reward, null, 'no grants at all -> null reward');
});

test('quest registry round-trips authored questlines', () => {
  fresh();
  setQuestline('doc', [{ id: 'doc-1', title: 'Checkup', objective: { type: 'kill', count: 2 } }]);
  const text = serializeQuestRegistry();

  fresh();
  deserializeQuestRegistry(text);
  assert.equal(getQuestline('doc').length, 1);
  assert.equal(getQuestline('doc')[0].title, 'Checkup');
  assert.ok(getQuestline('granny').length >= 3, 'granny line survived the round-trip');
});

test('QuestLog picks up authored questlines from the registry', () => {
  fresh();
  registerNpc({ id: 'doc', name: 'Doc', skin: 'granny', height: 1.7, dialog: ['hi'] });
  setQuestline('doc', [{ id: 'doc-1', title: 'Checkup', objective: { type: 'kill', count: 1, noun: 'zombies' } }]);
  const log = new QuestLog();
  assert.equal(log.statusFor('doc'), 'available');
  assert.equal(log.questFor('doc').id, 'doc-1');
  fresh();
});

// --- world NPC spawns + serialization ---

test('NPC spawns round-trip through the map serializer', () => {
  fresh();
  const world = new World();
  world.place('grass', SIZE.BIG, 0, 0, 0);
  assert.ok(world.addNpcSpawn('granny', 1, 2, 1));
  assert.ok(!world.addNpcSpawn('granny', 1, 2, 1), 'duplicate rejected');

  const { world: loaded, errors } = deserialize(serialize(world));
  assert.deepEqual(errors, []);
  assert.deepEqual(loaded.npcSpawnAt(1, 2, 1), { type: 'granny', x: 1, y: 2, z: 1 });
});

test('unregistered NPC spawn types are skipped with an error', () => {
  fresh();
  const world = new World();
  world.place('grass', SIZE.BIG, 0, 0, 0);
  world.addNpcSpawn('granny', 1, 2, 1);
  const text = serialize(world);
  removeNpc('granny');
  const { world: loaded, errors } = deserialize(text);
  assert.equal(loaded.npcSpawnAt(1, 2, 1), null);
  assert.ok(errors.some((e) => e.includes('granny')));
  fresh();
});

test('maps without NPC spawns omit the field entirely', () => {
  const world = new World();
  world.place('grass', SIZE.SMALL, 0, 0, 0);
  assert.ok(!JSON.parse(serialize(world)).npcs);
});

test('copyFrom and clear carry/drop NPC spawns', () => {
  const a = new World();
  a.addNpcSpawn('granny', 3, 1, 3);
  const b = new World();
  b.copyFrom(a);
  assert.ok(b.npcSpawnAt(3, 1, 3));
  b.clear();
  assert.equal(b.npcSpawnAt(3, 1, 3), null);
});

test('bundles carry the NPC and quest registries with the map', () => {
  fresh();
  registerNpc({ id: 'doc', name: 'Doc', skin: 'granny', height: 1.7, dialog: ['hi'] });
  setQuestline('doc', [{ id: 'doc-1', title: 'Checkup', objective: { type: 'kill', count: 2 } }]);
  const world = new World();
  world.place('grass', SIZE.BIG, 0, 0, 0);
  world.addNpcSpawn('doc', 1, 2, 1);
  const text = serializeBundle(world);

  fresh(); // wipe the authored data — the bundle must restore it
  const { world: loaded, errors } = deserializeBundle(text);
  assert.deepEqual(errors, []);
  assert.ok(isNpcId('doc'), 'bundle registered the authored NPC');
  assert.equal(getQuestlines().doc.length, 1, 'bundle registered the questline');
  assert.deepEqual(loaded.npcSpawnAt(1, 2, 1), { type: 'doc', x: 1, y: 2, z: 1 });
  fresh();
});

// --- quest items (fetch quests) ---

test('built-in quest items register with kind quest and survive a registry round-trip', () => {
  clearEquipItems();
  registerBuiltinQuestItems();
  const teapot = getEquipItem('granny-teapot');
  assert.ok(teapot, 'teapot registered');
  assert.equal(teapot.kind, 'quest');
  assert.ok(teapot.microVoxels.length > 10, 'teapot has voxel art');

  deserializeEquipRegistry(serializeEquipRegistry());
  assert.equal(getEquipItem('granny-teapot').kind, 'quest', 'kind survives the round-trip');
  clearEquipItems();
});

test('normalizeKind accepts quest', () => {
  assert.equal(normalizeKind('quest'), 'quest');
  assert.equal(normalizeKind('junk'), 'weapon');
});

test('the granny questline opens with the teapot fetch', () => {
  fresh();
  const [first] = getQuestline('granny');
  assert.equal(first.id, 'granny-teapot');
  assert.equal(first.objectives[0].type, 'collect');
  assert.deepEqual(first.objectives[0].ids, ['granny-teapot']);
});

test('wantsItem gates quest items to their active quest only', () => {
  fresh();
  const log = new QuestLog();
  const teapot = { id: 'granny-teapot', kind: 'quest' };

  assert.equal(log.wantsItem(teapot), false, 'not pickable before the quest is accepted');

  log.accept('granny'); // accept the teapot fetch
  assert.equal(log.wantsItem(teapot), true, 'pickable while the fetch is active');
  assert.equal(log.wantsItem({ id: 'other-relic', kind: 'quest' }), false, 'only the wanted item');

  log.onCollect(teapot); // objective fulfilled -> quest ready
  assert.equal(log.wantsItem(teapot), false, 'inert again once the objective is met');
  fresh();
});

// --- slay-pack spawn points ---

test('kill objectives keep a valid spawnCell and drop malformed ones', () => {
  fresh();
  const q = normalizeQuest({ id: 'q', objective: { type: 'kill', count: 3, spawnCell: [4.2, 2, -1] } }, 'granny');
  assert.deepEqual(q.objectives[0].spawnCell, [4, 2, -1], 'rounded to cells');
  const bad = normalizeQuest({ id: 'q', objective: { type: 'kill', count: 3, spawnCell: [1, 'x', 3] } }, 'granny');
  assert.ok(!('spawnCell' in bad.objectives[0]), 'malformed spawn dropped');
  const roundTrip = normalizeQuest(q, 'granny');
  assert.deepEqual(roundTrip.objectives[0].spawnCell, [4, 2, -1], 'survives re-normalization');
});

test('spawnCell survives the quest registry round-trip', () => {
  fresh();
  setQuestline('doc', [{ id: 'doc-1', title: 'Cull', objective: { type: 'kill', count: 4, spawnCell: [10, 2, 10] } }]);
  deserializeQuestRegistry(serializeQuestRegistry());
  assert.deepEqual(getQuestline('doc')[0].objectives[0].spawnCell, [10, 2, 10]);
  fresh();
});

// --- visit objectives + multi-goal + chain flags (registry side) ---

test('visit objectives normalize their marked cells and drop malformed ones', () => {
  fresh();
  const q = normalizeQuest({
    id: 'q',
    objective: { type: 'visit', cells: [[1.4, 2, 3], [1, 'x', 3], 'junk', [5, 0, -2.6]], noun: '  cellar  ' },
  }, 'granny');
  const o = q.objectives[0];
  assert.equal(o.type, 'visit');
  assert.equal(o.count, 1, 'visit count is always 1');
  assert.deepEqual(o.cells, [[1, 2, 3], [5, 0, -3]], 'cells rounded, malformed entries dropped');
  assert.equal(o.noun, 'cellar');
});

test('multi-goal tiers and chain flags survive the registry round-trip', () => {
  fresh();
  setQuestline('doc', [{
    id: 'doc-1',
    title: 'Chain Opener',
    autoAccept: true,
    autoComplete: true,
    objectives: [
      { type: 'visit', cells: [[4, 2, 4]], noun: 'room entered' },
      { type: 'kill', target: 'any', count: 3, noun: 'zombies' },
    ],
  }]);
  deserializeQuestRegistry(serializeQuestRegistry());
  const [q] = getQuestline('doc');
  assert.equal(q.autoAccept, true);
  assert.equal(q.autoComplete, true);
  assert.equal(q.objectives.length, 2);
  assert.deepEqual(q.objectives[0].cells, [[4, 2, 4]]);
  assert.equal(q.objectives[1].count, 3);
  fresh();
});

test('chain flags default to absent (not false) so authored JSON stays lean', () => {
  fresh();
  const q = normalizeQuest({ id: 'q', objective: { type: 'kill', count: 1 } }, 'granny');
  assert.ok(!('autoAccept' in q) && !('autoComplete' in q));
});

test('MobManager.spawnAt stands a pack on the floor around the cell', async () => {
  const { MobManager } = await import('../src/game/MobManager.js');
  const world = new World();
  for (let x = 0; x < 8; x += 2) {
    for (let z = 0; z < 8; z += 2) world.place('grass', SIZE.BIG, x, 0, z);
  }
  const renderer = { added: [], addMob(m) { this.added.push(m); }, removeMob() {}, update() {}, clear() { this.added = []; } };
  const mgr = new MobManager({ world, onDamagePlayer: () => {}, renderer });
  const spawned = mgr.spawnAt('imp', [4, 2, 4], 3);
  assert.equal(spawned, 3);
  assert.equal(mgr.mobs.length, 3);
  assert.equal(renderer.added.length, 3);
  for (const mob of mgr.mobs) {
    assert.ok(mob.valid);
    assert.equal(mob.pos.y, 2 * CELL_SIZE, 'feet on the floor');
  }
  const positions = new Set(mgr.mobs.map((m) => `${m.pos.x},${m.pos.z}`));
  assert.ok(positions.size > 1, 'pack fans out instead of stacking');
  assert.equal(mgr.spawnAt('nope', [4, 2, 4], 2), 0, 'unknown type spawns nothing');
  assert.equal(mgr.spawnAt('imp', [100, 2, 100], 2), 0, 'no floor anywhere near = nothing');
});

test('activeQuests reports active quests with progress', () => {
  fresh();
  const log = new QuestLog();
  assert.deepEqual(log.activeQuests(), []);
  log.accept('granny'); // accept the teapot fetch
  const active = log.activeQuests();
  assert.equal(active.length, 1);
  assert.equal(active[0].quest.id, 'granny-teapot');
  assert.deepEqual(active[0].progress, [0], 'one progress slot per objective');
  fresh();
});

// --- editor NpcTool ---

function makeNpcTool() {
  fresh();
  const world = new World();
  world.place('grass', SIZE.SMALL, 0, 0, 0);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.25, 2, 0.25);
  camera.lookAt(0.25, 0, 0.25); // straight down onto cell (0,0,0)
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ blockId: 'grass', size: SIZE.SMALL });
  const history = new History();
  const tool = new NpcTool({ THREE, world, camera, ghost, state, history, input: { isDown: () => false } });
  return { world, tool, history };
}

test('NPC tool places a spawn at the hovered face and removes it with RMB', () => {
  const { world, tool } = makeNpcTool();
  tool.onMouseDown(0);
  assert.deepEqual(world.npcSpawnAt(0, 1, 0), { type: 'bolek', x: 0, y: 1, z: 0 });
  assert.equal(world.get(0, 1, 0), null, 'NPC spawns are not voxels');
  tool.onMouseDown(0);
  assert.equal(world.npcSpawns.size, 1, 'duplicate rejected');
  tool.onMouseDown(2);
  assert.equal(world.npcSpawnAt(0, 1, 0), null);
});

test('NPC tool edits are undoable', () => {
  const { world, tool, history } = makeNpcTool();
  tool.onMouseDown(0);
  history.undo();
  assert.equal(world.npcSpawnAt(0, 1, 0), null);
  history.redo();
  assert.deepEqual(world.npcSpawnAt(0, 1, 0), { type: 'bolek', x: 0, y: 1, z: 0 });
});

test('NPC tool cycles through registered types, including authored ones', () => {
  const { tool } = makeNpcTool();
  registerNpc({ id: 'doc', name: 'Doc', skin: 'granny', height: 1.7, dialog: ['hi'] });
  const first = tool.typeId;
  const seen = new Set([first]);
  for (let i = 1; i < listNpcs().length; i++) {
    tool.cycleType();
    seen.add(tool.typeId);
  }
  assert.equal(seen.size, listNpcs().length, 'visits every registered type, authored included');
  tool.cycleType();
  assert.equal(tool.typeId, first, 'wraps around');
  fresh();
});
