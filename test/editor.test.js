import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { Renderer } from '../src/engine/Renderer.js';
import { PostFX } from '../src/engine/PostFX.js';
import { ChunkMesh } from '../src/engine/ChunkMesh.js';
import { FlyControls, applyLook, clampPitch } from '../src/editor/FlyControls.js';
import { BuildTool } from '../src/editor/tools/BuildTool.js';
import { SquareTool } from '../src/editor/tools/SquareTool.js';
import { SpawnTool } from '../src/editor/tools/SpawnTool.js';
import { MobTool } from '../src/editor/tools/MobTool.js';
import { ItemTool } from '../src/editor/tools/ItemTool.js';
import { registerItem } from '../src/engine/ItemRegistry.js';
import { DecalTool, faceFromNormal } from '../src/editor/tools/DecalTool.js';
import { orthogonalLineAnchors } from '../src/editor/tools/line.js';
import { placeItemCommand, removeItemCommand } from '../src/editor/commands.js';
import { SelectionGhost } from '../src/editor/SelectionGhost.js';
import { EditorState } from '../src/editor/EditorState.js';
import { History } from '../src/editor/History.js';
import { resolveBinding } from '../src/editor/Keybindings.js';
import { ToolRing } from '../src/editor/ToolRing.js';
import { Toolbar } from '../src/editor/Toolbar.js';
import { Notice, onNotice } from '../src/editor/Notice.js';
import { tileFor } from '../src/engine/VoxelTypes.js';
import { renderAtlasRGBA, generateTilePixels, tilesForBlocks, listTileNames, TILE_SIZE, ATLAS_WIDTH, ATLAS_HEIGHT } from '../src/textures/TextureAtlas.js';

// --- pure helpers ---

test('applyLook yaws by mouse delta and clamps pitch', () => {
  let { yaw, pitch } = applyLook(0, 0, 100, 0, 0.01);
  assert.ok(yaw < 0); // moving mouse right turns view left in yaw space
  ({ yaw, pitch } = applyLook(0, 0, 0, 1e6, 0.01));
  assert.ok(pitch < -1.5 && pitch >= -Math.PI / 2); // mouse down looks down
  assert.equal(pitch, clampPitch(pitch));
});

test('clampPitch stays within +-90deg', () => {
  assert.equal(clampPitch(10), Math.PI / 2 - 0.01);
  assert.equal(clampPitch(-10), -(Math.PI / 2 - 0.01));
});

// --- selection ghost ---

test('ghost placement scales to voxel size and centers correctly', () => {
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  ghost.showPlacement([0, 0, 0], SIZE.SMALL, false);
  assert.equal(ghost.place.visible, true);
  assert.equal(ghost.place.scale.x, 0.5);
  assert.deepEqual([ghost.place.position.x, ghost.place.position.y, ghost.place.position.z], [0.25, 0.25, 0.25]);
  ghost.showPlacement([2, 0, 0], SIZE.BIG, true);
  assert.equal(ghost.place.scale.x, 1);
  assert.equal(ghost.place.material.color.getHexString(), 'ff5533');
  ghost.hide();
  assert.equal(ghost.place.visible, false);
  assert.equal(ghost.remove.visible, false);
});

// --- voxel tool ---

function makeTool() {
  const world = new World();
  world.place('grass', SIZE.SMALL, 0, 0, 0);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(5, 0.25, 0.25);
  camera.lookAt(0, 0.25, 0.25);
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ blockId: 'sand', size: SIZE.SMALL });
  const history = new History();
  const tool = new BuildTool({ THREE, world, camera, ghost, state, history, input: { isDown: () => false } });
  return { world, camera, tool, ghost, state, history };
}

test('tool picks the voxel under the crosshair', () => {
  const { tool } = makeTool();
  const hit = tool.pick();
  assert.ok(hit);
  assert.deepEqual(hit.cell, [0, 0, 0]);
});

test('tool places a small voxel next to the hit face', () => {
  const { world, tool } = makeTool();
  const r = tool.place();
  assert.equal(r.ok, true);
  assert.equal(world.get(1, 0, 0).type, 'sand');
  assert.equal(world.count, 2);
});

test('tool places a big voxel flush against a 1m grid face', () => {
  const world = new World();
  world.place('grass', SIZE.BIG, 2, 0, 0); // big block spanning cells 2..3 in x
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.75, 0.25, 0.25);
  camera.lookAt(2, 0.5, 0.5); // aim at the block's -x face (plane x=2)
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ blockId: 'sand', size: SIZE.SMALL });
  const tool = new BuildTool({ THREE, world, camera, ghost, state, history: new History(), input: { isDown: () => false } });
  tool.setSize(SIZE.BIG);
  const r = tool.place();
  assert.equal(r.ok, true);
  assert.deepEqual(r.anchor, [0, 0, 0]);
  assert.equal(world.get(1, 0, 0).size, SIZE.BIG);
});

test('big placement is rejected when it would overlap the clicked voxel', () => {
  const { world, tool } = makeTool();
  // clicking the +x face of grass at (0,0,0) would anchor a big cube at (0,0,0),
  // which overlaps the voxel you are clicking -> rejected
  tool.setSize(SIZE.BIG);
  const r = tool.place();
  assert.equal(r.ok, false);
  assert.equal(world.count, 1);
});

test('tool removes the whole voxel under the cursor', () => {
  const { world, tool } = makeTool();
  const r = tool.remove();
  assert.equal(r.ok, true);
  assert.equal(world.count, 0);
});

test('build tool places a block on top of a placed object', () => {
  const { world, camera, tool } = makeTool();
  world.placeItem('crate', SIZE.SMALL, 0, 1, 0); // object resting on the grass
  camera.position.set(0.25, 5, 0.25);
  camera.lookAt(0.25, 0.75, 0.26); // aim down at the crate's top face
  const r = tool.place();
  assert.equal(r.ok, true);
  assert.deepEqual(r.anchor, [0, 2, 0]);
  assert.equal(world.get(0, 2, 0).type, 'sand');
});

test('build tool RMB on a placed object removes nothing', () => {
  const { world, camera, tool } = makeTool();
  world.placeItem('crate', SIZE.SMALL, 0, 1, 0);
  camera.position.set(0.25, 5, 0.25);
  camera.lookAt(0.25, 0.75, 0.26);
  const r = tool.remove();
  assert.equal(r.ok, false);
  assert.ok(world.itemAt(0, 1, 0)); // the object survives
  assert.equal(world.count, 1); // so does the grass under it
});

test('item tool stacks an item on top of a placed item', () => {
  registerItem({ id: 'table', name: 'Table', size: SIZE.SMALL, microVoxels: [] });
  registerItem({ id: 'cup', name: 'Cup', size: SIZE.SMALL, microVoxels: [] });
  const world = new World();
  world.place('grass', SIZE.SMALL, 0, 0, 0);
  world.placeItem('table', SIZE.SMALL, 0, 1, 0);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.25, 5, 0.25);
  camera.lookAt(0.25, 0.75, 0.26); // aim down at the table's top face
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ itemId: 'cup' });
  const tool = new ItemTool({ THREE, world, camera, scene, ghost, state, history: new History() });

  // Hovering the table previews the placement above it AND outlines the
  // table for removal — stacking must be visible, not just possible.
  tool.update(0);
  assert.equal(ghost.remove.visible, true);
  assert.equal(tool._preview.group.visible, true);

  tool.onMouseDown(0);
  const cup = world.itemAt(0, 2, 0);
  assert.ok(cup, 'cup lands on the cell above the table');
  assert.equal(cup.itemId, 'cup');
});

test('updateGhost shows placement at target and removal outline', () => {
  const { tool, ghost } = makeTool();
  tool.updateGhost();
  assert.equal(ghost.place.visible, true);
  assert.equal(ghost.remove.visible, true);
  assert.deepEqual(
    [ghost.place.position.x, ghost.place.position.y, ghost.place.position.z],
    [1 * 0.5 + 0.25, 0.25, 0.25],
  );
});

// --- editor state ---

test('editor state notifies subscribers on change and is idempotent', () => {
  const state = new EditorState({ blockId: 'grass', size: SIZE.SMALL });
  const changes = [];
  const off = state.on((c) => changes.push(c.field));
  state.set('blockId', 'sand');
  state.set('size', SIZE.BIG);
  state.set('blockId', 'sand'); // no-op
  assert.deepEqual(changes, ['blockId', 'size']);
  off();
  state.set('blockId', 'wood');
  assert.deepEqual(changes, ['blockId', 'size']);
});

// --- history ---

test('history caps at max and supports undo/redo', () => {
  const h = new History({ max: 2 });
  const log = [];
  const mk = (n) => ({ do: () => log.push(`do${n}`), undo: () => log.push(`undo${n}`), description: `c${n}` });
  for (let i = 1; i <= 3; i++) {
    const c = mk(i);
    c.do();
    h.push(c);
  }
  assert.equal(h.length, 2); // oldest dropped beyond the cap
  h.undo();
  assert.equal(log.at(-1), 'undo3');
  assert.equal(h.canRedo, true);
  h.redo();
  assert.equal(log.at(-1), 'do3');
  assert.equal(h.canRedo, false);
  h.undo(); // undo3
  h.push({ do: () => log.push('do4'), undo: () => log.push('undo4'), description: 'c4' });
  assert.equal(h.canRedo, false, 'pushing after undo clears redo');
});

test('history undo/redo roundtrips world edits through commands', () => {
  const world = new World();
  const h = new History();
  const { do: doIt, undo, description } = (() => {
    let cmd;
    const place = (type, size, x, y, z) => {
      const c = { do: () => world.place(type, size, x, y, z), undo: () => world.remove(x, y, z), description: 'place' };
      c.do();
      h.push(c);
      cmd = c;
    };
    return { do: place, undo: () => { cmd.undo(); }, description: '' };
  })();
  doIt('grass', SIZE.SMALL, 0, 0, 0);
  assert.equal(world.count, 1);
  h.undo();
  assert.equal(world.count, 0);
  h.redo();
  assert.equal(world.count, 1);
});

test('item place/remove commands roundtrip through undo, notifying onChange', () => {
  const world = new World();
  const h = new History();
  let changes = 0;
  const onChange = () => changes++;

  const place = placeItemCommand(world, { itemId: 'lamp', size: SIZE.SMALL, anchor: [0, 0, 0], rotation: Math.PI / 2 }, onChange);
  assert.equal(place.do(), true);
  h.push(place);
  assert.equal(world.itemAt(0, 0, 0).itemId, 'lamp');
  assert.equal(changes, 1);

  h.undo();
  assert.equal(world.itemAt(0, 0, 0), null);
  assert.equal(changes, 2, 'undo refreshes item lights too');
  h.redo();
  assert.equal(world.itemAt(0, 0, 0).itemId, 'lamp');

  const item = world.itemAt(0, 0, 0);
  const remove = removeItemCommand(world, item, onChange);
  assert.equal(remove.do(), true);
  h.push(remove);
  assert.equal(world.itemAt(0, 0, 0), null);

  h.undo();
  const restored = world.itemAt(0, 0, 0);
  assert.equal(restored.itemId, 'lamp');
  assert.equal(restored.rotation, Math.PI / 2, 'rotation survives the roundtrip');
});

// --- build tool line mode ---

test('shift line is axis-constrained, locking non-dominant axes to the start', () => {
  // diagonal a->b: dominant X, so y/z stay at a's values
  const small = orthogonalLineAnchors([0, 1, 0], [4, 3, 0], 'small');
  assert.deepEqual(small, [[0, 1, 0], [1, 1, 0], [2, 1, 0], [3, 1, 0], [4, 1, 0]]);
  // dominant Y
  const vert = orthogonalLineAnchors([2, 0, 0], [2, 4, 0], 'small');
  assert.deepEqual(vert, [[2, 0, 0], [2, 1, 0], [2, 2, 0], [2, 3, 0], [2, 4, 0]]);
  // negative direction + big voxels (span 2)
  const big = orthogonalLineAnchors([6, 2, 0], [0, 2, 0], 'big');
  assert.deepEqual(big, [[6, 2, 0], [4, 2, 0], [2, 2, 0], [0, 2, 0]]);
});

function makeFloor() {
  const world = new World();
  for (let x = 0; x <= 4; x++) world.place('grass', SIZE.SMALL, x, 0, 0);
  return world;
}

test('build tool draws a line from the last placed voxel with shift', () => {
  const world = makeFloor();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.25, 2, 0.25);
  camera.lookAt(0.25, 0, 0.25); // straight down onto cell (0,0,0)
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ blockId: 'sand', size: SIZE.SMALL });
  const history = new History();
  const shiftDown = { isDown: (c) => c === 'ShiftLeft' || c === 'ShiftRight' };
  const tool = new BuildTool({ THREE, world, camera, ghost, state, history, input: shiftDown });

  const r1 = tool.place();
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.anchor, [0, 1, 0]);
  assert.deepEqual(tool.lastPlaced, r1.anchor);

  camera.position.set(2.25, 2, 0.25);
  camera.lookAt(2.25, 0, 0.25); // straight down onto cell (4,0,0)
  const r2 = tool.place();
  assert.equal(r2.ok, true);
  for (let x = 0; x <= 4; x++) assert.equal(world.get(x, 1, 0)?.type, 'sand', `cell ${x},1,0`);
  assert.equal(history.length, 2);
});

test('build tool places voxels with the selected block rotation', () => {
  const world = makeFloor();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.25, 2, 0.25);
  camera.lookAt(0.25, 0, 0.25);
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ blockId: 'asphalt_line', size: SIZE.SMALL, blockRotation: 1 });
  const history = new History();
  const tool = new BuildTool({ THREE, world, camera, ghost, state, history, input: { isDown: () => false } });

  const r = tool.place();
  assert.equal(r.ok, true);
  assert.equal(world.get(r.anchor[0], r.anchor[1], r.anchor[2]).rotation, 1);
  history.undo();
  assert.equal(world.get(r.anchor[0], r.anchor[1], r.anchor[2]), null);
});

test('placement ghost shows the textured block preview when an atlas is wired', () => {
  const world = makeFloor();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.25, 2, 0.25);
  camera.lookAt(0.25, 0, 0.25);
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({
    THREE, scene,
    atlasTexture: new THREE.Texture(),
    tileIndexFor: () => 0,
    atlas: { width: 8, height: 4 },
  });
  const state = new EditorState({ blockId: 'barricade', size: SIZE.SMALL, blockRotation: 0 });
  const tool = new BuildTool({ THREE, world, camera, ghost, state, history: new History(), input: { isDown: () => false } });

  tool.updateGhost();
  assert.equal(ghost.texPlace.visible, true, 'textured preview shown');
  assert.equal(ghost.place.visible, false, 'plain cube hidden');
  assert.equal(ghost.texPlace.geometry.attributes.position.count, 8, 'pane preview = one double-winded quad');
  const flat = [...ghost.texPlace.geometry.attributes.position.array];

  state.set('blockRotation', 1);
  tool.updateGhost();
  assert.notDeepEqual([...ghost.texPlace.geometry.attributes.position.array], flat,
    'rotating the block turns the pane preview');
});

test('line ghost keeps the aim cube and marks blocked cells red', () => {
  const world = makeFloor();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.25, 2, 0.25);
  camera.lookAt(0.25, 0, 0.25);
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ blockId: 'sand', size: SIZE.SMALL });
  const shiftDown = { isDown: (c) => c === 'ShiftLeft' || c === 'ShiftRight' };
  const tool = new BuildTool({ THREE, world, camera, ghost, state, history: new History(), input: shiftDown });

  tool.place(); // line anchor at (0,1,0)
  camera.position.set(2.25, 2, 0.25);
  camera.lookAt(2.25, 0, 0.25); // aim 4 cells along +x
  tool.updateGhost();

  assert.equal(ghost.place.visible, true, 'aim cube stays visible during a line preview');
  assert.equal(ghost.cells.visible, true, 'line cells shown');
  assert.equal(ghost.cells.count, 5);
  const c = new THREE.Color();
  ghost.cells.getColorAt(0, c);
  assert.ok(c.r > c.g, 'occupied start cell is red');
  ghost.cells.getColorAt(4, c);
  assert.ok(c.g > c.r, 'free end cell is green');
});

// --- decal tool ---

test('decal tool pins a decal to the aimed face, with undo and RMB removal', () => {
  const world = makeFloor();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.25, 2, 0.25);
  camera.lookAt(0.25, 0, 0.25); // straight down onto the top face of (0,0,0)
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({
    THREE, scene,
    atlasTexture: new THREE.Texture(),
    tileIndexFor: () => 0,
    atlas: { width: 8, height: 4 },
  });
  const state = new EditorState({ decalId: 'decal_blood', decalRotation: 1 });
  const history = new History();
  const tool = new DecalTool({ THREE, world, camera, ghost, state, history, input: { isDown: () => false } });

  assert.equal(faceFromNormal([0, 1, 0]), 'py');
  tool.update(0.016);
  assert.equal(ghost.texPlace.visible, true, 'decal ghost previews on the face');

  tool.onMouseDown(0);
  const d = world.decalAt(0, 0, 0, 'py');
  assert.equal(d.decalId, 'decal_blood');
  assert.equal(d.rotation, 1);
  history.undo();
  assert.equal(world.decalAt(0, 0, 0, 'py'), null, 'placement is undoable');

  world.placeDecal('decal_crack', 0, 0, 0, 'py');
  tool.onMouseDown(2); // RMB peels the decal off
  assert.equal(world.decalAt(0, 0, 0, 'py'), null);
  history.undo();
  assert.equal(world.decalAt(0, 0, 0, 'py').decalId, 'decal_crack', 'removal is undoable');
});

// --- square tool ---

test('square tool drag places a rectangle on the plane of the clicked face', () => {
  const world = makeFloor();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.25, 2, 0.25);
  camera.lookAt(0.25, 0, 0.25);
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ blockId: 'concrete', size: SIZE.SMALL });
  const history = new History();
  const tool = new SquareTool({ THREE, world, camera, ghost, state, history, input: { isDown: () => false } });

  tool.onMouseDown(0); // start drag on the top face plane (y=1)
  camera.position.set(2.25, 2, 0.25);
  camera.lookAt(2.25, 0, 0.25);
  tool.update(0.016); // refresh the drag end corner
  tool.onMouseUp(0); // commit

  assert.equal(world.get(0, 1, 0)?.type, 'concrete');
  assert.equal(world.get(4, 1, 0)?.type, 'concrete');
  assert.equal(world.get(2, 1, 0)?.type, 'concrete');
  assert.equal(history.length, 1);
});

test('build tool RMB cancels a pending line preview instead of removing', () => {
  const world = makeFloor();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.25, 2, 0.25);
  camera.lookAt(0.25, 0, 0.25);
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ blockId: 'sand', size: SIZE.SMALL });
  const history = new History();
  const shiftDown = { isDown: (c) => c === 'ShiftLeft' || c === 'ShiftRight' };
  const tool = new BuildTool({ THREE, world, camera, ghost, state, history, input: shiftDown });

  const before = world.count;
  const r = tool.place(); // starts the line anchor
  assert.equal(r.ok, true);
  assert.equal(world.count, before + 1);

  tool.onMouseDown(2); // RMB while a line is pending -> cancel, not remove
  assert.equal(tool.lastPlaced, null, 'line anchor must be cleared');
  assert.equal(world.count, before + 1, 'RMB cancel must not remove a voxel');
});

test('build tool RMB click-and-release removes one voxel as a plain undoable removal', () => {
  const { world, tool, history } = makeTool();
  tool.onMouseDown(2);
  tool.onMouseUp(2);
  assert.equal(world.count, 0);
  assert.equal(history.length, 1);
  history.undo();
  assert.equal(world.count, 1);
});

test('build tool hold-RMB sweep erases every voxel the aim moves onto as one undo step', () => {
  const world = makeFloor(); // grass at (0..4, 0, 0)
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.25, 2, 0.25);
  camera.lookAt(0.25, 0, 0.25); // straight down onto cell (0,0,0)
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ blockId: 'sand', size: SIZE.SMALL });
  const history = new History();
  const tool = new BuildTool({ THREE, world, camera, ghost, state, history, input: { isDown: () => false } });

  tool.onMouseDown(2); // stroke opens: the first voxel goes immediately
  assert.equal(world.count, 4);
  assert.equal(history.length, 0, 'stroke still open - nothing on history yet');

  tool.update(0.016);
  tool.update(0.016);
  assert.equal(world.count, 4, 'holding still must not drill deeper');

  // Strafe sideways: every new column under the crosshair goes.
  camera.position.set(1.25, 2, 0.25); // over cell (2,0,0)
  tool.update(0.016);
  assert.equal(world.count, 3);
  camera.position.set(2.25, 2, 0.25); // over cell (4,0,0)
  tool.update(0.016);
  assert.equal(world.count, 2);

  tool.onMouseUp(2);
  assert.equal(history.length, 1, 'the whole sweep must be ONE history entry');
  history.undo();
  assert.equal(world.count, 5, 'undo restores every swept voxel');
  history.redo();
  assert.equal(world.count, 2, 'redo removes them again');
});

test('build tool shift+RMB erases a straight line from the last removed voxel', () => {
  const world = makeFloor();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.25, 2, 0.25);
  camera.lookAt(0.25, 0, 0.25); // straight down onto cell (0,0,0)
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ blockId: 'sand', size: SIZE.SMALL });
  const history = new History();
  let shift = false;
  const input = { isDown: (c) => shift && (c === 'ShiftLeft' || c === 'ShiftRight') };
  const tool = new BuildTool({ THREE, world, camera, ghost, state, history, input });

  tool.onMouseDown(2); // plain removal anchors the erase line
  tool.onMouseUp(2);
  assert.equal(world.count, 4);
  assert.deepEqual(tool.lastRemoved, [0, 0, 0]);

  shift = true;
  camera.position.set(2.25, 2, 0.25); // over cell (4,0,0)
  tool.onMouseDown(2);
  assert.equal(world.count, 0, 'the whole row erases in one line');
  assert.equal(history.length, 2);
  history.undo();
  assert.equal(world.count, 4, 'undo restores the line');
});

// --- square tool: init on a voxel, orientation from camera ---

function makeSquareTool(world, cameraPos, lookAt) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(...cameraPos);
  camera.lookAt(...lookAt);
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ blockId: 'concrete', size: SIZE.SMALL });
  const tool = new SquareTool({ THREE, world, camera, ghost, state, history: new History(), input: { isDown: () => false } });
  return { world, camera, tool };
}

test('square tool does not start a drag in empty space (init must be on a voxel)', () => {
  const { tool } = makeSquareTool(new World(), [0.25, 2, 0.25], [0.25, 0, 0.25]);
  tool.onMouseDown(0);
  assert.equal(tool._drag, null);
});

test('square tool makes a horizontal square when the camera looks down', () => {
  const world = makeFloor();
  const { tool } = makeSquareTool(world, [0.25, 2, 0.25], [0.25, 0, 0.25]);
  tool.onMouseDown(0);
  assert.ok(tool._drag);
  assert.equal(tool._drag.axis, 1); // horizontal plane
  assert.deepEqual(tool._drag.start, [0, 1, 0]);
  tool.cancel();
});

test('square tool makes a vertical square when the camera looks forward', () => {
  const world = new World();
  world.place('grass', SIZE.SMALL, 0, 1, 0); // block at cell y=1 (world y 0.5..1.0)
  const { tool } = makeSquareTool(world, [5, 0.75, 0.25], [0, 0.75, 0.25]); // ray along -x at the block's level
  tool.onMouseDown(0);
  assert.ok(tool._drag);
  assert.equal(tool._drag.axis, 0); // vertical plane, fixed x
  assert.deepEqual(tool._drag.start, [1, 1, 0]);
  tool.cancel();
});

test('square tool keeps its plane locked while the camera moves mid-drag', () => {
  const world = makeFloor();
  const { camera, tool } = makeSquareTool(world, [0.25, 2, 0.25], [0.25, 0, 0.25]);
  tool.onMouseDown(0); // clicked a top face -> horizontal floor plane
  assert.equal(tool._drag.axis, 1);
  camera.position.set(0.25, 2, 2.25);
  camera.lookAt(0.25, 2, 0); // swing the camera level mid-drag
  tool.update(0.016);
  assert.equal(tool._drag.axis, 1, 'plane must stay locked for the whole drag');
  tool.cancel();
});

test('square tool with shift builds a wall from a top-face click', () => {
  const world = makeFloor();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(2, 2, 0.25);
  camera.lookAt(0.25, 0, 0.25); // down + toward -x: dominant horizontal axis is x
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ blockId: 'concrete', size: SIZE.SMALL });
  const shiftDown = { isDown: (c) => c === 'ShiftLeft' || c === 'ShiftRight' };
  const tool = new SquareTool({ THREE, world, camera, ghost, state, history: new History(), input: shiftDown });
  tool.onMouseDown(0);
  assert.ok(tool._drag);
  assert.equal(tool._drag.axis, 0, 'shift on a top face -> vertical wall facing the camera');
  tool.cancel();
});

test('square tool far corner tracks the aim even at shallow view angles', () => {
  const world = makeFloor();
  const { camera, tool } = makeSquareTool(world, [0.25, 2, 0.25], [0.25, 0, 0.25]);
  tool.onMouseDown(0); // floor plane at cell y=1
  camera.position.set(0.25, 1.75, 0.25);
  camera.lookAt(20, 0.75, 0.25); // nearly horizontal along +x
  tool.update(0.016);
  assert.ok(tool._drag.end[0] > 30, `far corner should reach out (got x=${tool._drag.end[0]})`);
  tool.cancel();
});

test('square tool RMB cancels an in-progress drag without placing', () => {
  const world = makeFloor();
  const { camera, tool } = makeSquareTool(world, [0.25, 2, 0.25], [0.25, 0, 0.25]);
  tool.onMouseDown(0);
  assert.ok(tool._drag);
  camera.position.set(2.25, 2, 0.25);
  camera.lookAt(2.25, 0, 0.25);
  tool.update(0.016);
  tool.onMouseDown(2); // cancel
  assert.equal(tool._drag, null);
  tool.onMouseUp(0); // leftover release must not place anything
  assert.equal(world.count, 5, 'cancelled drag must not place voxels');
});

test('square tool RMB click still removes the voxel under the cursor', () => {
  const world = makeFloor();
  const { tool } = makeSquareTool(world, [0.25, 2, 0.25], [0.25, 0, 0.25]);
  tool.onMouseDown(2);
  tool.onMouseUp(2);
  assert.equal(world.count, 4);
});

test('square tool RMB drag erases a rectangle as one undo step', () => {
  const world = makeFloor();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.25, 2, 0.25);
  camera.lookAt(0.25, 0, 0.25); // straight down onto cell (0,0,0)
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ blockId: 'concrete', size: SIZE.SMALL });
  const history = new History();
  const tool = new SquareTool({ THREE, world, camera, ghost, state, history, input: { isDown: () => false } });

  tool.onMouseDown(2); // erase drag opens on the clicked voxel's own layer
  assert.ok(tool._drag?.erase);
  assert.equal(tool._drag.axis, 1);
  assert.deepEqual(tool._drag.start, [0, 0, 0], 'erase rect sits on the voxel layer, not above it');
  assert.equal(world.count, 5, 'nothing removed until release');

  camera.position.set(2.25, 2, 0.25);
  camera.lookAt(2.25, 0, 0.25); // far corner over cell (4,0,0)
  tool.update(0.016);
  tool.onMouseUp(2);
  assert.equal(world.count, 0, 'the whole rectangle erases on release');
  assert.equal(history.length, 1);
  history.undo();
  assert.equal(world.count, 5, 'undo restores the rectangle');
});

test('square tool LMB cancels an in-progress erase drag without removing', () => {
  const world = makeFloor();
  const { camera, tool } = makeSquareTool(world, [0.25, 2, 0.25], [0.25, 0, 0.25]);
  tool.onMouseDown(2);
  assert.ok(tool._drag?.erase);
  camera.position.set(2.25, 2, 0.25);
  camera.lookAt(2.25, 0, 0.25);
  tool.update(0.016);
  tool.onMouseDown(0); // cancel
  assert.equal(tool._drag, null);
  tool.onMouseUp(2); // leftover release must not erase anything
  assert.equal(world.count, 5, 'cancelled erase drag must not remove voxels');
});

// --- spawn tool ---

function makeSpawnTool() {
  const world = makeFloor();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.25, 2, 0.25);
  camera.lookAt(0.25, 0, 0.25); // straight down onto cell (0,0,0)
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ blockId: 'grass', size: SIZE.SMALL });
  const history = new History();
  const tool = new SpawnTool({ THREE, world, camera, ghost, state, history, input: { isDown: () => false } });
  return { world, camera, tool, history };
}

test('spawn tool places the spawn point at the hovered face and clears with RMB', () => {
  const { world, tool } = makeSpawnTool();
  tool.onMouseDown(0);
  assert.deepEqual(world.spawn, [0, 1, 0]); // above the top face of cell (0,0,0)
  tool.onMouseDown(2);
  assert.equal(world.spawn, null);
});

test('spawn tool moves the spawn when placed again', () => {
  const { world, camera, tool } = makeSpawnTool();
  tool.onMouseDown(0);
  assert.deepEqual(world.spawn, [0, 1, 0]);
  camera.position.set(2.25, 2, 0.25);
  camera.lookAt(2.25, 0, 0.25); // now over cell (4,0,0)
  tool.onMouseDown(0);
  assert.deepEqual(world.spawn, [4, 1, 0]);
});

test('spawn tool edits are undoable (set, move, clear)', () => {
  const { world, camera, tool, history } = makeSpawnTool();
  tool.onMouseDown(0);
  assert.deepEqual(world.spawn, [0, 1, 0]);
  history.undo();
  assert.equal(world.spawn, null, 'undo of the first set clears the spawn');
  history.redo();
  assert.deepEqual(world.spawn, [0, 1, 0]);

  camera.position.set(2.25, 2, 0.25);
  camera.lookAt(2.25, 0, 0.25);
  tool.onMouseDown(0); // move it
  assert.deepEqual(world.spawn, [4, 1, 0]);
  history.undo();
  assert.deepEqual(world.spawn, [0, 1, 0], 'undo of a move restores the old spawn');

  tool.onMouseDown(2); // clear
  assert.equal(world.spawn, null);
  history.undo();
  assert.deepEqual(world.spawn, [0, 1, 0], 'undo of a clear restores the spawn');
});

test('spawn is a point marker, not a voxel', () => {
  const { world, tool } = makeSpawnTool();
  const before = world.count;
  tool.onMouseDown(0);
  assert.equal(world.count, before, 'placing the spawn must not add voxels');
  assert.equal(world.get(0, 1, 0), null);
  assert.deepEqual(world.spawn, [0, 1, 0]);
});

// --- mob tool ---

function makeMobTool() {
  const world = makeFloor();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.25, 2, 0.25);
  camera.lookAt(0.25, 0, 0.25); // straight down onto cell (0,0,0)
  const scene = new THREE.Scene();
  const ghost = new SelectionGhost({ THREE, scene });
  const state = new EditorState({ blockId: 'grass', size: SIZE.SMALL });
  const history = new History();
  const tool = new MobTool({ THREE, world, camera, ghost, state, history, input: { isDown: () => false } });
  return { world, camera, tool, history };
}

test('mob tool places a mob spawn at the hovered face and removes it with RMB', () => {
  const { world, tool } = makeMobTool();
  tool.onMouseDown(0);
  assert.deepEqual(world.mobSpawnAt(0, 1, 0), { type: 'imp', x: 0, y: 1, z: 0 });
  assert.equal(world.get(0, 1, 0), null, 'mob spawns are not voxels');
  tool.onMouseDown(2);
  assert.equal(world.mobSpawnAt(0, 1, 0), null);
});

test('mob tool edits are undoable (place and remove)', () => {
  const { world, tool, history } = makeMobTool();
  tool.onMouseDown(0);
  assert.ok(world.mobSpawnAt(0, 1, 0));
  history.undo();
  assert.equal(world.mobSpawnAt(0, 1, 0), null, 'undo removes the placed spawn');
  history.redo();
  assert.ok(world.mobSpawnAt(0, 1, 0));

  tool.onMouseDown(2); // remove it
  assert.equal(world.mobSpawnAt(0, 1, 0), null);
  history.undo();
  assert.deepEqual(world.mobSpawnAt(0, 1, 0), { type: 'imp', x: 0, y: 1, z: 0 }, 'undo restores the removed spawn');
});

test('mob tool rejects placing on top of an existing spawn or inside a block', () => {
  const { world, tool } = makeMobTool();
  tool.onMouseDown(0);
  assert.equal(world.mobSpawns.size, 1);
  tool.onMouseDown(0); // same spot again
  assert.equal(world.mobSpawns.size, 1, 'duplicate spawn rejected');
});

test('mob tool cycles the selected mob type', () => {
  const { tool } = makeMobTool();
  const first = tool.typeId;
  tool.cycleType();
  assert.notEqual(tool.typeId, first);
  tool.cycleType();
  assert.equal(tool.typeId, first, 'cycling returns to the first type');
});

test('mob tool defaults to the first registered mob type', () => {
  const { tool } = makeMobTool();
  assert.equal(tool.typeId, 'imp');
});

// --- tool ring ---

function fakeEl() {
  const state = { classes: new Set(), text: '', children: [], listeners: {} };
  return {
    style: {},
    className: '',
    textContent: '',
    children: state.children,
    get textContent() { return state.text; },
    set textContent(v) { state.text = String(v); },
    classList: {
      add: (c) => state.classes.add(c),
      remove: (c) => state.classes.delete(c),
      toggle: (c, force) => { if (force) state.classes.add(c); else state.classes.delete(c); },
      contains: (c) => state.classes.has(c),
    },
    appendChild(child) { state.children.push(child); },
    addEventListener(type, fn) { state.listeners[type] = fn; },
    querySelector(sel) { return state.children.find((c) => c.tag === sel) ?? null; },
    remove() {},
  };
}

function makeToolbar(slots = 3) {
  const container = fakeEl();
  const items = Array.from({ length: slots }, (_, i) => ({ id: `b${i}`, name: `B${i}`, canvas: fakeEl() }));
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: () => fakeEl() };
  try {
    const bar = new Toolbar({ container, items });
    return { bar, container, items };
  } finally {
    globalThis.document = prevDoc;
  }
}

test('toolbar selecting the active slot deselects it (nothing in hand)', () => {
  const { bar } = makeToolbar(3);
  const calls = [];
  bar.onSelect = (slot) => calls.push(slot?.id ?? null);

  bar.select(1); // select b1
  assert.deepEqual(calls, ['b1']);

  bar.toggle(1); // re-click the active slot -> deselect
  assert.equal(bar.selected, -1);
  assert.deepEqual(calls, ['b1', null]);
});

test('toolbar toggle on an inactive slot just selects it', () => {
  const { bar } = makeToolbar(3);
  const calls = [];
  bar.onSelect = (slot) => calls.push(slot?.id ?? null);

  bar.select(1);
  bar.toggle(2); // different slot -> select, not deselect
  assert.equal(bar.selected, 2);
  assert.deepEqual(calls, ['b1', 'b2']);
});

test('toolbar toggle on an empty slot does not deselect', () => {
  const { bar } = makeToolbar(1); // 1 item, so slot 1 is empty
  const calls = [];
  bar.onSelect = (slot) => calls.push(slot?.id ?? null);

  bar.select(0);
  bar.toggle(1); // empty slot -> select reports null but must not clear highlight
  assert.equal(bar.selected, 1);
  assert.deepEqual(calls, ['b0', null]);
  assert.equal(bar.selected, 1, 'empty slot stays highlighted as selected');
});

// --- tool ring ---

function makeToolRing() {
  const center = fakeEl();
  const container = fakeEl();
  const doc = { querySelector: () => center, createElement: () => fakeEl() };
  const ring = new ToolRing({ doc, container });
  ring.setTools([{ id: 'build', name: 'Build' }, { id: 'square', name: 'Square' }, { id: 'spawn', name: 'Spawn' }]);
  return { ring, center, container };
}

test('tool ring highlights tools from mouse deltas and closes', () => {
  const { ring } = makeToolRing();
  ring.show(0);
  assert.equal(ring.open, true);
  assert.equal(ring.selectedIndex, 0);
  assert.equal(ring.selectedTool.id, 'build');

  ring.move(300, 300); // down-right -> Square
  assert.equal(ring.selectedIndex, 1);
  assert.equal(ring.selectedTool.id, 'square');

  ring.close();
  ring.show(0);
  ring.move(0, 300); // straight down -> Spawn
  assert.equal(ring.selectedIndex, 2);

  assert.equal(ring.wasMoved, true);
  ring.close();
  assert.equal(ring.open, false);
});

test('tool ring tap (tiny movement) reports wasMoved false and keeps the tool', () => {
  const { ring } = makeToolRing();
  ring.show(1);
  ring.move(3, 3);
  assert.equal(ring.wasMoved, false);
  assert.equal(ring.selectedIndex, 1);
});

test('tool ring does not reset the highlight when re-shown while open (key repeat)', () => {
  const { ring } = makeToolRing();
  ring.show(0);
  ring.move(300, 300); // gesture towards Square
  assert.equal(ring.selectedIndex, 1);
  ring.show(0); // repeated keydown while held must not reset the gesture
  assert.equal(ring.selectedIndex, 1);
  assert.equal(ring.wasMoved, true);
});

test('tool ring renders one item per tool and highlights the selected one', () => {
  const { ring, center, container } = makeToolRing();
  ring.show(2);
  assert.equal(container.children.length, 3);
  assert.equal(center.textContent, 'Spawn');
  assert.ok(container.children[2].classList.contains('highlight'));
  assert.ok(!container.children[0].classList.contains('highlight'));
});

// --- keybindings ---

test('keybindings resolve events to semantic actions', () => {
  const ev = ({ code, ctrl = false, meta = false, shift = false, alt = false }) => ({ code, ctrlKey: ctrl, metaKey: meta, shiftKey: shift, altKey: alt });
  assert.equal(resolveBinding(ev({ code: 'Digit3' })).action, 'select.2');
  assert.equal(resolveBinding(ev({ code: 'KeyB' })).action, 'size.toggle');
  assert.equal(resolveBinding(ev({ code: 'KeyZ', ctrl: true })).action, 'undo');
  assert.equal(resolveBinding(ev({ code: 'KeyZ', ctrl: true, shift: true })).action, 'redo');
  assert.equal(resolveBinding(ev({ code: 'KeyS', ctrl: true })).action, 'save');
  assert.equal(resolveBinding(ev({ code: 'KeyS', meta: true })).action, 'save');
  assert.equal(resolveBinding(ev({ code: 'KeyZ' })), null);
});

test('keybindings follow the keycap label on non-QWERTY layouts', () => {
  const ev = ({ code, key = '', ctrl = false, shift = false }) => ({ code, key, ctrlKey: ctrl, metaKey: false, shiftKey: shift, altKey: false });
  // German QWERTZ: the key labelled Z sits at the QWERTY Y position.
  assert.equal(resolveBinding(ev({ code: 'KeyY', key: 'z', ctrl: true })).action, 'undo');
  assert.equal(resolveBinding(ev({ code: 'KeyY', key: 'Z', ctrl: true, shift: true })).action, 'redo');
  assert.equal(resolveBinding(ev({ code: 'KeyY', key: 'z' })), null, 'plain z is not undo');
});

// --- notice ---

test('notice delivers messages to subscribers', () => {
  const seen = [];
  const off = onNotice((n) => seen.push(n.message));
  Notice.info('hello');
  Notice.error('boom');
  off();
  Notice.warn('dropped');
  assert.deepEqual(seen, ['hello', 'boom']);
});

// --- chunk mesh (three.js geometry) ---

test('ChunkMesh builds geometry from the builder output', () => {
  const world = new World();
  world.place('grass', SIZE.SMALL, 0, 0, 0);
  const mesh = new ChunkMesh({ THREE, world, origin: [0, 0, 0], size: 16, tileIndexFor: () => 0, atlas: { width: 4, height: 2 }, material: new THREE.MeshBasicMaterial() });
  const hasVerts = mesh.update();
  assert.equal(hasVerts, true);
  assert.ok(mesh.geometry.attributes.position.count > 0);
  assert.ok(mesh.geometry.attributes.color.count > 0);
});

test('ChunkMesh can be emptied after removal', () => {
  const world = new World();
  world.place('grass', SIZE.SMALL, 0, 0, 0);
  const mesh = new ChunkMesh({ THREE, world, origin: [0, 0, 0], size: 16, tileIndexFor: () => 0, atlas: { width: 4, height: 2 }, material: new THREE.MeshBasicMaterial() });
  mesh.update();
  world.remove(0, 0, 0);
  const hasVerts = mesh.update();
  assert.equal(hasVerts, false);
  assert.equal(mesh.geometry.attributes.position.count, 0);
});

test('every block face maps its UVs to the correct atlas tile', () => {
  // Guards against atlas orientation bugs (flipY vs row math): the top face
  // of each block must land inside its own tile's UV region.
  const atlasOrder = ['grass_top', 'dirt', 'grass_side', 'sand', 'concrete', 'wood_top', 'wood_side'];
  const tileIndex = new Map(atlasOrder.map((n, i) => [n, i]));
  const tileIndexFor = (typeId, face) => tileIndex.get(tileFor(typeId, face));

  const world = new World();
  const types = ['grass', 'sand', 'concrete', 'wood'];
  types.forEach((t, i) => world.place(t, SIZE.SMALL, i * 2, 0, 0));

  const mesh = new ChunkMesh({
    THREE, world, origin: [0, 0, 0], size: 16, tileIndexFor,
    atlas: { width: 4, height: 2 }, material: new THREE.MeshBasicMaterial(),
  });
  mesh.update();

  // atlas is 4 wide, 2 tall, uploaded with flipY (v=0 is the canvas bottom):
  //   row 0 (tiles 0-3) -> v in [0.5, 1]
  //   row 1 (tiles 4-7) -> v in [0, 0.5]
  const region = {
    grass: { u: [0, 0.25], v: [0.5, 1] },       // grass_top
    sand: { u: [0.75, 1], v: [0.5, 1] },        // sand
    concrete: { u: [0, 0.25], v: [0, 0.5] },    // concrete
    wood: { u: [0.25, 0.5], v: [0, 0.5] },      // wood_top (py/ny face)
  };

  const pos = mesh.geometry.attributes.position.array;
  const norm = mesh.geometry.attributes.normal.array;
  const uv = mesh.geometry.attributes.uv.array;

  for (let v = 0; v < pos.length / 3; v++) {
    if (norm[v * 3 + 1] > 0.9) { // top face
      const x = pos[v * 3];
      for (const t of types) {
        const blockX = types.indexOf(t); // small block at world x = index
        if (x >= blockX - 0.001 && x < blockX + 0.5 && !region[t].verified) {
          const [u, vv] = [uv[v * 2], uv[v * 2 + 1]];
          assert.ok(u >= region[t].u[0] && u <= region[t].u[1], `${t} top face u out of range`);
          assert.ok(vv >= region[t].v[0] && vv <= region[t].v[1], `${t} top face v out of range`);
          region[t].verified = true;
        }
      }
    }
  }
  for (const t of types) assert.equal(region[t].verified, true, `${t} top face not found`);
});

// --- renderer ---

function makeRenderer(world) {
  const calls = { render: 0, setSize: 0 };
  const webgl = {
    setSize: () => { calls.setSize++; },
    render: () => { calls.render++; },
  };
  const renderer = new Renderer({
    THREE,
    webgl,
    world,
    atlasTexture: new THREE.Texture(),
    tileIndexFor: () => 0,
    atlas: { width: 4, height: 2 },
  });
  return { renderer, calls };
}

test('renderer creates chunk meshes from dirty flags and renders', () => {
  const world = new World();
  world.place('grass', SIZE.SMALL, 0, 0, 0);
  const { renderer, calls } = makeRenderer(world);
  renderer.render();
  assert.ok(renderer.chunks.size >= 1);
  assert.equal(calls.render, 1);
  assert.equal(calls.setSize, 0);
});

test('renderer resize forwards to webgl and updates aspect', () => {
  const world = new World();
  const { renderer, calls } = makeRenderer(world);
  renderer.resize(1600, 900);
  assert.equal(calls.setSize, 1);
  assert.ok(Math.abs(renderer.camera.aspect - 1600 / 900) < 1e-9);
});

test('loadWorldBounds loads chunks for the world bounds', () => {
  const world = new World();
  world.place('grass', SIZE.SMALL, 0, 0, 0);
  world.place('grass', SIZE.SMALL, 16, 0, 0);
  const { renderer } = makeRenderer(world);
  const n = renderer.loadWorldBounds();
  assert.equal(n, 2);
  assert.equal(renderer.chunks.size, 2);
});

test('clearChunks empties the chunk cache', () => {
  const world = new World();
  world.place('grass', SIZE.SMALL, 0, 0, 0);
  const { renderer } = makeRenderer(world);
  renderer.loadWorldBounds();
  assert.ok(renderer.chunks.size > 0);
  renderer.clearChunks();
  assert.equal(renderer.chunks.size, 0);
});

test('chunk streaming unloads far chunks and streams them back on approach', () => {
  const world = new World();
  world.place('grass', SIZE.SMALL, 0, 0, 0);
  world.place('grass', SIZE.SMALL, 16 * 60, 0, 0); // 60 chunks away in +x
  const { renderer } = makeRenderer(world);
  const near = world.chunkKey(0, 0, 0);
  const far = world.chunkKey(16 * 60, 0, 0);
  renderer.loadWorldBounds();
  assert.equal(renderer.chunks.size, 2, 'small worlds load fully at first');

  // Sync near the origin: the far chunk is beyond the unload radius.
  renderer.camera.position.set(4, 4, 4);
  renderer.syncChunks();
  assert.ok(renderer.chunks.has(near), 'near chunk stays');
  assert.equal(renderer.chunks.has(far), false, 'far chunk is unloaded');

  // Fly out to the far chunk: it streams back in (nearest-first, budgeted).
  renderer.camera.position.set(16 * 60 * 0.5 + 2, 2, 2);
  for (let i = 0; i < 3 && !renderer.chunks.has(far); i++) renderer.syncChunks();
  assert.ok(renderer.chunks.has(far), 'far chunk streams back on approach');
});

test('streaming is disabled when viewDistance is 0', () => {
  const world = new World();
  world.place('grass', SIZE.SMALL, 0, 0, 0);
  world.place('grass', SIZE.SMALL, 16 * 60, 0, 0);
  const calls = { render: 0, setSize: 0 };
  const webgl = { setSize: () => { calls.setSize++; }, render: () => { calls.render++; } };
  const renderer = new Renderer({
    THREE, webgl, world,
    atlasTexture: new THREE.Texture(), tileIndexFor: () => 0, atlas: { width: 4, height: 2 },
    config: { render: { viewDistance: 0 } },
  });
  renderer.loadWorldBounds();
  renderer.camera.position.set(4, 4, 4);
  renderer.syncChunks();
  assert.equal(renderer.chunks.size, 2, 'no unloading when streaming is off');
});

test('renderer without a real WebGL context skips postfx and renders direct', () => {
  const world = new World();
  world.place('grass', SIZE.SMALL, 0, 0, 0);
  const { renderer, calls } = makeRenderer(world);
  renderer.resize(64, 64);
  renderer.render();
  assert.equal(calls.render, 1, 'stub renderer drew the frame directly');
  assert.equal(renderer.postfx, null, 'no postfx built for a stub renderer');
});

test('postfx pipeline renders through its render-target chain', () => {
  const targets = [];
  const webgl = {
    capabilities: { isWebGL2: true },
    setRenderTarget: (t) => { targets.push(t); },
    render: () => {},
  };
  const fx = new PostFX({ THREE });
  fx.setSize(64, 64, webgl);
  fx.render(webgl, new THREE.Scene(), new THREE.PerspectiveCamera(), 0.5);
  // scene + bright + 4 blurs + final composite to the canvas (null target)
  assert.equal(targets.length, 7);
  assert.equal(targets[targets.length - 1], null, 'composite targets the canvas');
  assert.equal(fx._rtScene.width, 64);
  assert.equal(fx._rtA.width, 16, 'bloom runs at quarter resolution');
  fx.dispose();
});

// --- textures ---

test('atlas renders the expected dimensions and tile map', () => {
  const names = ['grass_top', 'sand'];
  const { width, height, data, map, atlas } = renderAtlasRGBA(names);
  assert.equal(width, TILE_SIZE * ATLAS_WIDTH);
  assert.equal(height, TILE_SIZE * ATLAS_HEIGHT);
  assert.equal(map.size, 2);
  assert.deepEqual(atlas, { width: ATLAS_WIDTH, height: ATLAS_HEIGHT });
  assert.ok(data.length > 0);
});

test('multi-slot decal tiles pack below the small tiles, aligned to slots', () => {
  const { map } = renderAtlasRGBA(['grass_top', 'decal_stop', 'decal_graffiti', 'decal_arrow']);
  assert.equal(map.get('grass_top'), 0);
  // bigs pack on shelves below the single small row, tallest first
  const stop = map.get('decal_stop');
  assert.equal(Math.floor(stop / 8), 1, 'first shelf starts under the smalls');
  for (const name of ['decal_stop', 'decal_graffiti', 'decal_arrow']) {
    assert.ok(map.has(name), `${name} placed`);
  }
});

test('block definitions reference only known tiles', () => {
  const known = new Set(listTileNames());
  for (const name of tilesForBlocks()) assert.ok(known.has(name), `unknown tile ${name}`);
});

test('tile pixels are deterministic for a given seed', () => {
  const a = generateTilePixels('grass_top', 7);
  const b = generateTilePixels('grass_top', 7);
  assert.deepEqual([...a], [...b]);
});

// --- fly controls integration ---

test('fly controls move camera toward pressed keys (W forward)', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.rotation.order = 'YXZ';
  const controls = new FlyControls({ THREE, camera, domElement: {}, opts: { speed: 10 } });
  controls.yaw = 0;
  controls.pitch = 0;
  controls.onKeyDown('KeyW');
  controls.update(0.5);
  controls.onKeyUp('KeyW');
  // -z is forward when yaw=0; velocity builds toward it
  assert.ok(camera.position.z < 0);
  assert.equal(camera.position.x, 0);
});

test('fly controls keep camera on the horizontal plane when flying', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.rotation.order = 'YXZ';
  const controls = new FlyControls({ THREE, camera, domElement: {}, opts: { speed: 10 } });
  controls.yaw = 0;
  controls.pitch = 0;
  controls.onKeyDown('KeyW');
  controls.onKeyDown('KeyA');
  controls.update(0.5);
  assert.equal(camera.position.y, 0);
});
