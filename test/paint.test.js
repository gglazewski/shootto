// paint.test.js — per-face texture painting: storage, meshing, undo,
// serialization and prefab round-trips.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { buildChunkMesh } from '../src/engine/ChunkMeshBuilder.js';
import { paintFacesCommand } from '../src/editor/commands.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';
import { serializePrefab, deserializePrefab } from '../src/persistence/PrefabSerializer.js';
import { prefabPlacements, stampPrefab, unstampPrefab } from '../src/engine/PrefabStamp.js';
import { translatePrefabContent } from '../src/editor/prefabResize.js';
import { faceCells } from '../src/editor/tools/PaintTool.js';

const ATLAS = { width: 8, height: 4, tileSize: 16 };
const IDX = { brick: 0, grass: 1, stone: 2, wood: 3, concrete: 4 };
const lit = { skyAt: () => 15, blockAt: () => 0 };

/** Tile resolver that only cares about the block id, so a quad's UV column
 *  identifies which BLOCK's texture it drew. */
function tracer() {
  const calls = [];
  const fn = (type, face) => {
    calls.push(`${type}|${face}`);
    return IDX[type] ?? 7;
  };
  return { fn, calls };
}

/** Atlas column of quad `q` — quads come out in FACE_TABLE order:
 *  px, nx, py, ny, pz, nz. */
function tileOf(mesh, q) {
  let min = Infinity;
  for (let i = 0; i < 4; i++) min = Math.min(min, mesh.uvs[q * 8 + i * 2]);
  return Math.floor(min * ATLAS.width + 0.01);
}

describe('World face paint', () => {
  test('paints, reads back and strips a face', () => {
    const w = new World();
    w.place('brick', SIZE.SMALL, 0, 0, 0);

    assert.equal(w.paintCount, 0);
    assert.equal(w.paintAt(0, 0, 0, 'py'), null);

    assert.equal(w.paintFace(0, 0, 0, 'py', 'grass'), true);
    assert.equal(w.paintAt(0, 0, 0, 'py'), 'grass');
    assert.equal(w.paintCount, 1);
    assert.deepEqual(w.paintFor(0, 0, 0), { py: 'grass' });

    // Repainting the same face with the same block is a no-op, with another
    // block it swaps in place (still one painted face).
    assert.equal(w.paintFace(0, 0, 0, 'py', 'grass'), false);
    assert.equal(w.paintFace(0, 0, 0, 'py', 'stone'), true);
    assert.equal(w.paintCount, 1);

    assert.equal(w.unpaintFace(0, 0, 0, 'py'), 'stone');
    assert.equal(w.paintCount, 0);
    assert.equal(w.paintFor(0, 0, 0), null);
    assert.equal(w.unpaintFace(0, 0, 0, 'py'), null, 'stripping twice is a no-op');
  });

  test('every face of a block can carry a different texture', () => {
    const w = new World();
    w.place('brick', SIZE.SMALL, 2, 3, 4);
    const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
    const paints = ['grass', 'stone', 'wood', 'concrete', 'grass', 'stone'];
    faces.forEach((f, i) => assert.equal(w.paintFace(2, 3, 4, f, paints[i]), true));
    assert.equal(w.paintCount, 6);
    faces.forEach((f, i) => assert.equal(w.paintAt(2, 3, 4, f), paints[i]));

    const seen = [];
    w.forEachPaint((p) => seen.push(`${p.x},${p.y},${p.z},${p.face},${p.type}`));
    assert.equal(seen.length, 6);
    assert.ok(seen.includes('2,3,4,ny,concrete'));
  });

  test('rejects paint with no block, a bad face, an unknown id or a non-cube', () => {
    const w = new World();
    w.place('brick', SIZE.SMALL, 0, 0, 0);
    w.place('fence', SIZE.SMALL, 1, 0, 0); // shape: 'pane'

    assert.equal(w.paintFace(9, 9, 9, 'py', 'grass'), false, 'empty cell');
    assert.equal(w.paintFace(0, 0, 0, 'top', 'grass'), false, 'bad face name');
    assert.equal(w.paintFace(0, 0, 0, 'py', 'not_a_block'), false, 'unknown block');
    assert.equal(w.paintFace(1, 0, 0, 'py', 'grass'), false, 'panes mesh as a slab');
    assert.equal(w.paintCount, 0);
  });

  test('removing a block strips the paint off all its cells', () => {
    const w = new World();
    w.place('brick', SIZE.BIG, 0, 0, 0); // 2x2x2 cells
    w.paintFace(0, 0, 0, 'nx', 'grass');
    w.paintFace(0, 1, 0, 'nx', 'grass');
    assert.equal(w.paintCount, 2);

    w.remove(0, 0, 0);
    assert.equal(w.paintCount, 0);
    assert.equal(w.paint.size, 0);
    assert.equal(w.paintAt(0, 0, 0, 'nx'), null);
  });

  test('clear() and copyFrom() carry the paint', () => {
    const src = new World();
    src.place('brick', SIZE.SMALL, 1, 1, 1);
    src.paintFace(1, 1, 1, 'pz', 'wood');

    const dst = new World();
    dst.copyFrom(src);
    assert.equal(dst.paintAt(1, 1, 1, 'pz'), 'wood');
    assert.equal(dst.paintCount, 1);

    dst.clear();
    assert.equal(dst.paintCount, 0);
    assert.equal(dst.paint.size, 0);
  });

  test('painting marks the cell dirty so its chunk remeshes', () => {
    const w = new World();
    w.place('brick', SIZE.SMALL, 0, 0, 0);
    w.drainDirty();
    w.paintFace(0, 0, 0, 'py', 'grass');
    assert.ok(w.drainDirty().length > 0);
    w.unpaintFace(0, 0, 0, 'py');
    assert.ok(w.drainDirty().length > 0);
  });
});

describe('mesher face paint', () => {
  test('a painted face draws the painted block\'s tile, its siblings do not', () => {
    const w = new World();
    w.place('brick', SIZE.SMALL, 0, 0, 0);
    w.paintFace(0, 0, 0, 'py', 'grass');
    const { fn } = tracer();
    const m = buildChunkMesh(w, lit, [0, 0, 0], 16, fn, ATLAS);

    assert.equal(tileOf(m, 2), IDX.grass, 'py shows the paint');
    assert.equal(tileOf(m, 0), IDX.brick, 'px keeps the block\'s own tile');
    assert.equal(tileOf(m, 3), IDX.brick, 'ny keeps the block\'s own tile');
  });

  test('paint adds no geometry — a repainted world meshes to the same size', () => {
    const plain = new World();
    plain.place('brick', SIZE.SMALL, 0, 0, 0);
    const painted = new World();
    painted.place('brick', SIZE.SMALL, 0, 0, 0);
    for (const f of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) painted.paintFace(0, 0, 0, f, 'grass');

    const { fn } = tracer();
    const a = buildChunkMesh(plain, lit, [0, 0, 0], 16, fn, ATLAS);
    const b = buildChunkMesh(painted, lit, [0, 0, 0], 16, fn, ATLAS);
    assert.equal(b.positions.length, a.positions.length);
    assert.equal(b.indices.length, a.indices.length);
    assert.deepEqual([...b.positions], [...a.positions], 'paint never moves a vertex');
  });

  test('an unpainted world never touches the paint lookup', () => {
    const w = new World();
    w.place('brick', SIZE.SMALL, 0, 0, 0);
    let lookups = 0;
    const spy = Object.create(w);
    spy.paintFor = (...a) => {
      lookups++;
      return World.prototype.paintFor.apply(w, a);
    };
    const { fn } = tracer();
    buildChunkMesh(spy, lit, [0, 0, 0], 16, fn, ATLAS);
    assert.equal(lookups, 0, 'the fast path skips paint entirely');

    w.paintFace(0, 0, 0, 'py', 'grass');
    buildChunkMesh(spy, lit, [0, 0, 0], 16, fn, ATLAS);
    assert.equal(lookups, 1, 'one lookup per meshed voxel, not per face');
  });

  test('paint is not permuted by the voxel\'s own yaw', () => {
    // A rotated block permutes its own side tiles; the paint was picked by
    // looking AT the world face, so it must land on that face verbatim.
    const w = new World();
    w.place('wood', SIZE.SMALL, 0, 0, 0, 1);
    w.paintFace(0, 0, 0, 'px', 'grass');
    const { fn, calls } = tracer();
    const m = buildChunkMesh(w, lit, [0, 0, 0], 16, fn, ATLAS);
    assert.equal(tileOf(m, 0), IDX.grass);
    assert.ok(calls.includes('grass|px'));
    assert.ok(!calls.some((c) => c.startsWith('grass|') && c !== 'grass|px'));
  });

  test('painted faces still cull, light and take decals like any other', () => {
    const w = new World();
    w.place('brick', SIZE.SMALL, 0, 0, 0);
    w.place('brick', SIZE.SMALL, 1, 0, 0);
    // 0,0,0's +x face is buried by its neighbour: painting it emits nothing.
    w.paintFace(0, 0, 0, 'px', 'grass');
    const { fn, calls } = tracer();
    buildChunkMesh(w, lit, [0, 0, 0], 16, fn, ATLAS);
    assert.ok(!calls.includes('grass|px'), 'a hidden painted face costs nothing');
  });
});

describe('paintFacesCommand', () => {
  test('undo restores the previous paint, redo re-applies the stroke', () => {
    const w = new World();
    w.place('brick', SIZE.SMALL, 0, 0, 0);
    w.place('brick', SIZE.SMALL, 1, 0, 0);
    w.paintFace(0, 0, 0, 'py', 'wood'); // an older paint under the stroke

    const entries = [
      { cell: [0, 0, 0], face: 'py', type: 'grass', prev: 'wood' },
      { cell: [1, 0, 0], face: 'py', type: 'grass', prev: null },
    ];
    const cmd = paintFacesCommand(w, entries);
    assert.equal(cmd.do(), 2);
    assert.equal(w.paintAt(0, 0, 0, 'py'), 'grass');
    assert.equal(w.paintAt(1, 0, 0, 'py'), 'grass');

    cmd.undo();
    assert.equal(w.paintAt(0, 0, 0, 'py'), 'wood', 'the older paint comes back');
    assert.equal(w.paintAt(1, 0, 0, 'py'), null, 'the unpainted face goes bare');

    cmd.do();
    assert.equal(w.paintAt(1, 0, 0, 'py'), 'grass');
  });

  test('a stripping stroke undoes back to what it removed', () => {
    const w = new World();
    w.place('brick', SIZE.SMALL, 0, 0, 0);
    w.paintFace(0, 0, 0, 'nz', 'stone');
    const cmd = paintFacesCommand(w, [{ cell: [0, 0, 0], face: 'nz', type: null, prev: 'stone' }]);
    assert.equal(cmd.do(), 1);
    assert.equal(w.paintAt(0, 0, 0, 'nz'), null);
    cmd.undo();
    assert.equal(w.paintAt(0, 0, 0, 'nz'), 'stone');
  });
});

describe('PaintTool.faceCells', () => {
  test('a SMALL block is one cell, a BIG block paints its whole side', () => {
    const small = { size: SIZE.SMALL, anchor: [3, 4, 5], rotation: 0 };
    assert.deepEqual(faceCells(small, 'py'), [[3, 4, 5]]);

    const big = { size: SIZE.BIG, anchor: [0, 0, 0], rotation: 0 };
    const top = faceCells(big, 'py');
    assert.equal(top.length, 4, 'a 1 m block shows 4 cells per side');
    assert.ok(top.every(([, y]) => y === 1), 'the +y face is the upper layer');

    const west = faceCells(big, 'nx');
    assert.equal(west.length, 4);
    assert.ok(west.every(([x]) => x === 0), 'the -x face is the lower layer');
  });
});

describe('paint serialization', () => {
  test('round-trips through the world file', () => {
    const w = new World();
    w.place('brick', SIZE.SMALL, 2, 0, 3);
    w.paintFace(2, 0, 3, 'py', 'grass');
    w.paintFace(2, 0, 3, 'nz', 'wood');

    const json = JSON.parse(serialize(w));
    assert.equal(json.paint.length, 2);

    const { world, errors } = deserialize(JSON.stringify(json));
    assert.deepEqual(errors, []);
    assert.equal(world.paintAt(2, 0, 3, 'py'), 'grass');
    assert.equal(world.paintAt(2, 0, 3, 'nz'), 'wood');
    assert.equal(world.paintCount, 2);
  });

  test('unpainted maps stay free of the paint field', () => {
    const w = new World();
    w.place('brick', SIZE.SMALL, 0, 0, 0);
    assert.equal('paint' in JSON.parse(serialize(w)), false);
  });

  test('bad paint entries are skipped with an error, the rest still loads', () => {
    const w = new World();
    w.place('brick', SIZE.SMALL, 0, 0, 0);
    w.paintFace(0, 0, 0, 'py', 'grass');
    const data = JSON.parse(serialize(w));
    data.paint.push(
      { x: 0, y: 0, z: 0, face: 'sideways', type: 'grass' },
      { x: 0, y: 0, z: 0, face: 'ny', type: 'no_such_block' },
      { x: 40, y: 0, z: 0, face: 'ny', type: 'grass' }, // no block there
      { x: 'nope' },
    );
    const { world, errors } = deserialize(JSON.stringify(data));
    assert.equal(errors.length, 4);
    assert.equal(world.paintAt(0, 0, 0, 'py'), 'grass');
    assert.equal(world.paintCount, 1);
  });
});

describe('paint in prefabs', () => {
  const paintedPrefabWorld = () => {
    const w = new World();
    w.place('brick', SIZE.SMALL, 0, 0, 0);
    w.place('brick', SIZE.SMALL, 1, 0, 0);
    w.place('brick', SIZE.SMALL, 0, -1, 0); // baseplate — never saved
    w.paintFace(0, 0, 0, 'nz', 'grass');
    w.paintFace(0, -1, 0, 'py', 'stone');
    return w;
  };

  test('serializes inside the box and drops the baseplate', () => {
    const { prefab, outside } = serializePrefab(paintedPrefabWorld(), { id: 'p', name: 'P', dims: [4, 4, 4] });
    assert.equal(outside, 0);
    assert.deepEqual(prefab.paint, [{ x: 0, y: 0, z: 0, face: 'nz', type: 'grass' }]);

    const { prefab: back, errors } = deserializePrefab(JSON.stringify(prefab));
    assert.deepEqual(errors, []);
    assert.deepEqual(back.paint, prefab.paint);
  });

  test('unpainted prefabs stay free of the paint field', () => {
    const w = new World();
    w.place('brick', SIZE.SMALL, 0, 0, 0);
    const { prefab } = serializePrefab(w, { id: 'p', name: 'P', dims: [4, 4, 4] });
    assert.equal('paint' in prefab, false);
  });

  test('a rotated stamp turns the painted face with the building', () => {
    const prefab = {
      dims: [2, 1, 1],
      blocks: [{ x: 0, y: 0, z: 0, size: SIZE.SMALL, type: 'brick' }],
      items: [],
      decals: [],
      paint: [{ x: 0, y: 0, z: 0, face: 'px', type: 'grass' }],
    };
    // One CCW quarter turn maps px -> nz (PrefabStamp.rotateFace).
    const { paint } = prefabPlacements(prefab, [10, 0, 10], 1);
    assert.deepEqual(paint, [{ type: 'grass', x: 10, y: 0, z: 11, face: 'nz' }]);
  });

  test('stamping applies the paint and unstamping takes it away', () => {
    const prefab = {
      dims: [2, 1, 1],
      blocks: [{ x: 0, y: 0, z: 0, size: SIZE.SMALL, type: 'brick' }],
      items: [],
      decals: [],
      paint: [{ x: 0, y: 0, z: 0, face: 'py', type: 'grass' }],
    };
    const w = new World();
    const receipt = stampPrefab(w, prefab, [5, 0, 5], 0);
    assert.equal(receipt.skipped, 0);
    assert.equal(w.paintAt(5, 0, 5, 'py'), 'grass');

    unstampPrefab(w, receipt);
    assert.equal(w.paintCount, 0);
  });

  test('paint never lands on a block the stamp could not place', () => {
    const prefab = {
      dims: [1, 1, 1],
      blocks: [{ x: 0, y: 0, z: 0, size: SIZE.SMALL, type: 'brick' }],
      items: [],
      decals: [],
      paint: [{ x: 0, y: 0, z: 0, face: 'py', type: 'grass' }],
    };
    const w = new World();
    w.place('stone', SIZE.SMALL, 5, 0, 5); // the target cell is taken
    const receipt = stampPrefab(w, prefab, [5, 0, 5], 0);
    assert.equal(receipt.blocks.length, 0);
    assert.deepEqual(receipt.paint, []);
    assert.equal(w.paintCount, 0, 'the block that was already there keeps its own look');
  });

  test('resizing the build volume slides the paint with its blocks', () => {
    const w = new World();
    w.place('brick', SIZE.SMALL, 0, 0, 0);
    w.paintFace(0, 0, 0, 'pz', 'grass');
    translatePrefabContent(w, [2, 0, 1]);
    assert.equal(w.paintAt(0, 0, 0, 'pz'), null);
    assert.equal(w.paintAt(2, 0, 1, 'pz'), 'grass');
    assert.equal(w.paintCount, 1);
  });
});
