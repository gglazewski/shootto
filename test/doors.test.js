// doors.test.js — door system: footprint, toggling, collision, save format,
// meshing and mob navigation.

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE, getBlock, isPassable, shapeFor } from '../src/engine/VoxelTypes.js';
import { spanVecFor, cellsFor } from '../src/engine/VoxelShape.js';
import {
  toggleDoor, doorToggleId, isDoorVoxel, isOpenDoor, canToggle,
  isDoorLocked, doorHinge, doorSwing, setDoorLocked, setDoorOpening, applyDoorSettings,
} from '../src/engine/Doors.js';
import { doorPlanPoints } from '../src/editor/DoorMarker.js';
import { doorOpenings } from '../src/editor/DoorModal.js';
import { serializePrefab, deserializePrefab } from '../src/persistence/PrefabSerializer.js';
import { stampPrefab } from '../src/engine/PrefabStamp.js';
import { collisionWorld } from '../src/editor/itemPick.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';
import { buildChunkMesh } from '../src/engine/ChunkMeshBuilder.js';
import { NavMesh } from '../src/engine/NavMesh.js';
import { renderAtlasRGBA, tileSpan } from '../src/textures/TextureAtlas.js';

test('door size spans 2x4x1 and turns with odd rotations', () => {
  assert.deepEqual(spanVecFor(SIZE.DOOR, 0), [2, 4, 1]);
  assert.deepEqual(spanVecFor(SIZE.DOOR, 1), [1, 4, 2]);
  assert.deepEqual(spanVecFor(SIZE.DOOR, 2), [2, 4, 1]);
  assert.deepEqual(spanVecFor(SIZE.DOOR, 3), [1, 4, 2]);
  // cubic sizes ignore rotation
  assert.deepEqual(spanVecFor(SIZE.BIG, 1), [2, 2, 2]);
  assert.equal(cellsFor(0, 0, 0, SIZE.DOOR, 0).length, 8);
  assert.deepEqual(cellsFor(0, 0, 0, SIZE.DOOR, 1).map(([x, , z]) => `${x},${z}`).filter((v, i, a) => a.indexOf(v) === i).sort(), ['0,0', '0,1']);
});

test('placing a door occupies its whole footprint atomically', () => {
  const world = new World();
  assert.ok(world.place('door_wood', SIZE.DOOR, 2, 0, 3, 0));
  // all 8 cells resolve to the same voxel
  const v = world.get(2, 0, 3);
  assert.ok(v);
  assert.equal(v.size, SIZE.DOOR);
  assert.equal(world.get(3, 3, 3), v);
  assert.equal(world.get(4, 0, 3), null);
  assert.equal(world.get(2, 4, 3), null);
  // overlap is rejected (atomic)
  assert.equal(world.place('brick', SIZE.SMALL, 3, 2, 3), false);
  assert.equal(world.isAreaFree(3, 0, 3, SIZE.DOOR, 0), false);
  // removal via any cell clears the footprint
  world.remove(3, 3, 3);
  assert.equal(world.get(2, 0, 3), null);
  assert.equal(world.count, 0);
});

test('rotated door turns its footprint onto z', () => {
  const world = new World();
  assert.ok(world.place('door_shop', SIZE.DOOR, 5, 0, 5, 1));
  assert.ok(world.get(5, 3, 6));
  assert.equal(world.get(6, 0, 5), null);
});

test('toggle swaps phases and collision follows', () => {
  const world = new World();
  world.place('door_white', SIZE.DOOR, 0, 0, 0, 0);
  const v = world.get(1, 2, 0);
  assert.ok(isDoorVoxel(v));
  assert.ok(!isOpenDoor(v));
  assert.equal(doorToggleId('door_white'), 'door_white_open');
  assert.ok(canToggle(v, 'player'));
  assert.ok(!canToggle(v, 'mob'));

  const solid = collisionWorld(world);
  assert.ok(solid.get(0, 0, 0));
  world.drainEdits();

  assert.ok(toggleDoor(world, v));
  assert.equal(v.type, 'door_white_open');
  assert.ok(isOpenDoor(v));
  assert.ok(isPassable(v.type));
  // open door: cells stay occupied in the raw world but stop colliding
  assert.ok(world.get(0, 0, 0));
  assert.equal(solid.get(0, 0, 0), null);
  // renderer sync contract: an edit record for every footprint cell
  const edits = world.drainEdits();
  assert.equal(edits.length, 1);
  assert.equal(edits[0].cells.length, 8);

  assert.ok(toggleDoor(world, v));
  assert.equal(v.type, 'door_white');
  assert.ok(solid.get(0, 0, 0));
});

test('open doors are normalized to closed in saves, size survives', () => {
  const world = new World();
  world.place('door_wood', SIZE.DOOR, 4, 0, 4, 1);
  toggleDoor(world, world.get(4, 0, 4));
  const data = JSON.parse(serialize(world));
  assert.equal(data.blocks.length, 1);
  assert.equal(data.blocks[0].type, 'door_wood');
  assert.equal(data.blocks[0].size, 'door');
  assert.equal(data.blocks[0].rotation, 1);

  const { world: loaded, errors } = deserialize(serialize(world));
  assert.deepEqual(errors, []);
  const v = loaded.get(4, 3, 5);
  assert.ok(v);
  assert.equal(v.type, 'door_wood');
  assert.equal(v.size, SIZE.DOOR);
  assert.equal(v.rotation, 1);
});

test('door tiles claim 2x4 atlas slots and the atlas still packs', () => {
  assert.deepEqual(tileSpan('door_wood'), [2, 4]);
  assert.deepEqual(tileSpan('door_white'), [2, 4]);
  assert.deepEqual(tileSpan('door_shop'), [2, 4]);
  assert.deepEqual(tileSpan('door_blok'), [2, 4]);
  assert.deepEqual(tileSpan('sidelight'), [1, 2]);
  const { map } = renderAtlasRGBA(); // throws if the atlas overflows
  assert.ok(map.has('door_wood'));
  assert.ok(map.has('door_shop'));
  assert.ok(map.has('door_blok'));
  assert.ok(map.has('sidelight'));
});

test('mesher emits a centered slab with thickness, swung when open', () => {
  assert.equal(shapeFor('door_wood'), 'door');
  const tileIndexFor = () => 0;
  const atlas = { width: 8, height: 24 };
  const mesh = (type) => {
    const voxel = { type, size: SIZE.DOOR, rotation: 0, anchor: [0, 0, 0] };
    const stub = { get: (x, y, z) => (x >= 0 && x < 2 && y >= 0 && y < 4 && z === 0 ? voxel : null) };
    return buildChunkMesh(stub, null, [0, 0, 0], 4, tileIndexFor, atlas);
  };
  const bounds = (positions, axis) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = axis; i < positions.length; i += 3) {
      lo = Math.min(lo, positions[i]);
      hi = Math.max(hi, positions[i]);
    }
    return [lo, hi];
  };

  const closed = mesh('door_wood');
  assert.ok(closed.positions.length > 0);
  // closed: full 1m x 2m leaf, thin and centered in the cell depth (0.25m)
  assert.deepEqual(bounds(closed.positions, 0), [0, 1]);
  assert.deepEqual(bounds(closed.positions, 1), [0, 2]);
  const [zLo, zHi] = bounds(closed.positions, 2);
  assert.ok(zLo > 0.15 && zHi < 0.35, `closed leaf centered, got ${zLo}..${zHi}`);
  assert.ok(Math.abs(zHi - zLo - 0.12) < 1e-6, 'leaf is 12cm thick');

  const open = mesh('door_wood_open');
  // open: swung 90° — thin in x, running ~1m along z past the hinge
  const [oxLo, oxHi] = bounds(open.positions, 0);
  assert.ok(Math.abs(oxHi - oxLo - 0.12) < 1e-6, 'open leaf is 12cm thick');
  const [ozLo, ozHi] = bounds(open.positions, 2);
  assert.ok(Math.abs(ozHi - ozLo - 1) < 1e-6, 'open leaf is 1m long');
});

test('closed leaf is lit per side: bright toward the light, dark behind', () => {
  const tileIndexFor = () => 0;
  const atlas = { width: 8, height: 24 };
  const voxel = { type: 'door_wood', size: SIZE.DOOR, rotation: 0, anchor: [0, 0, 0] };
  const stub = { get: (x, y, z) => (x >= 0 && x < 2 && y >= 0 && y < 4 && z === 0 ? voxel : null) };
  // Daylight on +z, darkness on -z. The closed leaf's own cells are
  // light-opaque (they read 0), so each big face must sample the cell
  // beyond it: the +z face reads full sky, the -z face stays dark.
  const lf = { skyAt: (x, y, z) => (z > 0 ? 15 : 0), blockAt: () => 0 };
  const m = buildChunkMesh(stub, lf, [0, 0, 0], 4, tileIndexFor, atlas);
  let front = 0;
  let back = 0;
  for (let i = 0; i < m.normals.length / 3; i++) {
    const nz = m.normals[i * 3 + 2];
    const ls = m.lights[i * 2];
    if (nz === 1) { front++; assert.equal(ls, 1, 'sunlit face reads full daylight'); }
    if (nz === -1) { back++; assert.equal(ls, 0, 'back face stays dark'); }
  }
  assert.ok(front >= 4 && back >= 4, 'both big faces were meshed');
});

test('closed doors block the mob navmesh, open doors let it through', () => {
  const world = new World();
  // floor
  for (let x = 0; x <= 5; x++) {
    for (let z = 0; z <= 6; z++) world.place('concrete', SIZE.SMALL, x, 0, z);
  }
  // wall across z=3, four cells high, with a 2-cell doorway at x=2..3
  for (let x = 0; x <= 5; x++) {
    if (x === 2 || x === 3) continue;
    for (let y = 1; y <= 4; y++) world.place('brick', SIZE.SMALL, x, y, 3);
  }
  assert.ok(world.place('door_wood', SIZE.DOOR, 2, 1, 3, 0));

  const opts = { halfWidth: 0.25, height: 1.7 };
  const closedNav = new NavMesh(collisionWorld(world), opts);
  const from = closedNav.nearestNodeAtCell(1, 1, 1);
  const to = closedNav.nearestNodeAtCell(1, 5, 1);
  assert.ok(from && to);
  assert.equal(closedNav.findPath(from, to), null, 'closed door seals the doorway');

  toggleDoor(world, world.get(2, 1, 3));
  const openNav = new NavMesh(collisionWorld(world), opts);
  const from2 = openNav.nearestNodeAtCell(1, 1, 1);
  const to2 = openNav.nearestNodeAtCell(1, 5, 1);
  assert.ok(from2 && to2);
  const path = openNav.findPath(from2, to2);
  assert.ok(Array.isArray(path) && path.length > 0, 'open door is walkable');
});

test('door defs are wired symmetrically', () => {
  for (const id of ['door_wood', 'door_white', 'door_shop']) {
    const closed = getBlock(id);
    const open = getBlock(closed.doorOpen);
    assert.ok(open, `${id} has an open phase`);
    assert.equal(open.doorClosed, id);
    assert.equal(open.hidden, true);
    assert.equal(open.passable, true);
    assert.equal(open.shootThrough, true);
    assert.equal(closed.passable, undefined);
    assert.equal(closed.fixedSize, SIZE.DOOR);
    assert.deepEqual(closed.tileSpan, [2, 4]);
    assert.equal(shapeFor(id), 'door');
    assert.equal(shapeFor(closed.doorOpen), 'door');
  }
});

test('sidelight size spans 1x2x1 and turns with odd rotations', () => {
  assert.deepEqual(spanVecFor(SIZE.SIDELIGHT, 0), [1, 2, 1]);
  assert.deepEqual(spanVecFor(SIZE.SIDELIGHT, 1), [1, 2, 1]);
  assert.equal(cellsFor(0, 0, 0, SIZE.SIDELIGHT, 0).length, 2);
});

test('sidelight is a fixed glazed panel, not a door', () => {
  const def = getBlock('sidelight');
  assert.equal(def.shape, 'door'); // meshed as a slab
  assert.equal(def.fixedSize, SIZE.SIDELIGHT);
  assert.equal(def.opacity, 0); // glazed: light passes
  assert.equal(def.doorOpen, undefined);
  assert.equal(def.doorClosed, undefined);
  const world = new World();
  assert.ok(world.place('sidelight', SIZE.SIDELIGHT, 0, 0, 0, 0));
  const v = world.get(0, 0, 0);
  assert.ok(!isDoorVoxel(v));
  assert.ok(!canToggle(v, 'player'));
  assert.equal(toggleDoor(world, v), false);
});

test('blok entrance is a 2x4 leaf beside fixed sidelights', () => {
  const closed = getBlock('door_blok');
  assert.equal(closed.fixedSize, SIZE.DOOR);
  assert.deepEqual(closed.tileSpan, [2, 4]);
  const open = getBlock('door_blok_open');
  assert.equal(open.doorClosed, 'door_blok');
  assert.equal(open.passable, true);

  const world = new World();
  // doorway: leaf at z=0..1, sidelights stacked in the z=2 column
  assert.ok(world.place('door_blok', SIZE.DOOR, 0, 0, 0, 0));
  assert.ok(world.place('sidelight', SIZE.SIDELIGHT, 2, 0, 0, 0));
  assert.ok(world.place('sidelight', SIZE.SIDELIGHT, 2, 2, 0, 0));
  const solid = collisionWorld(world);
  assert.ok(solid.get(0, 0, 0)); // closed leaf blocks
  assert.ok(solid.get(2, 0, 0)); // sidelight always blocks
  const leaf = world.get(0, 0, 0);
  assert.ok(toggleDoor(world, leaf));
  assert.equal(solid.get(0, 0, 0), null); // open leaf is passable
  assert.ok(solid.get(2, 0, 0)); // ...the sidelight is not
});

// --- editor-authored door settings: lock + opening direction ---

test('a locked door refuses to be opened by anyone', () => {
  const world = new World();
  world.place('door_wood', SIZE.DOOR, 0, 0, 0, 0);
  const v = world.get(0, 0, 0);
  assert.equal(isDoorLocked(v), false);
  assert.ok(canToggle(v, 'player'));

  assert.ok(setDoorLocked(v, true));
  assert.equal(setDoorLocked(v, true), false, 'no-op when already locked');
  assert.ok(isDoorLocked(v));
  assert.equal(canToggle(v, 'player'), false);
  assert.equal(canToggle(v, 'mob'), false);

  assert.ok(setDoorLocked(v, false));
  assert.equal(v.locked, undefined, 'unlocking drops the field entirely');
  assert.ok(canToggle(v, 'player'));
});

test('opening direction flips the swing without moving the footprint', () => {
  const world = new World();
  world.place('door_wood', SIZE.DOOR, 2, 0, 3, 0);
  const v = world.get(2, 0, 3);
  assert.equal(doorHinge(v), 'left');
  assert.equal(doorSwing(v), 'pz');
  const cells = () => {
    const out = [];
    world.forEachCell((x, y, z) => out.push(`${x},${y},${z}`));
    return out.sort().join('|');
  };
  const before = cells();

  world.drainDirty();
  world.drainEdits(); // clear the placement's own record
  assert.ok(setDoorOpening(world, v, { hinge: 'right', swing: 'nz' }));
  assert.equal(v.hinge, 'right');
  assert.equal(v.rotation, 2);
  assert.equal(doorSwing(v), 'nz');
  assert.equal(cells(), before, 'the door occupies exactly the same cells');
  assert.ok(world.drainDirty().length > 0, 'chunks are re-meshed');
  // No light edit: opacity did not change, only the leaf's cut.
  assert.deepEqual(world.drainEdits(), []);

  // Idempotent, and the parity (which axis the leaf stands on) is untouched.
  assert.equal(setDoorOpening(world, v, { hinge: 'right', swing: 'nz' }), false);
  assert.ok(setDoorOpening(world, v, { swing: 'px' }), 'a face on the other axis still means "positive"');
  assert.equal(v.rotation, undefined, 'rotation 0 is dropped, like a fresh placement');
  assert.equal(doorSwing(v), 'pz');
  assert.deepEqual(spanVecFor(v.size, v.rotation ?? 0), [2, 4, 1]);

  assert.ok(setDoorOpening(world, v, { hinge: 'left' }));
  assert.equal(v.hinge, undefined, 'the default hinge is not stored');
  assert.equal(setDoorOpening(world, v, { hinge: 'nonsense' }), false);
});

test('door settings survive the save roundtrip and stay off default doors', () => {
  const world = new World();
  world.place('door_wood', SIZE.DOOR, 0, 0, 0, 0);
  world.place('door_white', SIZE.DOOR, 4, 0, 0, 1);
  const plain = world.get(0, 0, 0);
  const fancy = world.get(4, 0, 0);
  setDoorLocked(fancy, true);
  setDoorOpening(world, fancy, { hinge: 'right', swing: 'nx' });

  const data = JSON.parse(serialize(world));
  const entry = (x) => data.blocks.find((b) => b.x === x);
  assert.equal(entry(0).locked, undefined, 'untouched doors stay byte-identical');
  assert.equal(entry(0).hinge, undefined);
  assert.equal(entry(4).locked, true);
  assert.equal(entry(4).hinge, 'right');
  assert.equal(entry(4).rotation, 3);

  const { world: loaded, errors } = deserialize(serialize(world));
  assert.deepEqual(errors, []);
  assert.equal(isDoorLocked(loaded.get(0, 0, 0)), false);
  const back = loaded.get(4, 0, 0);
  assert.ok(isDoorLocked(back));
  assert.equal(doorHinge(back), 'right');
  assert.equal(doorSwing(back), 'nx');
  assert.equal(plain.type, 'door_wood');
});

test('applyDoorSettings ignores non-doors and absent fields', () => {
  const world = new World();
  world.place('brick', SIZE.SMALL, 0, 0, 0);
  const brick = world.get(0, 0, 0);
  applyDoorSettings(brick, { locked: true, hinge: 'right' });
  assert.equal(brick.locked, undefined);
  assert.equal(brick.hinge, undefined);

  world.place('door_wood', SIZE.DOOR, 2, 0, 0, 0);
  const door = world.get(2, 0, 0);
  applyDoorSettings(door, {});
  assert.equal(door.locked, undefined);
  applyDoorSettings(door, { locked: true, hinge: 'right' });
  assert.ok(isDoorLocked(door));
  assert.equal(doorHinge(door), 'right');
});

test('prefabs carry door settings through save, load and stamping', () => {
  const source = new World();
  source.place('door_wood', SIZE.DOOR, 0, 0, 0, 0);
  const authored = source.get(0, 0, 0);
  setDoorLocked(authored, true);
  setDoorOpening(source, authored, { hinge: 'right' });

  const { prefab } = serializePrefab(source, { id: 'p', name: 'P', dims: [4, 4, 4] });
  assert.equal(prefab.blocks[0].locked, true);
  assert.equal(prefab.blocks[0].hinge, 'right');
  const { prefab: reloaded } = deserializePrefab(JSON.stringify(prefab));

  const target = new World();
  // A quarter turn moves the building; the hinge rides with the leaf.
  stampPrefab(target, reloaded, [10, 0, 10], 1);
  let stamped = null;
  target.forEachVoxel((v) => {
    if (isDoorVoxel(v)) stamped = v;
  });
  assert.ok(stamped, 'the door landed');
  assert.ok(isDoorLocked(stamped));
  assert.equal(doorHinge(stamped), 'right');
});

test('a mirrored prefab re-hangs only the doors whose leaf crosses the mirror', () => {
  const source = new World();
  source.place('door_wood', SIZE.DOOR, 0, 0, 0, 0); // leaf along x — reflected
  setDoorOpening(source, source.get(0, 0, 0), { hinge: 'right' });
  source.place('door_wood', SIZE.DOOR, 0, 0, 2, 1); // leaf along z — in the plane
  setDoorOpening(source, source.get(0, 0, 2), { hinge: 'right' });

  const { prefab } = serializePrefab(source, { id: 'p', name: 'P', dims: [4, 4, 4] });
  const target = new World();
  stampPrefab(target, prefab, [0, 0, 0], 0, true);

  const alongX = target.get(2, 0, 0); // x -> W-sx-x = 4-2-0
  const alongZ = target.get(3, 0, 2); // x -> 4-1-0
  assert.ok(isDoorVoxel(alongX) && isDoorVoxel(alongZ), 'both doors landed');
  // The x leaf's two ends swapped, so the far jamb is now the near one.
  assert.equal(doorHinge(alongX), 'left');
  // The z leaf kept its ends (and its swing flipped instead: px -> nx).
  assert.equal(doorHinge(alongZ), 'right');
  assert.equal(doorSwing(alongZ), 'nx');
  assert.equal(doorSwing(alongX), 'pz');
});

test('a right-hung leaf swings from the far jamb and mirrors its art', () => {
  const tileIndexFor = () => 0;
  const atlas = { width: 8, height: 24 };
  const mesh = (type, extra) => {
    const voxel = { type, size: SIZE.DOOR, rotation: 0, anchor: [0, 0, 0], ...extra };
    const stub = { get: (x, y, z) => (x >= 0 && x < 2 && y >= 0 && y < 4 && z === 0 ? voxel : null) };
    return buildChunkMesh(stub, null, [0, 0, 0], 4, tileIndexFor, atlas);
  };
  const bounds = (positions, axis) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = axis; i < positions.length; i += 3) {
      lo = Math.min(lo, positions[i]);
      hi = Math.max(hi, positions[i]);
    }
    return [lo, hi];
  };

  // Open: the leaf hugs whichever jamb it hinges on (the opening is 0..1 m),
  // floated 1 cm off it so it never z-fights the wall it folds back against.
  const GAP = 0.01;
  const [lLo, lHi] = bounds(mesh('door_wood_open').positions, 0);
  assert.ok(Math.abs(lLo - GAP) < 1e-6 && Math.abs(lHi - (0.12 + GAP)) < 1e-6, `left-hung leaf at the near jamb, got ${lLo}..${lHi}`);
  const [rLo, rHi] = bounds(mesh('door_wood_open', { hinge: 'right' }).positions, 0);
  assert.ok(Math.abs(rLo - (0.88 - GAP)) < 1e-6 && Math.abs(rHi - (1 - GAP)) < 1e-6, `right-hung leaf at the far jamb, got ${rLo}..${rHi}`);
  // Both swing the same way (rotation 0 = toward +z), 1 m deep.
  const [zLo, zHi] = bounds(mesh('door_wood_open', { hinge: 'right' }).positions, 2);
  assert.ok(Math.abs(zHi - zLo - 1) < 1e-6 && zLo > 0.1);

  // Closed: same geometry either way, but the art is mirrored so the handle
  // ends up on the other side.
  const closedL = mesh('door_wood');
  const closedR = mesh('door_wood', { hinge: 'right' });
  assert.deepEqual([...closedR.positions], [...closedL.positions]);
  assert.notDeepEqual([...closedR.uvs], [...closedL.uvs]);
  assert.deepEqual([...closedR.uvs].sort(), [...closedL.uvs].sort(), 'mirrored, not re-mapped');
});

test('the plan gizmo pivots on the hinge and sweeps toward the swing side', () => {
  const world = new World();
  world.place('door_wood', SIZE.DOOR, 2, 0, 3, 0);
  const v = world.get(2, 0, 3);
  // Left-hung, opening toward +z: hinge on the low-x jamb, leaf swings south.
  let p = doorPlanPoints(v);
  assert.deepEqual(p.hinge, [2, 3.5]);
  assert.deepEqual(p.closed, [4, 3.5]);
  assert.deepEqual(p.open, [2, 5.5]);

  setDoorOpening(world, v, { hinge: 'right', swing: 'nz' });
  p = doorPlanPoints(v);
  assert.deepEqual(p.hinge, [4, 3.5]);
  assert.deepEqual(p.closed, [2, 3.5]);
  assert.deepEqual(p.open, [4, 1.5]);

  // A door standing along z hinges on a z jamb and swings along x.
  const w2 = new World();
  w2.place('door_wood', SIZE.DOOR, 0, 0, 0, 1);
  const q = doorPlanPoints(w2.get(0, 0, 0));
  assert.deepEqual(q.hinge, [0.5, 0]);
  assert.deepEqual(q.closed, [0.5, 2]);
  assert.deepEqual(q.open, [2.5, 0]);
});

test('the settings window offers the four openings of the door’s own axis', () => {
  const alongX = doorOpenings(true);
  assert.equal(alongX.length, 4);
  assert.deepEqual(alongX.map((o) => `${o.hinge}/${o.swing}`).sort(),
    ['left/nz', 'left/pz', 'right/nz', 'right/pz']);
  assert.deepEqual(alongX.map((o) => `${o.hingeSide}/${o.swingSide}`).sort(),
    ['east/north', 'east/south', 'west/north', 'west/south']);
  // The leaf of a rotation 1/3 door stands along z, so it swings east/west.
  assert.deepEqual(doorOpenings(false).map((o) => o.swingSide).sort(),
    ['east', 'east', 'west', 'west']);
  assert.deepEqual(doorOpenings(false).map((o) => o.hingeSide).sort(),
    ['north', 'north', 'south', 'south']);
});

test('sidelight meshes as a thin glazed slab, 0.5m wide x 1m tall', () => {
  const tileIndexFor = () => 0;
  const atlas = { width: 8, height: 24 };
  const voxel = { type: 'sidelight', size: SIZE.SIDELIGHT, rotation: 0, anchor: [0, 0, 0] };
  const stub = { get: (x, y, z) => (x === 0 && y >= 0 && y < 2 && z === 0 ? voxel : null) };
  const mesh = buildChunkMesh(stub, null, [0, 0, 0], 4, tileIndexFor, atlas);
  const bounds = (positions, axis) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = axis; i < positions.length; i += 3) {
      lo = Math.min(lo, positions[i]);
      hi = Math.max(hi, positions[i]);
    }
    return [lo, hi];
  };
  assert.deepEqual(bounds(mesh.positions, 0), [0, 0.5]);
  assert.deepEqual(bounds(mesh.positions, 1), [0, 1]);
  const [zLo, zHi] = bounds(mesh.positions, 2);
  assert.ok(Math.abs(zHi - zLo - 0.12) < 1e-6, 'panel is 12cm thick');
  // glazed panel: solid frame texels depth-write, glass blends
  assert.ok(mesh.transparent, 'glass texels mesh into the transparent pass');
});
