// mobmanager.test.js — shared line-of-sight: a cluster of mobs can spot the
// player together, but mobs walled off (or out of aggro range) do NOT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { MobManager } from '../src/game/MobManager.js';
import { collides } from '../src/engine/Physics.js';

const stubRenderer = { update() {}, addMob() {}, removeMob() {}, clear() {} };

/** 48x48-cell floor with a tall wall down the middle at x=24. */
function walledWorld() {
  const w = new World();
  for (let x = 0; x < 48; x += 2) {
    for (let z = 0; z < 48; z += 2) w.place('grass', SIZE.BIG, x, 0, z);
  }
  for (let z = 0; z < 48; z++) {
    for (let y = 2; y <= 8; y++) w.place('stone', SIZE.SMALL, 24, y, z);
  }
  return w;
}

function makeManager(world) {
  return new MobManager({ THREE, scene: {}, world, onDamagePlayer: () => {}, renderer: stubRenderer });
}

test('a group of mobs shares LOS while walled/far mobs do not aggro', () => {
  const world = walledWorld();
  // West of the wall, near the player (world x ~5-6).
  world.addMobSpawn('imp', 10, 2, 22); // world (5.25, 1.0, 11.25)
  world.addMobSpawn('imp', 10, 2, 24); // world (5.25, 1.0, 12.25)
  world.addMobSpawn('imp', 12, 2, 22); // world (6.25, 1.0, 11.25)
  // East of the wall, within aggro range but with no line of sight — and
  // beyond the cluster's alertRadius (12m), so their alarm can't wake these
  // either (a separate, intended mechanic — see the alarm tests).
  world.addMobSpawn('imp', 40, 2, 22); // world (20.25, 1.0, 11.25)
  world.addMobSpawn('imp', 42, 2, 24); // world (21.25, 1.0, 12.25)
  // Far corner, beyond aggro range entirely.
  world.addMobSpawn('imp', 46, 2, 46); // world (23.25, 1.0, 23.25)

  const mgr = makeManager(world);
  mgr.rebuild();
  assert.equal(mgr.mobs.length, 6);

  const player = { x: 6.25, y: 1.0, z: 12.25 }; // column (12,24), west of the wall
  for (let i = 0; i < 5; i++) mgr.update(0.1, player);

  const aggroByX = mgr.mobs.map((m) => ({ x: m.pos.x, aggro: m.aggro })).sort((a, b) => a.x - b.x);
  const near = aggroByX.filter((m) => m.x < 10);
  const walled = aggroByX.filter((m) => m.x > 15 && m.x < 22);
  const far = aggroByX.filter((m) => m.x > 22);

  assert.equal(near.length, 3, 'three mobs cluster near the player');
  assert.ok(near.every((m) => m.aggro), 'the cluster sees the player and aggroes');
  assert.equal(walled.length, 2);
  assert.ok(walled.every((m) => !m.aggro), 'mobs across a wall must not aggro');
  assert.equal(far.length, 1);
  assert.equal(far[0].aggro, false, 'mobs beyond aggro range must not aggro');
});

test('one LOS ray is cast per bucket, not per mob', () => {
  const world = walledWorld();
  // Three mobs in the SAME 3D bucket (world x 4.75/5.25/5.75 all in one
  // 1.5 m interval; z and floor identical too).
  world.addMobSpawn('imp', 9, 2, 22);  // world (4.75, 1.0, 11.25)
  world.addMobSpawn('imp', 10, 2, 22); // world (5.25, 1.0, 11.25)
  world.addMobSpawn('imp', 11, 2, 22); // world (5.75, 1.0, 11.25)

  const mgr = makeManager(world);
  mgr.rebuild();
  assert.equal(mgr.mobs.length, 3);
  const keys = new Set(mgr.mobs.map((m) => mgr._bucketKey(m)));
  assert.equal(keys.size, 1, 'all three mobs share one bucket');

  const player = { x: 6.25, y: 1.0, z: 12.25 };
  let rays = 0;
  const orig = mgr.solidWorld;
  mgr.solidWorld = new Proxy(orig, {
    get(t, prop) {
      return prop === 'get' ? (...a) => { rays++; return orig.get(...a); } : t[prop];
    },
  });
  // Run past the per-mob aggro stagger (0..0.3s) so every mob in the bucket
  // wakes, then verify they all share the same LOS verdict.
  for (let i = 0; i < 4; i++) mgr.update(0.1, player);
  // One bucket -> a bounded number of LOS rays, not one raycast per mob.
  assert.ok(rays > 0 && rays < 1000, `expected a bounded single ray walk, got ${rays} cell reads`);
  const verdicts = new Set(mgr.mobs.map((m) => m.sharedVisible));
  assert.equal(verdicts.size, 1, 'mobs in one bucket share a verdict');
  assert.ok(mgr.mobs.every((m) => m.aggro), 'and that verdict makes them all aggro');
});

test('a chasing pack spreads out instead of stacking into one spot', () => {
  const world = new World();
  for (let x = 0; x < 48; x += 2) {
    for (let z = 0; z < 48; z += 2) world.place('grass', SIZE.BIG, x, 0, z);
  }
  world.addMobSpawn('imp', 10, 2, 5);
  world.addMobSpawn('imp', 11, 2, 5);

  const hits = [];
  const mgr = new MobManager({ THREE, scene: {}, world, renderer: stubRenderer, onDamagePlayer: (d) => hits.push(d) });
  mgr.rebuild();
  assert.equal(mgr.mobs.length, 2);
  // Force opposing flank directions so the two mobs approach from different sides.
  mgr.mobs[0].spreadAngle = 0;
  mgr.mobs[1].spreadAngle = Math.PI;

  const player = { x: 12.25, y: 1.0, z: 12.25 };
  for (let i = 0; i < 600; i++) mgr.update(1 / 60, player);

  const [a, b] = mgr.mobs;
  const dist = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
  assert.ok(dist > 1.0, `mobs must not stack into one spot (distance ${dist.toFixed(2)}m)`);

  // Both should be engaged around the player, not hugging its exact cell.
  const da = Math.hypot(a.pos.x - player.x, a.pos.z - player.z);
  const db = Math.hypot(b.pos.x - player.x, b.pos.z - player.z);
  assert.ok(da > 0.4 && db > 0.4, 'mobs should keep off the player\'s body');
  assert.ok(da < 2.2 && db < 2.2, `mobs should close in on the player (${da.toFixed(2)}m, ${db.toFixed(2)}m)`);
  assert.ok(hits.length >= 1, 'the pack should actually strike the player');
});

test('a large clustered pack never clips into walls or teleports', () => {
  // The player is pinned in an L-corner (west + north walls). 20 mobs spawn in
  // a tight block to the south-east, all with line of sight, so the whole pack
  // charges and piles into the corner around the player — the tightest case
  // for the separation pass. Invariants: no mob may ever overlap a solid cell,
  // and no mob may move more than a step in a single frame.
  const world = new World();
  for (let x = 0; x < 48; x += 2) {
    for (let z = 0; z < 48; z += 2) world.place('grass', SIZE.BIG, x, 0, z);
  }
  for (let x = 0; x <= 36; x++) {
    for (let y = 2; y <= 6; y++) world.place('stone', SIZE.SMALL, x, y, 4);
  }
  for (let z = 4; z <= 36; z++) {
    for (let y = 2; y <= 6; y++) world.place('stone', SIZE.SMALL, 4, y, z);
  }
  for (let i = 0; i < 20; i++) world.addMobSpawn('imp', 14 + (i % 5) * 2, 2, 14 + Math.floor(i / 5) * 2);

  const mgr = makeManager(world);
  mgr.rebuild();
  assert.equal(mgr.mobs.length, 20);

  const player = { x: 8.25, y: 1.0, z: 8.25 }; // just inside the corner
  let walled = false;
  let maxStep = 0;
  for (let f = 0; f < 900; f++) {
    for (const m of mgr.mobs) {
      if (collides(world, m._box())) { walled = true; break; }
    }
    for (const m of mgr.mobs) {
      if (m.prevX !== undefined) {
        const step = Math.hypot(m.pos.x - m.prevX, m.pos.z - m.prevZ);
        maxStep = Math.max(maxStep, step);
      }
      m.prevX = m.pos.x;
      m.prevZ = m.pos.z;
    }
    mgr.update(1 / 60, player);
    if (walled) break;
  }
  assert.equal(walled, false, 'no mob may ever overlap a solid cell (wall entry)');
  assert.ok(maxStep < 0.35, `no mob may teleport (max per-frame move ${maxStep.toFixed(2)}m)`);
  // And the pack still closes in instead of being held at bay.
  const engaged = mgr.mobs.filter((m) => Math.hypot(m.pos.x - player.x, m.pos.z - player.z) < 2.0).length;
  assert.ok(engaged >= 1, `the pack should still reach the player (${engaged} within 2m)`);
});

test('mobs chase the player down a staircase without disappearing', () => {
  // A staircase descends 3 m into a pit. Mobs chasing the player down it must
  // descend (not vanish / fall through the world / get flung off the map) —
  // the bug class seen at world (7.8, -0.4, 1.0) in an older shipped map.
  const world = new World();
  for (let x = 0; x < 32; x += 2) {
    for (let z = 0; z < 32; z += 2) world.place('stone', SIZE.BIG, x, 0, z);
  }
  // Pit x 10..17, z 10..17 with a floor 3 m below the ground surface.
  for (let x = 10; x < 18; x += 2) {
    for (let z = 10; z < 18; z += 2) {
      world.remove(x, 0, z);
      world.place('stone', SIZE.BIG, x, -6, z);
    }
  }
  // One-cell steps down along z=12..13 from the ground rim to the pit floor.
  for (let x = 15; x >= 10; x--) {
    const surface = 2 - (15 - x);
    for (let y = surface - 1; y >= -5; y--) {
      world.place('stone', SIZE.SMALL, x, y, 12);
      world.place('stone', SIZE.SMALL, x, y, 13);
    }
  }
  world.addMobSpawn('imp', 8, 2, 24); // world (4.25, 1.0, 12.25), on the ground
  const mgr = makeManager(world);
  mgr.rebuild();
  assert.ok(mgr.mobs.length >= 1, 'the mob spawns');

  // Aggro while the player stands on the ground between the mob and the pit.
  const onGround = { x: 6.25, y: 1.0, z: 12.25 };
  for (let i = 0; i < 300; i++) mgr.update(1 / 60, onGround);
  assert.ok(mgr.mobs.some((m) => m.aggro), 'the mob aggroes on sight');

  // The player ducks down into the pit; the mob must follow down without any
  // position going non-finite or plunging below the world. (Seed the
  // last-known position — the test exercises the descent, not target
  // acquisition.)
  const pit = { x: 6.75, y: -2.0, z: 6.25 };
  for (const m of mgr.mobs) m.lkp = { ...pit };
  let minY = 1e9;
  let nonFinite = false;
  for (let i = 0; i < 20 * 60; i++) {
    const d = i % 45 === 0 ? 0.1 : 1 / 60; // include lag spikes
    mgr.update(d, pit);
    for (const m of mgr.mobs) {
      minY = Math.min(minY, m.pos.y);
      if (!Number.isFinite(m.pos.x + m.pos.y + m.pos.z)) { nonFinite = true; break; }
      if (m.pos.y < -20) { minY = m.pos.y; nonFinite = true; break; }
    }
    if (nonFinite) break;
  }
  assert.equal(nonFinite, false, 'no mob may disappear (non-finite position or plunge)');
  assert.ok(minY < -1.5, `the mob should descend into the pit (minY=${minY.toFixed(1)})`);
});

test('a pack funnels through a narrow doorway without deadlocking', () => {
  // A wall with a single 1m doorway between the pack and the player — wide
  // enough for one mob plus elbow room, far too narrow for the pack abreast.
  // The crowd must queue through — steering separation and overlap resolution
  // must not wedge mobs into the jambs or lock the doorway up.
  const world = new World();
  for (let x = 0; x < 48; x += 2) {
    for (let z = 0; z < 48; z += 2) world.place('grass', SIZE.BIG, x, 0, z);
  }
  for (let z = 0; z < 48; z++) {
    if (z === 12 || z === 13) continue; // the doorway
    for (let y = 2; y <= 6; y++) world.place('stone', SIZE.SMALL, 20, y, z);
  }
  for (let i = 0; i < 6; i++) world.addMobSpawn('imp', 12 + (i % 3) * 2, 2, 10 + Math.floor(i / 3) * 2);

  const mgr = makeManager(world);
  mgr.rebuild();
  assert.equal(mgr.mobs.length, 6);
  // The wall hides the player, so wake the pack directly — the test is about
  // crowd flow through the bottleneck, not aggro acquisition.
  for (const m of mgr.mobs) {
    m.aggro = true;
    m.state = 'chase';
  }

  const player = { x: 13.25, y: 1.0, z: 6.25 }; // east of the wall
  let walled = false;
  for (let f = 0; f < 40 * 60 && !walled; f++) {
    mgr.update(1 / 60, player);
    for (const m of mgr.mobs) {
      if (collides(world, m._box())) { walled = true; break; }
    }
  }
  assert.equal(walled, false, 'no mob may be squeezed into the doorway jambs');
  // "Through" = east of the wall (face at x=10.5). The whole pack can't all
  // stand within arm's reach of the player — the front rank rings them and the
  // back rank queues behind it — so proximity is the wrong metric here.
  const through = mgr.mobs.filter((m) => m.pos.x > 10.5).length;
  assert.ok(through >= 4, `most of the pack should make it through the doorway (${through}/6 east of the wall)`);
  const engaged = mgr.mobs.filter((m) => Math.hypot(m.pos.x - player.x, m.pos.z - player.z) < 2.0).length;
  assert.ok(engaged >= 1, `the front rank should engage the player (${engaged} within 2m)`);
});

// --- group alarm ---

test('shooting one mob alarms its packmates, even through a wall', () => {
  const world = walledWorld();
  world.addMobSpawn('imp', 10, 2, 22); // west: the victim, world (5.25, 1.0, 11.25)
  world.addMobSpawn('imp', 30, 2, 22); // east of the wall, ~10.0m from the victim
  world.addMobSpawn('imp', 46, 2, 46); // far corner, ~21m — out of earshot

  const mgr = makeManager(world);
  mgr.rebuild();
  assert.equal(mgr.mobs.length, 3);
  const [victim, walled, far] = mgr.mobs;

  // Player stands west, visible only to the victim's side; they snipe it.
  const player = { x: 3.25, y: 1.0, z: 11.25 };
  victim.takeDamage(10, player);
  assert.equal(victim.aggro, true);

  // Run past the alert wake delay (0..0.3s).
  for (let i = 0; i < 8; i++) mgr.update(0.1, player);

  assert.equal(walled.aggro, true, 'a packmate in earshot must join, wall or not');
  assert.ok(walled.lkp, 'and it knows where the shot came from');
  assert.equal(far.aggro, false, 'out of earshot stays asleep');
});

test('an alarm propagates one hop, not in a chain across the map', () => {
  const world = new World();
  for (let x = 0; x < 64; x += 2) {
    for (let z = 0; z < 64; z += 2) world.place('grass', SIZE.BIG, x, 0, z);
  }
  // Three mobs in a line, 10m apart: A hears nobody, B hears A, C hears B.
  world.addMobSpawn('imp', 10, 2, 10); // A (5.25, 1.0, 5.25)
  world.addMobSpawn('imp', 30, 2, 10); // B (15.25) — 10m from A
  world.addMobSpawn('imp', 50, 2, 10); // C (25.25) — 10m from B, 20m from A

  const mgr = makeManager(world);
  mgr.rebuild();
  const [a, b, c] = mgr.mobs;

  // Player far away in a corner: nobody can see or aggro them by sight.
  const player = { x: 5.25, y: 1.0, z: 30.25 };
  a.takeDamage(10, player);
  for (let i = 0; i < 12; i++) mgr.update(0.1, player);

  assert.equal(a.aggro, true);
  assert.equal(b.aggro, true, 'B hears the shot victim');
  assert.equal(c.aggro, false, 'C must NOT be woken by a chain — alerted mobs do not re-shout');
});

test('sight aggro also shouts: a hidden packmate joins when the pack spots you', () => {
  const world = walledWorld();
  world.addMobSpawn('imp', 10, 2, 22); // west, sees the player
  world.addMobSpawn('imp', 30, 2, 22); // east of the wall, in earshot (~10m)

  const mgr = makeManager(world);
  mgr.rebuild();
  const [seer, hidden] = mgr.mobs;

  const player = { x: 3.25, y: 1.0, z: 11.25 }; // west side, visible to `seer`
  for (let i = 0; i < 10; i++) mgr.update(0.1, player);

  assert.equal(seer.aggro, true, 'sanity: the west mob sees and aggroes');
  assert.equal(hidden.aggro, true, 'its shout wakes the packmate behind the wall');
});

// --- flank role assignment ---

test('a raised pack splits into deterministic direct and flank roles', () => {
  const world = new World();
  for (let x = 0; x < 48; x += 2) {
    for (let z = 0; z < 48; z += 2) world.place('grass', SIZE.BIG, x, 0, z);
  }
  // Six mobs in one tight pack, all within earshot of the first.
  for (let i = 0; i < 6; i++) world.addMobSpawn('imp', 10 + (i % 3) * 2, 2, 10 + Math.floor(i / 3) * 2);

  const mgr = makeManager(world);
  mgr.rebuild();
  const player = { x: 20.25, y: 1.0, z: 20.25 };
  mgr.mobs[0].takeDamage(10, player);
  mgr.update(0.1, player);

  const roles = mgr.mobs.map((m) => m.flankRole);
  const flankers = roles.filter((r) => r !== 'direct');
  assert.equal(flankers.length, 2, `a pack of 6 fields exactly 2 flankers (got ${roles.join(',')})`);
  assert.ok(flankers.includes('flankL') && flankers.includes('flankR'), 'one flanker per side');
  assert.equal(roles[0], 'direct', 'the shouter itself charges head-on');

  // Deterministic: an identical setup assigns identical roles.
  const mgr2 = makeManager(world);
  mgr2.rebuild();
  mgr2.mobs[0].takeDamage(10, player);
  mgr2.update(0.1, player);
  assert.deepEqual(mgr2.mobs.map((m) => m.flankRole), roles);
});

test('a pack of two never flanks', () => {
  const world = new World();
  for (let x = 0; x < 48; x += 2) {
    for (let z = 0; z < 48; z += 2) world.place('grass', SIZE.BIG, x, 0, z);
  }
  world.addMobSpawn('imp', 10, 2, 10);
  world.addMobSpawn('imp', 12, 2, 10);

  const mgr = makeManager(world);
  mgr.rebuild();
  const player = { x: 20.25, y: 1.0, z: 20.25 };
  mgr.mobs[0].takeDamage(10, player);
  for (let i = 0; i < 5; i++) mgr.update(0.1, player);
  assert.ok(mgr.mobs.every((m) => m.flankRole === 'direct'), 'both charge — no lone flanker');
});
