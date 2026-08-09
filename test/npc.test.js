// npc.test.js — NPC placement (floor snapping) and talk-range detection.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { NPCManager, NPC_TYPES, getNpcType, TALK_RANGE, TALK_FACING_DOT } from '../src/game/NPC.js';
import { MOB_SKINS } from '../src/game/mobSprites.js';
import { CELL_SIZE } from '../src/engine/Space.js';

/** Floor of BIG voxels spanning cells 0..7 at y=0 (top surface = cell y=2). */
function floorWorld() {
  const w = new World();
  for (let x = 0; x < 8; x += 2) {
    for (let z = 0; z < 8; z += 2) w.place('grass', SIZE.BIG, x, 0, z);
  }
  return w;
}

/** Renderer stub matching the MobRenderer surface NPCManager uses. */
function fakeRenderer() {
  return {
    added: [],
    addMob(m) { this.added.push(m); },
    removeMob() {},
    update() {},
    clear() { this.added = []; },
  };
}

function makeManager(world) {
  const renderer = fakeRenderer();
  const manager = new NPCManager({ world, renderer });
  return { manager, renderer };
}

test('granny type exists and wears a real character sheet', () => {
  const granny = getNpcType('granny');
  assert.ok(granny);
  assert.ok(MOB_SKINS.includes(granny.skin), 'skin must be a drawn character');
  assert.ok(granny.dialog.length >= 2, 'has some chit chat');
});

test('bolek type exists and wears a real character sheet', () => {
  const bolek = getNpcType('bolek');
  assert.ok(bolek);
  assert.ok(MOB_SKINS.includes(bolek.skin), 'skin must be a drawn character');
  assert.ok(bolek.dialog.length >= 2, 'has some chit chat');
});

test('rebuild snaps an NPC onto the walkable floor', () => {
  const world = floorWorld();
  const { manager, renderer } = makeManager(world);
  manager.rebuild([{ type: 'granny', cell: [2, 2, 2] }]);
  assert.equal(manager.npcs.length, 1);
  const npc = manager.npcs[0];
  assert.equal(npc.pos.y, 2 * CELL_SIZE, 'feet sit on the floor surface');
  assert.equal(npc.pos.x, 2 * CELL_SIZE + CELL_SIZE / 2, 'centered in its cell');
  assert.equal(npc.animName, 'idle');
  assert.deepEqual(renderer.added, [npc], 'billboard attached');
});

test('a spawn cell inside the floor still finds standable feet nearby', () => {
  const world = floorWorld();
  const { manager } = makeManager(world);
  manager.rebuild([{ type: 'granny', cell: [2, 0, 2] }]); // buried in the floor
  assert.equal(manager.npcs.length, 1);
  assert.equal(manager.npcs[0].pos.y, 2 * CELL_SIZE);
});

test('a spawn with no floor anywhere near is skipped', () => {
  const world = new World(); // empty — nothing to stand on
  const { manager } = makeManager(world);
  manager.rebuild([{ type: 'granny', cell: [2, 2, 2], radius: 3 }]);
  assert.equal(manager.npcs.length, 0);
});

test('unknown NPC types are ignored', () => {
  const world = floorWorld();
  const { manager } = makeManager(world);
  manager.rebuild([{ type: 'mailman', cell: [2, 2, 2] }]);
  assert.equal(manager.npcs.length, 0);
});

test('nearest() only offers a talk within range and on the same floor', () => {
  const world = floorWorld();
  const { manager } = makeManager(world);
  manager.rebuild([{ type: 'granny', cell: [2, 2, 2] }]);
  const npc = manager.npcs[0];

  const close = { x: npc.pos.x + 1, y: npc.pos.y, z: npc.pos.z };
  assert.equal(manager.nearest(close), npc);

  const far = { x: npc.pos.x + TALK_RANGE + 1, y: npc.pos.y, z: npc.pos.z };
  assert.equal(manager.nearest(far), null);

  const upstairs = { x: npc.pos.x + 1, y: npc.pos.y + 3, z: npc.pos.z };
  assert.equal(manager.nearest(upstairs), null, 'no chatting through the ceiling');
});

test('nearest() ignores facing when none is given (back-compat)', () => {
  const world = floorWorld();
  const { manager } = makeManager(world);
  manager.rebuild([{ type: 'granny', cell: [2, 2, 2] }]);
  const npc = manager.npcs[0];
  const behind = { x: npc.pos.x - 1, y: npc.pos.y, z: npc.pos.z };
  assert.equal(manager.nearest(behind), npc);
});

test('nearest() requires the player to be facing the NPC when a facing is given', () => {
  const world = floorWorld();
  const { manager } = makeManager(world);
  manager.rebuild([{ type: 'granny', cell: [2, 2, 2] }]);
  const npc = manager.npcs[0];

  // Player stands just -x of the NPC, looking toward +x (straight at it).
  const player = { x: npc.pos.x - 1, y: npc.pos.y, z: npc.pos.z };
  assert.equal(manager.nearest(player, { x: 1, z: 0 }), npc, 'looking straight at the NPC talks');

  // Same spot, but the player is looking the other way (back turned).
  assert.equal(manager.nearest(player, { x: -1, z: 0 }), null, 'back turned does not talk');

  // Looking off to the side, beyond the facing cone.
  assert.equal(manager.nearest(player, { x: 0, z: 1 }), null, 'looking away sideways does not talk');
});

test('TALK_FACING_DOT allows a generous but not unlimited cone', () => {
  const world = floorWorld();
  const { manager } = makeManager(world);
  manager.rebuild([{ type: 'granny', cell: [2, 2, 2] }]);
  const npc = manager.npcs[0];
  const player = { x: npc.pos.x - 1, y: npc.pos.y, z: npc.pos.z };

  // The vector to the NPC is +x, so the dot product is just facing.x. A
  // facing just inside the cone (dot slightly above threshold) still talks.
  const inConeX = TALK_FACING_DOT + 0.05;
  const inCone = { x: inConeX, z: Math.sqrt(1 - inConeX ** 2) };
  assert.equal(manager.nearest(player, inCone), npc);

  // A facing just outside the cone (dot slightly below threshold) does not.
  const outConeX = TALK_FACING_DOT - 0.05;
  const outCone = { x: outConeX, z: Math.sqrt(1 - outConeX ** 2) };
  assert.equal(manager.nearest(player, outCone), null);
});

test('rebuild clears previous NPCs', () => {
  const world = floorWorld();
  const { manager, renderer } = makeManager(world);
  manager.rebuild([{ type: 'granny', cell: [2, 2, 2] }]);
  manager.rebuild([{ type: 'granny', cell: [4, 2, 4] }]);
  assert.equal(manager.npcs.length, 1);
  assert.equal(renderer.added.length, 1, 'renderer was cleared between rebuilds');
});

test('every NPC type dialog is non-empty strings', () => {
  for (const type of Object.values(NPC_TYPES)) {
    assert.ok(type.dialog.length > 0);
    for (const line of type.dialog) {
      assert.equal(typeof line, 'string');
      assert.ok(line.length > 0);
    }
  }
});
