// mob.test.js — Mob AI: aggro, chase, melee attack, damage/death, step climbing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { NavMesh } from '../src/engine/NavMesh.js';
import { Mob } from '../src/game/Mob.js';
import { frameFor } from '../src/game/MobRenderer.js';
import { FRAMES, FRAME_COUNT, MOB_SKINS, SPAWN_SKINS, randomMobSkin } from '../src/game/mobSprites.js';
import { getMob, randomMobHeight, MOB_HEIGHT_MIN, MOB_HEIGHT_MAX } from '../src/engine/mobTypes.js';
import { CELL_SIZE } from '../src/engine/Space.js';
import { collides } from '../src/engine/Physics.js';

/** Floor of BIG voxels spanning cells 0..7 at y=0 (top surface = cell y=2). */
function floorWorld() {
  const w = new World();
  for (let x = 0; x < 8; x += 2) {
    for (let z = 0; z < 8; z += 2) w.place('grass', SIZE.BIG, x, 0, z);
  }
  return w;
}

function makeMob(world, cx, cz, cy = 2) {
  const type = getMob('imp');
  const nav = new NavMesh(world, { halfWidth: type.halfWidth, height: type.height });
  const hits = [];
  const mob = new Mob({ type, spawnCell: [cx, cy, cz], world, nav, onDamagePlayer: (dmg, pos) => hits.push({ dmg, pos }) });
  return { mob, hits, nav };
}

test('spawns snapped onto the walkable surface', () => {
  const world = floorWorld();
  const { mob } = makeMob(world, 2, 2, 2);
  assert.ok(mob.valid);
  assert.equal(mob.pos.y, 2 * CELL_SIZE, 'feet sit on the floor surface');
  assert.equal(mob.pos.x, 2 * CELL_SIZE + CELL_SIZE / 2);
});

test('idle mob ignores a player outside aggro range', () => {
  const world = floorWorld();
  const { mob } = makeMob(world, 2, 2, 2);
  const player = { x: 50, y: 2 * CELL_SIZE, z: 50 };
  mob.update(0.1, player);
  assert.equal(mob.state, 'idle');
  assert.equal(mob.aggro, false);
  assert.equal(mob.animName, 'idle');
});

test('aggros on sight and chases the player', () => {
  const world = floorWorld();
  const { mob } = makeMob(world, 2, 2, 2);
  const player = { x: 10 * CELL_SIZE, y: 2 * CELL_SIZE, z: 2 * CELL_SIZE }; // ~3.7 m away
  mob.update(0.1, player);
  assert.equal(mob.aggro, true);
  assert.notEqual(mob.state, 'idle');
  // The player stands past the floor edge, so after pressing as close as the
  // navmesh allows the mob starts panic-juking (see mobevade.test.js) and may
  // end anywhere — assert on the closest approach, not the final position.
  const d0 = Math.hypot(player.x - mob.pos.x, player.z - mob.pos.z);
  let dMin = d0;
  for (let i = 0; i < 40; i++) {
    mob.update(0.1, player);
    dMin = Math.min(dMin, Math.hypot(player.x - mob.pos.x, player.z - mob.pos.z));
  }
  assert.ok(dMin < d0 - 0.05, `mob should close distance (${d0} -> ${dMin})`);
});

test('strikes the player when in reach with line of sight', () => {
  const world = floorWorld();
  const { mob, hits } = makeMob(world, 2, 2, 2);
  const player = { x: 2 * CELL_SIZE + CELL_SIZE / 2 + 0.7, y: 2 * CELL_SIZE, z: 2 * CELL_SIZE + CELL_SIZE / 2 };
  for (let i = 0; i < 40; i++) mob.update(0.1, player);
  assert.ok(hits.length >= 1, 'player took at least one hit');
  assert.equal(hits[0].dmg, getMob('imp').damage);
});

test('takes damage, flashes hurt, and dies when health runs out', () => {
  const world = floorWorld();
  const { mob } = makeMob(world, 2, 2, 2);
  const type = getMob('imp');
  assert.equal(mob.takeDamage(10), false);
  assert.equal(mob.health, type.health - 10);
  assert.equal(mob.hurtTimer > 0, true);
  assert.equal(mob.aggro, true);
  assert.equal(mob.takeDamage(type.health), true);
  assert.equal(mob.dead, true);
  assert.equal(mob.animName, 'dead');
  // Dead mobs don't move or attack.
  const player = { x: 2 * CELL_SIZE, y: 2 * CELL_SIZE, z: 2 * CELL_SIZE };
  const y0 = mob.pos.y;
  mob.update(0.1, player);
  assert.equal(mob.pos.y, y0);
});

test('a dead mob stops dealing damage', () => {
  const world = floorWorld();
  const { mob, hits } = makeMob(world, 2, 2, 2);
  mob.takeDamage(getMob('imp').health);
  const player = { x: mob.pos.x + 0.5, y: 2 * CELL_SIZE, z: mob.pos.z };
  for (let i = 0; i < 30; i++) mob.update(0.1, player);
  assert.equal(hits.length, 0);
});

test('a hit plays the hurt pose until the flash fades', () => {
  const world = floorWorld();
  const { mob } = makeMob(world, 2, 2, 2);
  const player = { x: 10 * CELL_SIZE, y: 2 * CELL_SIZE, z: 2 * CELL_SIZE };
  mob.update(0.1, player); // aggro + chase, so it has a normal animation
  assert.notEqual(mob.animName, 'hurt');
  mob.takeDamage(5);
  assert.equal(mob.animName, 'hurt', 'takeDamage must flinch into the hurt pose');
  // While the flash is active the update loop keeps the hurt pose overriding
  // whatever the state machine would have set.
  mob.update(0.05, player);
  assert.equal(mob.animName, 'hurt');
  // Once the flash expires, the mob returns to its normal animation.
  mob.hurtTimer = 0;
  mob.update(0.05, player);
  assert.notEqual(mob.animName, 'hurt');
});

test('melee hits flinch but never stop or shove a mob', () => {
  const world = floorWorld();
  const { mob } = makeMob(world, 2, 2, 2);
  mob.takeDamage(10, { x: 0, y: 0, z: 0 });
  assert.equal(mob.staggerTimer, 0, 'a melee hit must not stagger the mob');
  assert.equal(mob.knock.x, 0, 'a melee hit must not knock the mob back');
});

test('a gun hit staggers the mob, freezing its movement', () => {
  const world = floorWorld();
  const { mob } = makeMob(world, 2, 2, 2);
  const player = { x: 10 * CELL_SIZE, y: 2 * CELL_SIZE, z: 2 * CELL_SIZE };
  for (let i = 0; i < 10; i++) mob.update(0.1, player); // aggro + chase
  const p0 = { x: mob.pos.x, z: mob.pos.z };
  mob.takeDamage(5, player, { stagger: 0.3 });
  assert.ok(mob.staggerTimer > 0, 'a gun hit must stagger the mob');
  for (let i = 0; i < 5; i++) mob.update(0.05, player); // ~0.25 s of stagger
  assert.equal(mob.pos.x, p0.x, 'a staggered mob must not move');
  assert.equal(mob.pos.z, p0.z, 'a staggered mob must not move');
  assert.equal(mob.animName, 'hurt', 'a staggered mob plays the hurt pose');
  // Once the stagger ends it resumes the chase.
  for (let i = 0; i < 20; i++) mob.update(0.1, player);
  assert.notEqual(mob.pos.x, p0.x, 'the mob must resume moving after the stagger');
});

test('a powerful gun knocks a mob back along the shot', () => {
  const world = floorWorld();
  const { mob } = makeMob(world, 2, 2, 2);
  const player = { x: 10 * CELL_SIZE, y: 2 * CELL_SIZE, z: 2 * CELL_SIZE };
  const x0 = mob.pos.x;
  // A shot from the +x side shoves the light imp back toward -x during its
  // stagger (imp mass 1, knock -3 m/s).
  mob.takeDamage(20, player, { stagger: 0.3, knockX: -3, knockZ: 0 });
  for (let i = 0; i < 6; i++) mob.update(0.05, player); // the full stagger
  assert.ok(mob.pos.x < x0 - 0.05, `a powerful shot must shove the mob back (${x0} -> ${mob.pos.x})`);
});

test('heavy mobs resist knockback more than light ones', () => {
  const world = floorWorld();
  const imp = makeMob(world, 2, 2, 2).mob;
  const bruteType = getMob('brute');
  const nav = new NavMesh(world, { halfWidth: bruteType.halfWidth, height: bruteType.height });
  const brute = new Mob({ type: bruteType, spawnCell: [2, 2, 2], world, nav, onDamagePlayer: () => {} });
  const player = { x: 0, y: 2 * CELL_SIZE, z: 0 };

  const shove = (m) => {
    const x0 = m.pos.x;
    m.takeDamage(20, player, { stagger: 0.3, knockX: -3, knockZ: 0 });
    for (let i = 0; i < 6; i++) m.update(0.05, player);
    return x0 - m.pos.x;
  };
  const impPush = shove(imp);
  const brutePush = shove(brute);
  assert.ok(impPush > 0.1, `a light imp should be shoved back (${impPush} m)`);
  assert.ok(brutePush < impPush * 0.6, `a heavy brute should barely budge (imp ${impPush} m vs brute ${brutePush} m)`);
});

test('a gun hit interrupts a mob mid-attack and cancels the strike', () => {
  const world = floorWorld();
  const { mob, hits } = makeMob(world, 2, 2, 2);
  const player = { x: mob.pos.x + 0.7, y: 2 * CELL_SIZE, z: mob.pos.z };
  for (let i = 0; i < 10; i++) mob.update(0.1, player); // get into attack state
  assert.equal(mob.state, 'attack', 'the mob should be mid-attack');
  mob.attackTimer = 0.05; // a strike is about to land
  const before = hits.length;
  mob.takeDamage(10, player, { stagger: 0.3 });
  assert.equal(mob.state, 'chase', 'a gun hit must cancel an in-progress attack');
  assert.equal(mob.attackTimer, 0, 'the attack timer must reset');
  for (let i = 0; i < 6; i++) mob.update(0.05, player);
  assert.equal(hits.length, before, 'the cancelled strike must not land while staggered');
});

test('the hurt pose maps to the dedicated hurt sprite frames', () => {
  for (const t of [0, 0.05, 0.4, 1.7]) {
    assert.ok(FRAMES.hurt.includes(frameFor('hurt', t)), `hurt must select a hurt frame at t=${t}`);
  }
});

test('death plays the collapse once and holds on the corpse', () => {
  const [collapse, , corpse] = FRAMES.dead;
  assert.equal(frameFor('dead', 0), collapse, 'death starts on the collapse frame');
  assert.equal(frameFor('dead', 1.2), corpse, 'and settles on the corpse');
  assert.equal(frameFor('dead', 60), corpse, 'which it holds, rather than looping');
});

test('a spawned mob gets one of the drawn characters', () => {
  assert.ok(SPAWN_SKINS.length > 1, 'there must be characters to pick between');
  for (const skin of SPAWN_SKINS) assert.equal(typeof skin, 'string');

  // Every spawnable skin must be reachable, and none outside the pool — in
  // particular never an NPC-only sheet like Bolek's wheelchair.
  const seen = new Set();
  for (let i = 0; i < SPAWN_SKINS.length * 200; i++) {
    const skin = randomMobSkin();
    assert.ok(SPAWN_SKINS.includes(skin), `${skin} is not a spawnable character`);
    seen.add(skin);
  }
  assert.equal(seen.size, SPAWN_SKINS.length, 'every character must be reachable');

  // The rng is injectable, and an rng returning 1 must stay in range.
  assert.equal(randomMobSkin(() => 0), SPAWN_SKINS[0]);
  assert.ok(SPAWN_SKINS.includes(randomMobSkin(() => 1)));
});

test('a mob carries the skin it was spawned with', () => {
  const world = floorWorld();
  const { mob } = makeMob(world, 2, 2, 2);
  assert.equal(mob.skin, null, 'no skin given means the renderer picks one');

  const nav = new NavMesh(world, { halfWidth: 0.25, height: 1.7 });
  const skinned = new Mob({
    type: getMob('imp'),
    spawnCell: [2, 2, 2],
    world,
    nav,
    skin: MOB_SKINS[1],
    onDamagePlayer: () => {},
  });
  assert.equal(skinned.skin, MOB_SKINS[1]);
});

test('spawned mobs vary in height across the 1.6-1.9 m range', () => {
  const heights = Array.from({ length: 500 }, () => randomMobHeight());
  for (const h of heights) {
    assert.ok(h >= MOB_HEIGHT_MIN && h <= MOB_HEIGHT_MAX, `${h} m is outside the range`);
  }
  // The roll must actually spread, not cluster at one height.
  assert.ok(Math.min(...heights) < MOB_HEIGHT_MIN + 0.05, 'short mobs must occur');
  assert.ok(Math.max(...heights) > MOB_HEIGHT_MAX - 0.05, 'tall mobs must occur');

  assert.equal(randomMobHeight(() => 0), MOB_HEIGHT_MIN);
  assert.equal(randomMobHeight(() => 1), MOB_HEIGHT_MAX);
});

test('a mob stands at the height it was spawned with', () => {
  const world = floorWorld();
  const nav = new NavMesh(world, { halfWidth: 0.25, height: MOB_HEIGHT_MAX });
  const tall = new Mob({
    type: getMob('imp'), spawnCell: [2, 2, 2], world, nav, height: 1.88, onDamagePlayer: () => {},
  });
  const short = new Mob({
    type: getMob('imp'), spawnCell: [2, 2, 2], world, nav, height: 1.62, onDamagePlayer: () => {},
  });
  assert.equal(tall.height, 1.88);
  assert.equal(short.height, 1.62);

  // No height given falls back to the type's own, so existing callers are safe.
  const { mob } = makeMob(world, 2, 2, 2);
  assert.equal(mob.height, getMob('imp').height);
});

test('every animation frame index exists in the sheet strip', () => {
  for (const [name, list] of Object.entries(FRAMES)) {
    for (const idx of list) {
      assert.ok(Number.isInteger(idx) && idx >= 0 && idx < FRAME_COUNT, `${name} frame ${idx} is off-strip`);
    }
  }
});

test('climbs a 0.5 m step to reach a higher level', () => {
  const world = new World();
  for (let x = 0; x < 16; x += 2) {
    for (let z = 0; z < 8; z += 2) world.place('grass', SIZE.BIG, x, 0, z);
  }
  world.place('wood', SIZE.SMALL, 8, 2, 2); // step blocking the row at x=8
  const { mob } = makeMob(world, 2, 2, 2);
  // Player far past the step: the mob must climb it to get there.
  const player = { x: 14 * CELL_SIZE + CELL_SIZE / 2, y: 2 * CELL_SIZE, z: 2 * CELL_SIZE + CELL_SIZE / 2 };
  let maxY = mob.pos.y;
  for (let i = 0; i < 200; i++) {
    mob.update(0.1, player);
    maxY = Math.max(maxY, mob.pos.y);
  }
  assert.ok(maxY >= 3 * CELL_SIZE - 0.2, `mob should step up onto the block (max y=${maxY})`);
});

test('a delayed-aggro mob wakes only after its delay elapses', () => {
  const world = floorWorld();
  const type = getMob('imp');
  const nav = new NavMesh(world, { halfWidth: type.halfWidth, height: type.height });
  const mob = new Mob({ type, spawnCell: [2, 2, 2], world, nav, aggroDelay: 0.3, onDamagePlayer: () => {} });
  const player = { x: 6 * CELL_SIZE, y: 2 * CELL_SIZE, z: 2 * CELL_SIZE };
  for (let i = 0; i < 2; i++) {
    mob.update(0.1, player);
    assert.equal(mob.aggro, false, 'must not aggro before the delay elapses');
  }
  mob.update(0.1, player); // 0.3s elapsed = the delay
  assert.equal(mob.aggro, true);
});

test('separation nudges slide along walls instead of clipping in', () => {
  // Floor with a wall cell at x=8 (world x 4.0..4.5). A mob pushed a partial
  // cell into the wall must stop flush at its face, not embed itself — the
  // coarse "is the target cell walkable" check alone would let a sub-cell push
  // slide the AABB into the solid cell.
  const world = new World();
  for (let x = 0; x < 16; x += 2) {
    for (let z = 0; z < 16; z += 2) world.place('grass', SIZE.BIG, x, 0, z);
  }
  for (let y = 2; y <= 4; y++) world.place('stone', SIZE.SMALL, 8, y, 6);
  const { mob } = makeMob(world, 6, 6, 2);
  // Flush against the wall's west face (box maxX = 4.0).
  mob.pos.x = 3.75;
  assert.ok(Math.abs(mob._box().maxX - 4.0) < 1e-6, 'setup: mob is flush with the wall');
  mob.nudge(0.2, 0); // a sub-cell push INTO the wall
  assert.ok(!collides(world, mob._box()), 'mob must not overlap the wall after the push');
  assert.ok(mob.pos.x <= 3.75 + 1e-6, 'mob must not move through the wall');
  mob.nudge(-0.2, 0); // a push away is free
  assert.ok(mob.pos.x < 3.75, 'mob should move away from the wall when there is room');
});

// --- corner navigation (the "stuck on corners" regression) ---


/** 16x16 floor with an L-wall: a wall along x=7 (z=8..14) turning east at
 *  z=8. The mob must round the corner to reach the far side. */
function lWallWorld() {
  const world = new World();
  for (let x = 0; x < 16; x += 2) {
    for (let z = 0; z < 16; z += 2) world.place('grass', SIZE.BIG, x, 0, z);
  }
  for (let z = 8; z <= 14; z++) for (let y = 2; y <= 5; y++) world.place('stone', SIZE.SMALL, 7, y, z);
  for (let x = 8; x <= 14; x++) for (let y = 2; y <= 5; y++) world.place('stone', SIZE.SMALL, x, y, 8);
  return world;
}

test('rounds an L-wall corner without getting stuck', () => {
  const { mob } = makeMob(lWallWorld(), 2, 2, 2);
  // Aggro in the open.
  const p1 = { x: 5 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 5 * CELL_SIZE + CELL_SIZE / 2 };
  for (let i = 0; i < 90; i++) mob.update(0.1, p1);
  assert.equal(mob.aggro, true);
  // Player ducks behind the L-corner; the mob must path around it. (The test
  // teleports the player, so hand the mob the destination as its last-known
  // position — a real player would have been watched walking there.)
  const player = { x: 12 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 12 * CELL_SIZE + CELL_SIZE / 2 };
  mob.lkp = { ...player };
  let maxStall = 0;
  let stall = 0;
  let firstClose = Infinity;
  for (let i = 0; i < 600; i++) {
    const before = { x: mob.pos.x, z: mob.pos.z };
    mob.update(0.1, player);
    assert.ok(!collides(mob.world, mob._box()), `mob clipped into geometry at frame ${i}`);
    const moved = Math.hypot(mob.pos.x - before.x, mob.pos.z - before.z);
    stall = mob.state === 'chase' ? (moved < 0.01 ? stall + 0.1 : 0) : 0;
    maxStall = Math.max(maxStall, stall);
    if (Math.hypot(player.x - mob.pos.x, player.z - mob.pos.z) < 2.5) firstClose = Math.min(firstClose, i * 0.1);
  }
  const d = Math.hypot(player.x - mob.pos.x, player.z - mob.pos.z);
  assert.ok(d < 2.5, `mob should reach the player around the corner (d=${d.toFixed(2)})`);
  assert.ok(maxStall < 1.0, `mob must not stall at the corner (stalled ${maxStall.toFixed(1)}s)`);
  // An orbiting or wedged mob never closes — the trip is ~12m, so half a
  // minute is a generous budget that still catches pathological wandering.
  assert.ok(firstClose < 30, `mob should close within a time budget (took ${firstClose.toFixed(1)}s)`);
});

test('turns cleanly in a 1-wide corridor with a 90-degree corner', () => {
  const world = new World();
  for (let x = 0; x <= 12; x++) {
    for (let z = 0; z <= 12; z++) {
      const inCorridor = (x === 5 && z >= 3 && z <= 12) || (z === 3 && x >= 0 && x <= 5);
      if (inCorridor) {
        const ax = x - (x % 2), az = z - (z % 2);
        if (!world.get(ax, 0, az)) world.place('grass', SIZE.BIG, ax, 0, az);
      } else {
        for (let y = 2; y <= 5; y++) world.place('stone', SIZE.SMALL, x, y, z);
      }
    }
  }
  const { mob } = makeMob(world, 5, 10, 2);
  // Straight down the corridor first (seen), then round the turn.
  const seen = { x: 5 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 8 * CELL_SIZE + CELL_SIZE / 2 };
  for (let i = 0; i < 90; i++) mob.update(0.1, seen);
  assert.equal(mob.aggro, true);
  const player = { x: 1 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 3 * CELL_SIZE + CELL_SIZE / 2 };
  mob.lkp = { ...player }; // teleported out of sight — see the L-wall test
  let maxStall = 0;
  let stall = 0;
  for (let i = 0; i < 600; i++) {
    const before = { x: mob.pos.x, z: mob.pos.z };
    mob.update(0.1, player);
    assert.ok(!collides(world, mob._box()), `mob clipped into the corridor wall at frame ${i}`);
    const moved = Math.hypot(mob.pos.x - before.x, mob.pos.z - before.z);
    stall = mob.state === 'chase' ? (moved < 0.01 ? stall + 0.1 : 0) : 0;
    maxStall = Math.max(maxStall, stall);
  }
  const d = Math.hypot(player.x - mob.pos.x, player.z - mob.pos.z);
  assert.ok(d < 2.5, `mob should round the 90-degree corner (d=${d.toFixed(2)})`);
  assert.ok(maxStall < 1.0, `mob must not stall in the corridor (stalled ${maxStall.toFixed(1)}s)`);
});

test('climbs a 0.5 m step approached diagonally', () => {
  const world = new World();
  for (let x = 0; x < 16; x += 2) {
    for (let z = 0; z < 16; z += 2) world.place('grass', SIZE.BIG, x, 0, z);
  }
  // A single small block between mob and player, hit at a diagonal.
  world.place('wood', SIZE.SMALL, 8, 2, 8);
  const { mob } = makeMob(world, 4, 4, 2);
  const player = { x: 13 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 13 * CELL_SIZE + CELL_SIZE / 2 };
  let maxStall = 0;
  let stall = 0;
  for (let i = 0; i < 300; i++) {
    const before = { x: mob.pos.x, z: mob.pos.z };
    mob.update(0.1, player);
    const moved = Math.hypot(mob.pos.x - before.x, mob.pos.z - before.z);
    stall = mob.state === 'chase' ? (moved < 0.01 ? stall + 0.1 : 0) : 0;
    maxStall = Math.max(maxStall, stall);
  }
  const d = Math.hypot(player.x - mob.pos.x, player.z - mob.pos.z);
  assert.ok(d < 2.5, `mob should reach the player past the block (d=${d.toFixed(2)})`);
  assert.ok(maxStall < 1.0, `mob must not hang on the small block (stalled ${maxStall.toFixed(1)}s)`);
});

test('descends a multi-step staircase without stalling', () => {
  // Terraced ground: surface drops one 0.5m step every 3 cells along +x.
  const world = new World();
  for (let x = 0; x < 15; x++) {
    const top = 3 - Math.floor(x / 3); // surface cell: 4,4,4,3,3,3,2,2,2,...
    for (let z = 0; z < 8; z++) {
      for (let y = -2; y < top; y++) world.place('stone', SIZE.SMALL, x, y, z);
    }
  }
  const { mob } = makeMob(world, 1, 4, 4); // on the top terrace
  const player = { x: 13 * CELL_SIZE + CELL_SIZE / 2, y: 0, z: 4 * CELL_SIZE + CELL_SIZE / 2 };
  let maxStall = 0;
  let stall = 0;
  for (let i = 0; i < 300; i++) {
    const before = { x: mob.pos.x, z: mob.pos.z };
    mob.update(0.1, player);
    const moved = Math.hypot(mob.pos.x - before.x, mob.pos.z - before.z);
    stall = mob.state === 'chase' && mob.grounded ? (moved < 0.01 ? stall + 0.1 : 0) : 0;
    maxStall = Math.max(maxStall, stall);
  }
  const d = Math.hypot(player.x - mob.pos.x, player.z - mob.pos.z);
  assert.ok(d < 2.5, `mob should descend the stairs to the player (d=${d.toFixed(2)})`);
  assert.ok(maxStall < 0.5, `stair descent must not stutter (stalled ${maxStall.toFixed(1)}s)`);
});

test('threads a doorway exactly its own width', () => {
  // A wall with a 1-cell doorway — 0.5m, the mob's exact width. Passing needs
  // perfect alignment on the doorway line; steering must converge onto it
  // instead of oscillating at the mouth.
  const world = new World();
  for (let x = 0; x < 16; x += 2) {
    for (let z = 0; z < 16; z += 2) world.place('grass', SIZE.BIG, x, 0, z);
  }
  for (let z = 0; z < 16; z++) {
    if (z === 8) continue; // the doorway
    for (let y = 2; y <= 5; y++) world.place('stone', SIZE.SMALL, 8, y, z);
  }
  const { mob } = makeMob(world, 4, 8, 2);
  mob.aggro = true;
  mob.state = 'chase';
  const player = { x: 13 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 8 * CELL_SIZE + CELL_SIZE / 2 };
  for (let i = 0; i < 300; i++) mob.update(0.1, player);
  const d = Math.hypot(player.x - mob.pos.x, player.z - mob.pos.z);
  assert.ok(d < 2.5, `mob should pass the doorway and reach the player (d=${d.toFixed(2)})`);
});

test('unwedge sidesteps tangentially instead of only backing straight up', () => {
  const world = floorWorld();
  const { mob } = makeMob(world, 2, 2, 2);
  mob.aggro = true;
  mob.state = 'chase';
  // Fake a path whose current waypoint sits to the east.
  mob.path = [{ x: 6, z: 2, y: 2 }];
  mob.pathIndex = 0;
  mob._startUnwedge();
  assert.ok(mob._unwedge, 'unwedge must engage');
  // To-target direction is +x; a tangential sidestep is along ±z.
  const speed = Math.hypot(mob._unwedge.vx, mob._unwedge.vz);
  const dot = mob._unwedge.vx / speed; // cos(angle to +x)
  assert.ok(Math.abs(dot) < 0.1, `sidestep should be perpendicular to the target direction (cos=${dot.toFixed(2)})`);
});

test('pauses to search when it loses sight, then resumes hunting', () => {
  const world = floorWorld();
  // A partial wall down the middle (leaving a route around it) so the player
  // can step out of sight.
  for (let z = 2; z <= 5; z++) for (let y = 2; y <= 5; y++) world.place('stone', SIZE.SMALL, 4, y, z);
  const { mob } = makeMob(world, 1, 4, 2); // west of the wall
  // Aggro while the player is on the same side (in sight).
  const seen = { x: 2 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 4 * CELL_SIZE + CELL_SIZE / 2 };
  for (let i = 0; i < 30; i++) mob.update(0.1, seen);
  assert.equal(mob.aggro, true);
  // Player steps to the far side of the wall — out of sight.
  const hidden = { x: 7 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 4 * CELL_SIZE + CELL_SIZE / 2 };
  let pausedFrames = 0;
  let moved = false;
  for (let i = 0; i < 30; i++) {
    const before = { ...mob.pos };
    mob.update(0.1, hidden);
    if (Math.hypot(mob.pos.x - before.x, mob.pos.z - before.z) < 0.001) pausedFrames++;
    else moved = true;
  }
  assert.equal(mob._searching, false, 'the search pause must end');
  assert.ok(pausedFrames >= 4, `mob should pause ~0.45s after losing sight (paused ${pausedFrames} frames)`);
  assert.ok(moved, 'mob should resume moving after the search pause');
});

test('a mob below the player cannot bite them', () => {
  const world = floorWorld();
  const { mob, hits } = makeMob(world, 2, 2, 2);
  // Player directly above the mob's column but out of vertical reach (~2m up).
  const player = { x: mob.pos.x, y: mob.pos.y + 2.0, z: mob.pos.z };
  for (let i = 0; i < 40; i++) mob.update(0.1, player);
  assert.equal(hits.length, 0, 'a mob below the player must not land a strike');
  assert.notEqual(mob.state, 'attack', 'mob must not enter the attack wind-up');
});

test('a mob at the same level in reach still attacks', () => {
  const world = floorWorld();
  const { mob, hits } = makeMob(world, 2, 2, 2);
  const player = { x: mob.pos.x + 0.5, y: mob.pos.y, z: mob.pos.z };
  for (let i = 0; i < 40; i++) mob.update(0.1, player);
  assert.ok(hits.length >= 1, 'same-level mob should strike the player');
});

test('walks off a ledge and lands on the lower surface (Y-aware waypoints)', () => {
  // Upper ground slab (surface y=2) with a cliff down to a lower slab (surface
  // y=-1) to the north. The mob must drop off the ledge, not strand on it.
  const world = new World();
  for (let x = 0; x < 8; x++) {
    for (let z = 0; z < 4; z++) {
      for (let y = 0; y <= 1; y++) world.place('stone', SIZE.SMALL, x, y, z);
    }
    for (let z = 4; z < 8; z++) world.place('stone', SIZE.SMALL, x, -2, z); // lower slab
  }
  const { mob } = makeMob(world, 2, 1, 2); // upper ground
  // Player on the lower slab, in sight over the cliff.
  const player = { x: 2 * CELL_SIZE + CELL_SIZE / 2, y: -1 * CELL_SIZE, z: 6 * CELL_SIZE + CELL_SIZE / 2 };
  for (let i = 0; i < 300; i++) mob.update(0.1, player);
  assert.ok(mob.pos.y <= -0.4, `mob should drop onto the lower slab (y=${mob.pos.y.toFixed(2)})`);
  assert.ok(mob.grounded, 'mob should be standing on the lower slab');
});

test('a long fall lands on the floor instead of tunneling through it', () => {
  // A 1m-thick floor (cells y=0,1) under open air.
  const world = new World();
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      for (let y = 0; y <= 1; y++) world.place('stone', SIZE.SMALL, x, y, z);
    }
  }
  const { mob } = makeMob(world, 2, 2, 2);
  mob.aggro = true;
  mob.state = 'chase';
  mob._repathTimer = 0;
  mob.pos.y = 15; // dropped from high above
  mob.grounded = false;
  mob.velY = 0;
  const player = { x: 7 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 7 * CELL_SIZE + CELL_SIZE / 2 };
  let minY = mob.pos.y;
  for (let i = 0; i < 600; i++) {
    mob.update(0.1, player); // 0.1s frames = worst-case lag
    minY = Math.min(minY, mob.pos.y);
    if (mob.grounded) break;
  }
  assert.ok(mob.grounded, 'mob should land on the floor');
  assert.ok(minY >= 1.0 - 0.01, `mob must not fall through the floor (minY=${minY.toFixed(2)})`);
  assert.ok(mob.pos.y >= 1.0 - 0.01 && mob.pos.y <= 1.0 + 0.01, `mob rests on the floor (y=${mob.pos.y.toFixed(2)})`);
});

// --- group alarm: last-known position + alert ---

test('damage records the shooter position as the last-known player position', () => {
  const world = floorWorld();
  const { mob } = makeMob(world, 2, 2, 2);
  mob.takeDamage(5);
  assert.equal(mob.lkp, null, 'no origin given, none recorded');
  const from = { x: 3.1, y: 1.0, z: 0.6 };
  mob.takeDamage(5, from);
  assert.deepEqual(mob.lkp, from);
  assert.notEqual(mob.lkp, from, 'must copy, not alias, the position');
});

test('an alerted mob wakes after its delay without range or line of sight', () => {
  const world = floorWorld();
  const type = getMob('imp');
  const nav = new NavMesh(world, { halfWidth: type.halfWidth, height: type.height });
  const mob = new Mob({ type, spawnCell: [2, 2, 2], world, nav, aggroDelay: 0.3, onDamagePlayer: () => {} });
  // Player far outside aggro range — sight alone must not wake this mob.
  const player = { x: 50, y: 1.0, z: 50 };
  for (let i = 0; i < 5; i++) mob.update(0.1, player);
  assert.equal(mob.aggro, false, 'sanity: out of range, still asleep');

  mob.alert({ x: 2.25, y: 1.0, z: 3.25 });
  assert.deepEqual(mob.lkp, { x: 2.25, y: 1.0, z: 3.25 });
  for (let i = 0; i < 2; i++) {
    mob.update(0.1, player);
    assert.equal(mob.aggro, false, 'the wake delay still staggers an alerted mob');
  }
  mob.update(0.1, player);
  assert.equal(mob.aggro, true, 'alerted mob aggroes after its delay');
  assert.equal(mob.state, 'chase');
});

test('a blind aggro mob hunts the last-known position, not the live player', () => {
  const world = floorWorld();
  // Wall down the middle; the player hides east of it, out of sight.
  for (let z = 2; z <= 5; z++) for (let y = 2; y <= 5; y++) world.place('stone', SIZE.SMALL, 4, y, z);
  const { mob } = makeMob(world, 1, 4, 2); // west side
  const player = { x: 3.75, y: 1.0, z: 2.25 }; // east side, hidden
  const shotFrom = { x: 0.75, y: 1.0, z: 0.75 }; // south-west, in the open
  mob.takeDamage(5, shotFrom);
  // Run until the mob presses within reach of the shot origin, then assert
  // there — once the spot turns up empty it starts randomly juking around
  // (under-fire evasion, see mobevade.test.js) and may wander anywhere.
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    mob.update(0.1, player);
    reached = Math.hypot(shotFrom.x - mob.pos.x, shotFrom.z - mob.pos.z) < 1.6;
  }
  // It closes on the shot origin — NOT on the live player it has never seen.
  assert.ok(reached, 'mob hunts the shot origin');
  assert.ok(mob.pos.x < 2.0, `mob must not track the hidden player through the wall (x=${mob.pos.x.toFixed(2)})`);
});

// --- flanking ---

/** Big open floor for flank-route tests (32x32 cells = 16m). */
function bigFloorWorld() {
  const w = new World();
  for (let x = 0; x < 32; x += 2) {
    for (let z = 0; z < 32; z += 2) w.place('grass', SIZE.BIG, x, 0, z);
  }
  return w;
}

test('a flanker routes to the side of the player facing, not straight in', () => {
  const world = bigFloorWorld();
  const type = getMob('imp');
  const nav = new NavMesh(world, { halfWidth: type.halfWidth, height: type.height });
  const mob = new Mob({ type, spawnCell: [2, 2, 16], world, nav, onDamagePlayer: () => {} });
  mob.aggro = true;
  mob.state = 'chase';
  mob.flankRole = 'flankR';
  mob.playerFacing = { x: 1, z: 0 }; // player looks east (toward +x)
  const player = { x: 8.25, y: 1.0, z: 8.25 }; // 7m away — beyond engage range
  mob._repath(player);
  assert.ok(mob.path.length > 0, 'flank path exists');
  const end = mob.path[mob.path.length - 1];
  const ex = end.x * CELL_SIZE + CELL_SIZE / 2;
  const ez = end.z * CELL_SIZE + CELL_SIZE / 2;
  // flankR of facing (1,0) is side (0,-1): well to the player's right, and
  // slightly BEHIND the view direction (-x of the player).
  assert.ok(ez < player.z - 3, `goal should sit to the player's right (z=${ez.toFixed(2)})`);
  assert.ok(ex < player.x, `goal should sit behind the view direction (x=${ex.toFixed(2)})`);

  // The mirror role lands on the opposite side.
  const mobL = new Mob({ type, spawnCell: [2, 2, 16], world, nav, onDamagePlayer: () => {} });
  mobL.aggro = true;
  mobL.state = 'chase';
  mobL.flankRole = 'flankL';
  mobL.playerFacing = { x: 1, z: 0 };
  mobL._repath(player);
  const endL = mobL.path[mobL.path.length - 1];
  assert.ok(endL.z * CELL_SIZE + CELL_SIZE / 2 > player.z + 3, 'flankL goal sits to the left');
});

test('an unreachable flank goal demotes the mob to a direct charge', () => {
  // Player near the map's east edge, facing south: the flankR point lands 5m
  // further east — off the map, no nav node — so the flank path must fail and
  // the mob must fall back to a working direct path.
  const world = bigFloorWorld();
  const type = getMob('imp');
  const nav = new NavMesh(world, { halfWidth: type.halfWidth, height: type.height });
  const mob = new Mob({ type, spawnCell: [4, 2, 16], world, nav, onDamagePlayer: () => {} });
  mob.aggro = true;
  mob.state = 'chase';
  mob.flankRole = 'flankR';
  mob.playerFacing = { x: 0, z: 1 }; // facing south: flankR side points east
  const player = { x: 14.75, y: 1.0, z: 8.25 }; // 1.25m from the east edge
  mob._repath(player);
  assert.equal(mob.flankRole, 'flankR', 'one failure is not enough to give up');
  assert.ok(mob.path.length > 0, 'the direct fallback path still exists');
  mob._repath(player);
  assert.equal(mob.flankRole, 'direct', 'two failed flank paths demote the role');
});

test('a flanker inside engage range presses in like a charger', () => {
  const world = bigFloorWorld();
  const type = getMob('imp');
  const nav = new NavMesh(world, { halfWidth: type.halfWidth, height: type.height });
  const mob = new Mob({ type, spawnCell: [12, 2, 16], world, nav, onDamagePlayer: () => {} });
  mob.aggro = true;
  mob.state = 'chase';
  mob.flankRole = 'flankR';
  mob.playerFacing = { x: 1, z: 0 };
  const player = { x: 8.25, y: 1.0, z: 8.25 }; // ~2.3m away — inside engage range
  mob._repath(player);
  assert.equal(mob._flankDone, true, 'the flank ends at engage range');
  assert.ok(mob.path.length > 0, 'and the mob paths at/around the player');
  const end = mob.path[mob.path.length - 1];
  const ex = end.x * CELL_SIZE + CELL_SIZE / 2;
  const ez = end.z * CELL_SIZE + CELL_SIZE / 2;
  assert.ok(Math.hypot(ex - player.x, ez - player.z) < 2.5, 'goal is at the player, not a side point');
});
