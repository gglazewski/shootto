// e2e.test.js — real browser smoke test against the built bundle.
//
// Serves the editor with server.mjs (the editor is file driven: the world
// lives in map/voxelbundle.json behind /api/world), loads index.html over
// http in headless Chromium, verifies the page boots without console errors,
// the WebGL canvas renders, and the editor's world/rendering pipeline
// responds to programmatic edits.
//
// Requires playwright-core + a cached Chromium (see package.json devDeps).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function findChromium() {
  const cache = join(homedir(), '.cache', 'ms-playwright');
  const dirs = readdirSync(cache).filter((d) => d.startsWith('chromium-'));
  for (const d of dirs) {
    const exe = join(cache, d, 'chrome-linux', 'chrome');
    if (existsSync(exe)) return exe;
  }
  throw new Error('No cached chromium found');
}

// The e2e suite needs playwright-core + a cached Chromium. When either is
// missing, tests are skipped so `npm test` works in any environment.
let chromiumExe;
try {
  const { chromium } = await import('playwright-core');
  globalThis.__pwChromium = chromium;
  chromiumExe = findChromium();
} catch {
  chromiumExe = null;
}
const available = !!chromiumExe;
const skip = available ? false : 'playwright-core or cached Chromium not available';

let browser;
let page;
let srv; // running server.mjs instance
const consoleErrors = [];

/** Read the world file the editor persists to (via the server API). */
async function readWorldFile() {
  const res = await fetch(`http://localhost:${srv.port}/api/world`);
  return JSON.parse(await res.text());
}

before(async () => {
  if (!available) return;
  browser = await globalThis.__pwChromium.launch({
    executablePath: chromiumExe,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  // These tests assume an empty world: the repo's map/voxelbundle.json holds
  // the real migrated world, so point the server at a temp world file seeded
  // with an empty map BEFORE the page loads. The editor restores the empty
  // world (count 0) and falls back to seeding ground, matching the original
  // "fresh editor" behaviour. npcs/quests are omitted so the built-in granny
  // and her questline stay registered (an absent field keeps the built-ins).
  const tmp = join(tmpdir(), `voxelgame-e2e-${Date.now().toString(36)}`);
  mkdirSync(join(tmp, 'worlds'), { recursive: true });
  const worldFile = join(tmp, 'voxelbundle.json');
  writeFileSync(worldFile, JSON.stringify({
    format: 'voxelbundle', version: 1,
    map: { format: 'voxelmap', version: 1, cellSize: 0.5, spawn: null, spawnYaw: 0, blocks: [], items: [], mobs: [], decals: [] },
    items: [], equip: [],
  }));
  srv = await startServer({
    port: 0, worldFile, root: ROOT,
    worldsDir: join(tmp, 'worlds'),
    splashFile: join(tmp, 'splash.json'),
    editorStateFile: join(tmp, 'editor.json'),
  });

  await page.goto(`http://localhost:${srv.port}/index.html`);
  await page.waitForFunction(() => !!window.__voxelgame, { timeout: 15000 });
  await page.waitForTimeout(800);
});

after(async () => {
  if (browser) await browser.close();
  if (srv) srv.server.close();
});

const T = (name, fn) => test(name, { skip }, fn);

T('page boots without console errors', () => {
  assert.deepEqual(consoleErrors, []);
});

T('webgl canvas exists and rendering reacts to camera movement', async () => {
  const hasCanvas = await page.evaluate(() => !!document.querySelector('#game canvas'));
  assert.equal(hasCanvas, true);

  const shot1 = await page.screenshot();
  await page.evaluate(() => {
    const c = window.__voxelgame.renderer.camera;
    c.position.set(c.position.x, c.position.y + 5, c.position.z + 5);
  });
  await page.waitForTimeout(400);
  const shot2 = await page.screenshot();
  assert.ok(!shot1.equals(shot2), 'rendered frame did not change after camera move');
});

T('seeded world exists with chunk meshes', async () => {
  const info = await page.evaluate(() => ({
    count: window.__voxelgame.world.count,
    chunks: window.__voxelgame.renderer.chunks.size,
    tri: window.__voxelgame.renderer.chunks.values().next().value?.geometry.index.count ?? 0,
  }));
  assert.ok(info.count > 0, 'world empty');
  assert.ok(info.chunks > 0, 'no chunk meshes');
  assert.ok(info.tri > 0, 'chunk has no triangles');
});

T('editor can place and remove blocks through the pipeline', async () => {
  const result = await page.evaluate(() => {
    const { world, tool } = window.__voxelgame;
    const before = world.count;
    tool.setType('concrete');
    const r = tool.place(); // no aim target from a locked pointer
    return { before, ok: r.ok, after: world.count };
  });
  // No pointer lock in headless, so pick() finds nothing; world must be unchanged.
  assert.equal(result.ok, false);
  assert.equal(result.after, result.before);
});

T('direct world edit triggers chunk rebuild and canvas updates', async () => {
  const triBefore = await page.evaluate(() =>
    window.__voxelgame.renderer.chunks.values().next().value.geometry.index.count);
  await page.evaluate(() => {
    const { world } = window.__voxelgame;
    world.place('concrete', 'small', 0, 8, 0);
  });
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => {
    const { world, renderer } = window.__voxelgame;
    let total = 0;
    for (const c of renderer.chunks.values()) total += c.geometry.index.count;
    return { count: world.count, total };
  });
  assert.equal(info.count > 0, true);
  assert.ok(info.total > triBefore, 'chunk geometry did not grow after placement');
});

T('face paint repaints a rendered face without adding geometry', async () => {
  const info = await page.evaluate(async () => {
    const { world, renderer } = window.__voxelgame;
    const snapshot = () => {
      // packed geometry: the sampled tile lives in tileInfo (uvLocal is the
      // tile-local mapping) — together they define what the face samples
      let uvs = '';
      let tris = 0;
      for (const c of renderer.chunks.values()) {
        uvs += [...c.geometry.attributes.uvLocal.array].join(',')
          + '|' + [...c.geometry.attributes.tileInfo.array].join(',');
        tris += c.geometry.index.count;
      }
      return { uvs, tris };
    };
    world.place('concrete', 'small', 30, 20, 30);
    await new Promise((r) => setTimeout(r, 300));
    const before = snapshot();

    world.paintFace(30, 20, 30, 'py', 'brick');
    await new Promise((r) => setTimeout(r, 300));
    const after = snapshot();

    world.unpaintFace(30, 20, 30, 'py');
    await new Promise((r) => setTimeout(r, 300));
    const stripped = snapshot();

    world.remove(30, 20, 30);
    await new Promise((r) => setTimeout(r, 300));
    return { before, after, stripped };
  });
  assert.notEqual(info.after.uvs, info.before.uvs, 'painting must change what the face samples');
  assert.equal(info.after.tris, info.before.tris, 'painting must not add a single triangle');
  assert.equal(info.stripped.uvs, info.before.uvs, 'stripping restores the original texture');
});

T('painted faces reach the saved world file and leave when stripped', async () => {
  await page.evaluate(async () => {
    const { world, app } = window.__voxelgame;
    world.place('concrete', 'small', 32, 20, 32);
    world.paintFace(32, 20, 32, 'nz', 'brick');
    await app.save();
  });
  const saved = await readWorldFile();
  const entry = saved.map.paint?.find((p) => p.x === 32 && p.y === 20 && p.z === 32);
  assert.ok(entry, 'the paint must reach the world file');
  assert.equal(entry.face, 'nz');
  assert.equal(entry.type, 'brick');

  // Removing the block takes its paint with it, and an unpainted world writes
  // no `paint` field at all.
  await page.evaluate(async () => {
    const { world, app } = window.__voxelgame;
    world.remove(32, 20, 32);
    await app.save();
  });
  const cleaned = await readWorldFile();
  assert.equal('paint' in cleaned.map, false, 'an unpainted map stays free of the field');
});

T('lighting pipeline: sealed room is dark, roof hole lets light in', async () => {
  // Snapshot the shared world so later tests keep their assumptions.
  const prior = await page.evaluate(() => {
    const { world } = window.__voxelgame;
    const blocks = [];
    world.forEachVoxel((v) => blocks.push({ type: v.type, size: v.size, x: v.anchor[0], y: v.anchor[1], z: v.anchor[2] }));
    return { blocks, spawn: world.spawn ? [...world.spawn] : null };
  });

  // Build a sealed concrete room; interior must be pitch dark.
  await page.evaluate(() => {
    const { world, renderer } = window.__voxelgame;
    world.clear();
    renderer.clearChunks();
    const S = 'small';
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        for (let y = 0; y <= 6; y++) {
          const wall = Math.abs(x) === 3 || Math.abs(z) === 3 || y === 0 || y === 6;
          if (wall) world.place('concrete', S, x, y, z);
        }
      }
    }
  });
  await page.waitForTimeout(400);
  const sealed = await page.evaluate(() => {
    const { renderer } = window.__voxelgame;
    let minSky = 1;
    for (const c of renderer.chunks.values()) {
      // packed geometry: shade = [ao, sky, block, emissive] bytes per vertex
      const shade = c.geometry.attributes.shade?.array;
      if (!shade) continue;
      for (let i = 0; i < shade.length; i += 4) minSky = Math.min(minSky, shade[i + 1] / 255);
    }
    return { interior: renderer.light.get(0, 3, 0).sky, minSky };
  });
  assert.equal(sealed.interior, 0, 'sealed room interior must have no skylight');
  assert.ok(sealed.minSky < 0.1, 'some rendered faces must be dark');

  // Punch a hole in the roof: light must pour straight down into the room.
  await page.evaluate(() => window.__voxelgame.world.remove(0, 6, 0));
  await page.waitForTimeout(400);
  const open = await page.evaluate(() => {
    const { renderer } = window.__voxelgame;
    let maxSky = 0;
    for (const c of renderer.chunks.values()) {
      const shade = c.geometry.attributes.shade?.array;
      if (!shade) continue;
      for (let i = 0; i < shade.length; i += 4) maxSky = Math.max(maxSky, shade[i + 1] / 255);
    }
    return {
      shaft: renderer.light.get(0, 5, 0).sky,
      below: renderer.light.get(0, 3, 0).sky,
      maxSky,
    };
  });
  assert.equal(open.shaft, 15, 'open shaft must be fully sky-lit');
  assert.ok(open.below > 0, 'light must reach the room interior');

  // Restore the shared world for the tests that follow.
  await page.evaluate((p) => {
    const { world, renderer } = window.__voxelgame;
    world.clear();
    renderer.clearChunks();
    for (const b of p.blocks) world.place(b.type, b.size, b.x, b.y, b.z);
    if (p.spawn) world.setSpawn(p.spawn[0], p.spawn[1], p.spawn[2]);
  }, prior);
  await page.waitForTimeout(300);
});

T('hud reflects selection', async () => {
  await page.evaluate(() => window.__voxelgame.toolbar.selectType('stone'));
  const hud = await page.textContent('#hud-type');
  assert.equal(hud, 'stone');
});

T('hotbar has 10 slots and inventory keeps all block icons', async () => {
  const info = await page.evaluate(() => {
    const slots = [...document.querySelectorAll('.slot')];
    const iconPixels = slots.map((s) => {
      const c = s.querySelector('canvas');
      if (!c) return 0;
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.reduce((a, v) => a + v, 0);
    });
    return {
      slotCount: slots.length,
      filled: slots.filter((s) => s.querySelector('canvas')).length,
      inventoryIcons: document.querySelectorAll('#inventory .inv-item[data-kind="block"] canvas').length,
      decalIcons: document.querySelectorAll('#inventory .inv-item[data-kind="decal"] canvas').length,
      blockCount: window.__voxelgame.toolbar.items.length,
      iconPixels,
    };
  });
  assert.equal(info.slotCount, 10, 'hotbar must have exactly 10 slots');
  assert.equal(info.filled, Math.min(info.blockCount, 10), 'default slots must fill from the block list');
  assert.ok(info.iconPixels.slice(0, info.filled).every((p) => p > 0), 'filled hotbar icons must contain visible pixels');
  assert.equal(info.inventoryIcons, info.blockCount, 'inventory must keep one icon per block');
  assert.ok(info.decalIcons > 0, 'inventory must list the decal section');
});

T('hovering a block in the inventory and pressing a number assigns it to that slot', async () => {
  await page.evaluate(() => window.__voxelgame.app.inventory.show());
  await page.waitForTimeout(100);
  // hover the brick block in the inventory
  const hovered = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#inventory .inv-item')];
    const brick = btns.find((b) => b.dataset.id === 'brick');
    brick.dispatchEvent(new MouseEvent('mouseenter'));
    return window.__voxelgame.inventory.hoveredId;
  });
  assert.equal(hovered, 'brick');

  await page.keyboard.press('Digit1');
  await page.waitForTimeout(100);
  const assigned = await page.evaluate(() => ({
    slot0: window.__voxelgame.toolbar.slots[0]?.id ?? null,
    hotbarIcons: document.querySelectorAll('.slot canvas').length,
  }));
  assert.equal(assigned.slot0, 'brick', 'slot 1 must hold the hovered block');

  // reassign brick to slot 10 (the 0 key) — it must leave slot 1 behind
  await page.keyboard.press('Digit0');
  await page.waitForTimeout(100);
  const reassigned = await page.evaluate(() => ({
    slot0: window.__voxelgame.toolbar.slots[0]?.id ?? null,
    slot9: window.__voxelgame.toolbar.slots[9]?.id ?? null,
    duplicates: window.__voxelgame.toolbar.slots.filter((s) => s?.id === 'brick').length,
  }));
  assert.equal(reassigned.slot0, null, 'reassigning must empty the previous slot');
  assert.equal(reassigned.slot9, 'brick', 'the 0 key must move the block to slot 10');
  assert.equal(reassigned.duplicates, 1, 'a block must never occupy two slots at once');

  // reassign grass (its default slot) to slot 10 via the 0 key
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#inventory .inv-item')];
    const grass = btns.find((b) => b.dataset.id === 'grass');
    grass.dispatchEvent(new MouseEvent('mouseenter'));
  });
  await page.keyboard.press('Digit0');
  await page.waitForTimeout(100);
  const grassSlots = await page.evaluate(() => ({
    slot9: window.__voxelgame.toolbar.slots[9]?.id ?? null,
    duplicates: window.__voxelgame.toolbar.slots.filter((s) => s?.id === 'grass').length,
  }));
  assert.equal(grassSlots.slot9, 'grass', 'the 0 key must assign to slot 10');
  assert.equal(grassSlots.duplicates, 1, 'grass must occupy exactly one slot');

  await page.evaluate(() => window.__voxelgame.app.inventory.hide());
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__voxelgame.inventory.isOpen), false);
});

T('save writes a valid serialized world to the world file', async () => {
  const count = await page.evaluate(async () => {
    const { world, app } = window.__voxelgame;
    await app.save(); // Ctrl+S path — PUTs the bundle to the server
    return world.count;
  });
  const bundle = await readWorldFile();
  assert.equal(bundle.format, 'voxelbundle');
  assert.equal(bundle.map.format, 'voxelmap');
  assert.equal(bundle.map.version, 1);
  assert.equal(bundle.map.blocks.length, count);
});

T('help overlay is hidden by default and toggles with F1', async () => {
  const visible = () => page.evaluate(() => window.__voxelgame.ui.helpVisible);

  assert.equal(await visible(), false, 'help must not be shown on startup');

  await page.keyboard.press('F1');
  await page.waitForTimeout(100);
  assert.equal(await visible(), true, 'F1 must show the help overlay');

  await page.keyboard.press('F1');
  await page.waitForTimeout(100);
  assert.equal(await visible(), false, 'F1 again must hide the help overlay');

  // clicking the overlay also dismisses it
  await page.keyboard.press('F1');
  await page.waitForTimeout(100);
  assert.equal(await visible(), true);
  await page.mouse.click(640, 400);
  await page.waitForTimeout(100);
  assert.equal(await visible(), false, 'clicking the help overlay must dismiss it');
});

T('pointer lock does not show the help overlay and enables mouse look', async () => {
  const before = await page.evaluate(() => ({
    visible: window.__voxelgame.ui.helpVisible,
    locked: window.__voxelgame.controls.locked,
  }));
  assert.equal(before.visible, false);
  assert.equal(before.locked, false);

  await page.mouse.click(640, 400); // lock pointer
  await page.waitForTimeout(300);

  const lockedState = await page.evaluate(() => ({
    locked: window.__voxelgame.controls.locked,
    visible: window.__voxelgame.ui.helpVisible,
  }));
  assert.equal(lockedState.locked, true);
  assert.equal(lockedState.visible, false, 'locking the pointer must not show the help overlay');

  const yawBefore = await page.evaluate(() => window.__voxelgame.controls.yaw);
  await page.mouse.move(700, 400); // real movement while locked
  await page.mouse.move(720, 420);
  await page.waitForTimeout(250);
  const yawAfter = await page.evaluate(() => window.__voxelgame.controls.yaw);
  assert.ok(Math.abs(yawAfter - yawBefore) > 0.01, 'camera must rotate from mouse movement');
});

T('locked pointer + left click places a block through the event handlers', async () => {
  // click. Headless Chromium teleports the cursor on lock (firing a big
  // mousemove that spins the camera), so we re-aim before dispatching the
  // real mousedown handler that the game binds on the canvas.
  // Start from an unlocked state in case a previous test left the pointer locked.
  const wasLocked = await page.evaluate(() => window.__voxelgame.controls.locked);
  if (wasLocked) await page.evaluate(() => document.exitPointerLock());
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const { tool, renderer } = window.__voxelgame;
    renderer.camera.position.set(8.25, 3, 8.25);
    renderer.camera.lookAt(8.25, 0, 8.25);
    tool.setType('concrete');
    tool.setSize('small');
  });
  const before = await page.evaluate(() => window.__voxelgame.world.count);

  await page.mouse.click(640, 400); // lock pointer
  await page.waitForTimeout(300);

  const placed = await page.evaluate(() => {
    const { tool, renderer, world } = window.__voxelgame;
    renderer.camera.position.set(8.25, 3, 8.25);
    renderer.camera.lookAt(8.25, 0, 8.25);
    const canvas = document.querySelector('#game canvas');
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    return { count: world.count, top: world.get(16, 2, 16)?.type ?? null };
  });
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => window.__voxelgame.world.count);
  assert.equal(placed.count, before + 1);
  assert.equal(placed.top, 'concrete');
  assert.equal(after, before + 1);
});

T('middle click picks the block under the crosshair', async () => {
  // Drive `controls.locked` directly instead of a real pointer lock: real
  // locks fire a headless cursor teleport that spins the camera and pollutes
  // later tests. The camera is restored to mirror controls afterwards so no
  // stale lookAt orientation leaks into the next test.
  const result = await page.evaluate(() => {
    const { renderer, controls, state } = window.__voxelgame;
    controls.locked = true;
    renderer.camera.position.set(10.25, 3, 10.25);
    renderer.camera.lookAt(10.25, 0, 10.25);
    state.set('blockId', 'concrete'); // ensure a change is actually made
    state.set('size', 'small');
    const canvas = document.querySelector('#game canvas');
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 1, bubbles: true }));
    const picked = { blockId: state.get('blockId'), size: state.get('size') };
    renderer.camera.rotation.set(controls.pitch, controls.yaw, 0, 'YXZ');
    renderer.camera.position.set(10.25, 3, 10.25);
    return picked;
  });
  assert.equal(result.blockId, 'grass', 'picking must select the block under the crosshair');
  assert.equal(result.size, 'big', 'picking must match the voxel size');
});

T('middle click on empty sky does not change the selection', async () => {
  const result = await page.evaluate(() => {
    const { renderer, controls, state } = window.__voxelgame;
    controls.locked = true;
    renderer.camera.position.set(10.25, 3, 10.25);
    renderer.camera.lookAt(10.25, 10, 10.25); // straight up into empty sky
    const canvas = document.querySelector('#game canvas');
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 1, bubbles: true }));
    const r = { blockId: state.get('blockId'), size: state.get('size') };
    renderer.camera.rotation.set(controls.pitch, controls.yaw, 0, 'YXZ');
    renderer.camera.position.set(10.25, 3, 10.25);
    return r;
  });
  assert.equal(result.blockId, 'grass', 'picking air must keep the current block');
  assert.equal(result.size, 'big');
});

T('F5 toggles test-run mode and back, restoring the editor camera', async () => {
  const before = await page.evaluate(() => {
    const { renderer, controls } = window.__voxelgame;
    return { x: renderer.camera.position.x, y: renderer.camera.position.y, z: renderer.camera.position.z, yaw: controls.yaw, pitch: controls.pitch };
  });

  await page.keyboard.press('F5');
  await page.waitForTimeout(200);
  const entered = await page.evaluate(() => {
    const app = window.__voxelgame.app;
    return {
      mode: app.mode,
      badge: document.body.classList.contains('test-mode'),
      toolbarHidden: getComputedStyle(document.querySelector('#toolbar')).display === 'none',
      badgeShown: getComputedStyle(document.querySelector('#ui-testmode')).display !== 'none',
      walkPos: [window.__voxelgame.walk.position.x, window.__voxelgame.walk.position.y, window.__voxelgame.walk.position.z],
      spawn: app.world.spawn,
    };
  });
  assert.equal(entered.mode, 'test');
  assert.equal(entered.badge, true, 'body must carry test-mode');
  assert.equal(entered.toolbarHidden, true, 'editor toolbar must hide in test mode');
  assert.equal(entered.badgeShown, true, 'TEST MODE badge must be visible');
  assert.ok(entered.walkPos.every((v) => Number.isFinite(v)), 'walk player must have a finite position');
  assert.ok(entered.spawn === null, 'this world has no spawn point, so it must use the fallback');

  // Poll for the state flips instead of fixed sleeps: under SwiftShader the
  // frame rate can dip low enough that a 120ms wait fits no physics frame.
  await page.keyboard.down('c');
  await page.waitForFunction(() => window.__voxelgame.walk.crouching === true, { timeout: 3000 });
  const crouched = await page.evaluate(() => window.__voxelgame.walk.crouching);
  await page.keyboard.up('c');
  await page.waitForFunction(() => window.__voxelgame.walk.crouching === false, { timeout: 3000 });
  const stood = await page.evaluate(() => window.__voxelgame.walk.crouching);
  assert.equal(crouched, true, 'C must crouch in test mode');
  assert.equal(stood, false, 'releasing C must stand back up when there is headroom');

  await page.keyboard.press('F5');
  await page.waitForTimeout(200);
  const exited = await page.evaluate((b) => {
    const { renderer, controls } = window.__voxelgame;
    return {
      mode: window.__voxelgame.app.mode,
      badge: document.body.classList.contains('test-mode'),
      toolbarShown: getComputedStyle(document.querySelector('#toolbar')).display !== 'none',
      badgeHidden: getComputedStyle(document.querySelector('#ui-testmode')).display === 'none',
      cam: [renderer.camera.position.x, renderer.camera.position.y, renderer.camera.position.z],
      yaw: controls.yaw,
      pitch: controls.pitch,
    };
  }, before);
  assert.equal(exited.mode, 'edit');
  assert.equal(exited.badge, false, 'body must lose test-mode');
  assert.equal(exited.toolbarShown, true, 'editor toolbar must come back');
  assert.equal(exited.badgeHidden, true, 'TEST MODE badge must hide');
  const cam = exited.cam;
  assert.ok(Math.abs(cam[0] - before.x) < 1e-6 && Math.abs(cam[1] - before.y) < 1e-6 && Math.abs(cam[2] - before.z) < 1e-6,
    'editor camera must be restored exactly');
  assert.ok(Math.abs(exited.yaw - before.yaw) < 1e-6, 'fly yaw restored');
  assert.ok(Math.abs(exited.pitch - before.pitch) < 1e-6, 'fly pitch restored');
});

T('E opens and closes a door in the test run, and the map is left untouched', async () => {
  const r = await page.evaluate(async () => {
    const { app } = window.__voxelgame;
    app.world.clear();
    for (let x = 0; x < 12; x += 2)
      for (let z = 0; z < 12; z += 2) app.world.place('grass', 'big', x, 0, z);
    // A door is 2x4x1 cells: x[4,5] m, y[1,3] m, z[4,4.5] m.
    app.world.place('door_wood', 'door', 8, 2, 8);
    app.renderer.clearChunks();
    app.renderer.loadWorldBounds();

    app.enterTestMode();
    const w = app.walk;
    w.position.set(4.5, 1.0, 3.0); // 1 m in front of the leaf, facing +z
    w.yaw = Math.PI;
    w.pitch = 0;
    w.grounded = true;
    w.velocity.set(0, 0, 0);
    w.keys.clear();
    w.update(1 / 60); // sync the camera to the walk pose
    app._updateTestPrompt();

    const promptFor = () => {
      const el = document.querySelector('#ui-prompt');
      return el.classList.contains('hidden') ? null : el.textContent;
    };
    const pressE = () => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true }));

    const closedPrompt = promptFor();
    pressE();
    const opened = app.world.get(8, 2, 8).type;
    const openPrompt = promptFor();
    const passable = app.walk.world.get(8, 2, 8) === null;

    pressE();
    const closedAgain = app.world.get(8, 2, 8).type;

    // Open it once more, then leave: the playtest must not edit the map.
    pressE();
    const openOnExit = app.world.get(8, 2, 8).type;
    app.exitTestMode();

    return {
      closedPrompt,
      opened,
      openPrompt,
      passable,
      closedAgain,
      openOnExit,
      afterExit: app.world.get(8, 2, 8).type,
      promptAfterExit: promptFor(),
      inventoryOpen: app.inventory.isOpen,
    };
  });

  assert.match(r.closedPrompt, /open the door/, 'aiming at a closed door must prompt to open it');
  assert.equal(r.opened, 'door_wood_open', 'E must open the aimed door');
  assert.match(r.openPrompt, /close the door/, 'an open door must prompt to close it');
  assert.equal(r.passable, true, 'an open door must not block the walk collision');
  assert.equal(r.closedAgain, 'door_wood', 'E must close the door again');
  assert.equal(r.openOnExit, 'door_wood_open');
  assert.equal(r.afterExit, 'door_wood', 'leaving the test run must restore every door');
  assert.equal(r.promptAfterExit, null, 'the prompt must clear when the test run ends');
  assert.equal(r.inventoryOpen, false, 'E must not open the editor inventory while test-running');
});

T('clicking a door in the editor opens its settings and applies them', async () => {
  const r = await page.evaluate(() => {
    const { app } = window.__voxelgame;
    app.world.clear();
    for (let x = 0; x < 12; x += 2)
      for (let z = 0; z < 12; z += 2) app.world.place('grass', 'big', x, 0, z);
    app.world.place('door_wood', 'door', 8, 2, 8); // x[4,5] m, y[1,3] m, z[4,4.5] m
    app.renderer.clearChunks();
    app.renderer.loadWorldBounds();

    // Stand 1 m in front of the leaf, aiming straight at it.
    const cam = app.renderer.camera;
    cam.position.set(4.5, 1.5, 3.0);
    cam.lookAt(4.5, 1.5, 4.25);
    cam.updateMatrixWorld(true);

    const modal = document.querySelector('#door-settings');
    const hit = app._clickDoor();
    const wasOpen = modal.classList.contains('open');
    const opts = [...modal.querySelectorAll('.door-opt')];
    const locks = [...modal.querySelectorAll('.door-lock')];

    locks[1].click(); // 🔒 Locked
    const afterLock = !!app.world.get(8, 2, 8).locked;
    // Pick the opening that is neither the current one nor its mirror: the
    // captions name the swing and the hinge, so this is the "north" one.
    const north = opts.find((b) => /north/.test(b.textContent) && /east/.test(b.textContent));
    north.click();
    const v = app.world.get(8, 2, 8);

    // A locked door must not budge in a playtest.
    app.doorModal.hide();
    app.enterTestMode();
    const w = app.walk;
    w.position.set(4.5, 1.0, 3.0);
    w.yaw = Math.PI;
    w.pitch = 0;
    w.grounded = true;
    w.velocity.set(0, 0, 0);
    w.keys.clear();
    w.update(1 / 60);
    app._updateTestPrompt();
    const prompt = document.querySelector('#ui-prompt').textContent;
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true }));
    const afterE = app.world.get(8, 2, 8).type;
    app.exitTestMode();

    return {
      hit,
      wasOpen,
      optionCount: opts.length,
      afterLock,
      hinge: v.hinge ?? 'left',
      rotation: v.rotation ?? 0,
      closedNow: modal.classList.contains('open'),
      prompt,
      afterE,
      gizmos: app.doorMarker.group.children.length,
    };
  });

  assert.equal(r.hit, true, 'LMB on a door must be consumed by the settings window');
  assert.equal(r.wasOpen, true, 'the door settings window must open');
  assert.equal(r.optionCount, 4, 'four ways for the door to open');
  assert.equal(r.afterLock, true, 'the lock button must lock the voxel');
  assert.equal(r.hinge, 'right', 'the picked plan must set the hinge');
  assert.equal(r.rotation, 2, 'the picked plan must flip the swing to -z');
  assert.equal(r.closedNow, false, 'the window closes when dismissed');
  assert.match(r.prompt, /locked/i, 'a locked door must say so instead of prompting');
  assert.equal(r.afterE, 'door_wood', 'E must not open a locked door');
  assert.ok(r.gizmos > 0, 'the door draws a plan gizmo in the editor');
});

T('test-run player auto-steps up 0.5m blocks while walking', async () => {
  const result = await page.evaluate(() => {
    const { app } = window.__voxelgame;
    // build a clean 1m-cube floor plus a 2x2 (1m x 1m) 0.5m step at x[4,5], z[4,5]
    app.world.clear();
    for (let x = 0; x < 12; x += 2)
      for (let z = 0; z < 12; z += 2) app.world.place('grass', 'big', x, 0, z);
    app.world.place('wood', 'small', 8, 2, 8);
    app.world.place('wood', 'small', 9, 2, 8);
    app.world.place('wood', 'small', 8, 2, 10);
    app.world.place('wood', 'small', 9, 2, 10);
    app.renderer.clearChunks();
    app.renderer.loadWorldBounds();
    app.enterTestMode();
    const w = app.walk;
    w.position.set(2.4, 1.0, 4.5); // just in front of the step, facing +x
    w.grounded = true;
    w.velocity.set(0, 0, 0);
    w.yaw = -Math.PI / 2;
    w.pitch = 0;
    w.keys.clear();
    w.keys.add('KeyW');
    // deterministic: step the controller at 60fps for 0.5s
    for (let i = 0; i < 30; i++) w.update(1 / 60);
    return { x: w.position.x, y: w.position.y, grounded: w.grounded };
  });
  assert.ok(result.y > 1.4, `player should have auto-stepped onto the block, got y=${result.y.toFixed(2)}`);
  assert.ok(result.grounded, 'player must be grounded while standing on the step');
});

T('step-up is a gradual climb, not a teleport', async () => {
  const r = await page.evaluate(() => {
    const { app } = window.__voxelgame;
    app.world.clear();
    for (let x = 0; x < 12; x += 2)
      for (let z = 0; z < 12; z += 2) app.world.place('grass', 'big', x, 0, z);
    app.world.place('wood', 'small', 8, 2, 8); // step at x[4,4.5], top y 1.5
    app.renderer.clearChunks();
    app.renderer.loadWorldBounds();
    app.mode = 'test';
    const w = app.walk;
    w.position.set(3.7, 1.0, 4.25); // box front just touching the step
    w.grounded = true;
    w.velocity.set(0, 0, 0);
    w.yaw = -Math.PI / 2;
    w.pitch = 0;
    w.keys.add('KeyW');
    const ys = [];
    for (let i = 0; i < 30; i++) { w.update(1 / 60); ys.push(+w.position.y.toFixed(3)); }
    w.keys.clear();
    let maxJump = 0;
    for (let i = 1; i < ys.length; i++) maxJump = Math.max(maxJump, Math.abs(ys[i] - ys[i - 1]));
    return {
      peak: Math.max(...ys),
      intermediate: ys.filter((y) => y > 1.01 && y < 1.49).length,
      maxJump,
    };
  });
  assert.ok(r.peak > 1.49, `player must end up on the step, got peak ${r.peak}`);
  assert.ok(r.intermediate >= 3, `rise must pass through intermediate heights, got ${r.intermediate}`);
  assert.ok(r.maxJump < 0.4, `no single-frame teleport upward, max jump ${r.maxJump.toFixed(3)}`);
});

T('blocking objects stop the player, traversable ones let them through', async () => {
  const r = await page.evaluate(() => {
    const { app } = window.__voxelgame;
    const ie = app.itemEditor;
    const saveItem = (name, solid) => {
      ie.item.id = null; // force a fresh id so placements reference it
      ie.item.name = name;
      ie.item.size = 'small';
      ie.item.solid = solid;
      ie.item.microVoxels = [{ x: 0, y: 0, z: 0, color: [255, 255, 255] }];
      ie._rebuild();
      ie.save();
    };
    const walkInto = (itemId) => {
      // A big item at (8,2,8) is a 1m cube centred on x[4,5], z[4,5], y[1,2] —
      // too tall to step over, so a blocking one must stop the walk.
      app.world.placeItem(itemId, 'big', 8, 2, 8);
      app.mode = 'test';
      const w = app.walk;
      w.position.set(3.4, 1.0, 4.25);
      w.grounded = true;
      w.velocity.set(0, 0, 0);
      w.yaw = -Math.PI / 2; // facing +x
      w.pitch = 0;
      w.keys.clear();
      w.keys.add('KeyW');
      for (let i = 0; i < 30; i++) w.update(1 / 60);
      const x = w.position.x;
      w.keys.clear();
      app.world.removeItemAt(8, 2, 8);
      app.mode = 'edit';
      return x;
    };

    app.world.clear();
    for (let x = 0; x < 12; x += 2)
      for (let z = 0; z < 12; z += 2) app.world.place('grass', 'big', x, 0, z);
    app.renderer.clearChunks();
    app.renderer.loadWorldBounds();

    saveItem('SolidWall', true);
    const blockedX = walkInto('solidwall');
    saveItem('FluffyRug', false);
    const passX = walkInto('fluffyrug');
    return { blockedX, passX };
  });
  assert.ok(r.blockedX < 4.5, `blocking object must stop the player, x=${r.blockedX.toFixed(2)}`);
  assert.ok(r.passX > 4.9, `traversable object must let the player through, x=${r.passX.toFixed(2)}`);

  // Leave no trace: unregister the objects and reset the editor's working item
  // so later ordering-dependent tests see a clean catalogue.
  await page.evaluate(() => {
    const app = window.__voxelgame.app;
    app._deleteItem('solidwall');
    app._deleteItem('fluffyrug');
    const ie = app.itemEditor;
    ie.item.id = null;
    ie.item.name = 'New Item';
    ie.item.microVoxels = [];
    ie._rebuild();
  });
});

T('test run ignores edit clicks: no blocks are placed or removed', async () => {
  const r = await page.evaluate(() => {
    const app = window.__voxelgame.app;
    app.world.clear();
    for (let x = 0; x < 6; x += 2)
      for (let z = 0; z < 6; z += 2) app.world.place('grass', 'big', x, 0, z);
    app.world.place('concrete', 'small', 4, 2, 4); // a block to try to remove
    app.renderer.clearChunks();
    app.renderer.loadWorldBounds();
    app.enterTestMode();

    const { tool, controls, renderer, world } = window.__voxelgame;
    // Drive the editor lock flag like a real pointer lock; the dispatcher
    // routes mouse events to App, which must now refuse them in test mode.
    controls.locked = true;
    tool.setType('wood');
    tool.setSize('small');
    const canvas = document.querySelector('#game canvas');
    const before = world.count;

    renderer.camera.position.set(2.25, 3, 2.25);
    renderer.camera.lookAt(2.25, 0, 2.25);
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    const afterPlace = world.count;

    renderer.camera.position.set(4.25, 3, 4.25);
    renderer.camera.lookAt(4.25, 0, 4.25);
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('mouseup', { button: 2, bubbles: true }));
    const afterRemove = world.count;
    const concreteStillThere = !!world.get(4, 2, 4);

    // Clean up: leave the floor, but remove the concrete so later tests that
    // place their own object at (4,2,4) find the spot free.
    if (concreteStillThere) world.remove(4, 2, 4);

    app.exitTestMode();
    return { before, afterPlace, afterRemove, concreteStillThere };
  });
  assert.equal(r.before, r.afterPlace, 'LMB in test run must not place a block');
  assert.equal(r.afterPlace, r.afterRemove, 'RMB in test run must not remove a block');
  assert.equal(r.concreteStillThere, true, 'the concrete block must survive a test-run RMB');
});

T('page renders an actual frame to a screenshot', async () => {
  const png = await page.screenshot({ path: '/tmp/voxelgame-e2e.png' });
  assert.ok(png.length > 10000);
});

T('F2 item editor builds, saves and places a placeable object', async () => {
  // The step-up tests leave the app in test mode; return to the editor first.
  await page.evaluate(() => {
    const app = window.__voxelgame.app;
    if (app.mode === 'test') app.exitTestMode();
  });
  await page.waitForTimeout(100);

  // Enter item mode with F2.
  await page.keyboard.press('F2');
  await page.waitForTimeout(150);
  const entered = await page.evaluate(() => ({
    mode: window.__voxelgame.app.mode,
    open: window.__voxelgame.itemEditor.isOpen,
    badge: document.body.classList.contains('item-mode'),
  }));
  assert.equal(entered.mode, 'item');
  assert.equal(entered.open, true, 'item editor must open on F2');
  assert.equal(entered.badge, true, 'body must carry item-mode');

  // Paint interactively with the real mouse: zoom in and LMB the grid centre
  // twice. The second click must target a DIFFERENT cell — the grid walls must
  // not block building into the volume.
  await page.mouse.move(640, 400);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(100);
  const paint = async () => {
    await page.mouse.move(640, 400);
    const target = await page.evaluate(() =>
      window.__voxelgame.itemEditor._ghostCell ? [...window.__voxelgame.itemEditor._ghostCell] : null);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(100);
    return target;
  };
  const firstTarget = await paint();
  const secondTarget = await paint();
  assert.ok(firstTarget, 'placement must have a target on an empty grid');
  assert.ok(secondTarget, 'second placement must still have a target');
  assert.notDeepEqual(secondTarget, firstTarget, 'clicking twice must paint two different cells (build into the volume)');
  const manhattan =
    Math.abs(secondTarget[0] - firstTarget[0]) +
    Math.abs(secondTarget[1] - firstTarget[1]) +
    Math.abs(secondTarget[2] - firstTarget[2]);
  assert.equal(manhattan, 1, 'the ghost must stick to the face of the placed voxel (adjacent cell)');
  const painted = await page.evaluate(() => window.__voxelgame.itemEditor.item.microVoxels.length);
  assert.equal(painted, 2, 'LMB must paint one micro voxel per click');

  // Painted cells must never be outside the grid.
  const allInside = await page.evaluate(() =>
    window.__voxelgame.itemEditor.item.microVoxels.every(
      (v) => v.x >= 0 && v.x < 8 && v.y >= 0 && v.y < 8 && v.z >= 0 && v.z < 8));
  assert.equal(allInside, true, 'painted voxels must stay inside the grid');

  // Erase with RMB until the grid is empty again (extra RMBs are no-ops).
  await page.mouse.move(640, 400);
  for (let i = 0; i < 4; i++) {
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(80);
  }
  const erased = await page.evaluate(() => window.__voxelgame.itemEditor.item.microVoxels.length);
  assert.equal(erased, 0, 'RMB must erase the micro voxels');

  // Build a tiny item (as if painted) with a light source.
  await page.evaluate(() => {
    const ie = window.__voxelgame.itemEditor;
    ie.item.name = 'Lamp';
    ie.item.size = 'small';
    ie.item.microVoxels.push({ x: 0, y: 0, z: 0, color: [255, 200, 50] });
    ie.item.microVoxels.push({ x: 1, y: 0, z: 0, color: [255, 200, 50] });
    ie.lightOn = true;
    ie.lightColor = [255, 220, 150];
    ie.lightStrength = 3;
    ie._rebuild();
  });

  // Save: registers the item and (via the explicit save) persists it in the
  // world file's items registry.
  await page.evaluate(() => window.__voxelgame.itemEditor.save());
  await page.evaluate(() => window.__voxelgame.app.save());
  const itemBundle = await readWorldFile();
  const itemArr = itemBundle.items ?? [];
  const saved = {
    count: itemArr.length,
    id: itemArr[0]?.id,
    name: itemArr[0]?.name,
    hasLight: !!itemArr[0]?.light,
    voxels: itemArr[0]?.microVoxels?.length,
  };
  assert.equal(saved.count, 1, 'item registry must persist one item');
  assert.equal(saved.id, 'lamp');
  assert.equal(saved.name, 'Lamp');
  assert.equal(saved.hasLight, true);
  assert.equal(saved.voxels, 2);

  // Back to the world editor.
  await page.keyboard.press('F2');
  await page.waitForTimeout(150);
  const exited = await page.evaluate(() => ({
    mode: window.__voxelgame.app.mode,
    open: window.__voxelgame.itemEditor.isOpen,
  }));
  assert.equal(exited.mode, 'edit', 'F2 again must exit the item editor');
  assert.equal(exited.open, false);

  // The object appears in the E inventory.
  await page.evaluate(() => window.__voxelgame.app.inventory.show());
  await page.waitForTimeout(100);
  const objItems = await page.evaluate(() =>
    [...document.querySelectorAll('#inventory .obj-grid .inv-item')].map((b) => b.dataset.id));
  assert.deepEqual(objItems, ['lamp'], 'inventory must list the registered object');

  // Selecting it arms the item placement tool.
  await page.evaluate(() => {
    const btn = document.querySelector('#inventory .obj-grid .inv-item');
    btn.click();
  });
  await page.waitForTimeout(100);
  const sel = await page.evaluate(() => ({
    itemId: window.__voxelgame.state.get('itemId'),
    tool: window.__voxelgame.tools.active.id,
  }));
  assert.equal(sel.itemId, 'lamp');
  assert.equal(sel.tool, 'item', 'item tool must activate');

  // Place the item on the ground with the item tool.
  const placed = await page.evaluate(() => {
    const app = window.__voxelgame.app;
    const tool = app.tools.get('item');
    const { renderer, controls } = window.__voxelgame;
    controls.locked = true;
    renderer.camera.position.set(2.25, 3, 2.25);
    renderer.camera.lookAt(2.25, 0, 2.25);
    tool.onMouseDown(0);
    const item = app.world.itemAt(4, 2, 4);
    renderer.camera.rotation.set(controls.pitch, controls.yaw, 0, 'YXZ');
    return { placed: !!item, itemId: item?.itemId };
  });
  assert.equal(placed.placed, true, 'item tool must place the object');
  assert.equal(placed.itemId, 'lamp');

  // The item light seeds the light field around it.
  const light = await page.evaluate(() => window.__voxelgame.renderer.light.blockAt(4, 2, 4));
  assert.ok(light > 0, 'item light must brighten nearby cells');

  // Right click removes the item again.
  const removed = await page.evaluate(() => {
    const app = window.__voxelgame.app;
    const tool = app.tools.get('item');
    const { renderer, controls } = window.__voxelgame;
    controls.locked = true;
    renderer.camera.position.set(2.25, 3, 2.25);
    renderer.camera.lookAt(2.25, 0, 2.25);
    tool.onMouseDown(2);
    const stillThere = !!app.world.itemAt(4, 2, 4);
    renderer.camera.rotation.set(controls.pitch, controls.yaw, 0, 'YXZ');
    return stillThere;
  });
  assert.equal(removed, false, 'item tool RMB must remove the object');

  // Placed items serialize into the map save file.
  await page.evaluate(() => {
    const app = window.__voxelgame.app;
    const tool = app.tools.get('item');
    const { renderer, controls } = window.__voxelgame;
    controls.locked = true;
    renderer.camera.position.set(2.25, 3, 2.25);
    renderer.camera.lookAt(2.25, 0, 2.25);
    tool.onMouseDown(0); // re-place for the serialization check
    renderer.camera.rotation.set(controls.pitch, controls.yaw, 0, 'YXZ');
  });
  await page.waitForTimeout(50);
  const serialized = await page.evaluate(() => {
    const { world } = window.__voxelgame;
    const items = [];
    world.forEachItem((it) => items.push(it.itemId));
    return items;
  });
  assert.deepEqual(serialized, ['lamp']);
});

T('F3 items editor builds, sets grip/direction and saves an equippable item', async () => {
  await page.evaluate(() => {
    const app = window.__voxelgame.app;
    if (app.mode === 'test') app.exitTestMode();
    if (app.mode === 'item') app.exitItemEditor();
  });
  await page.waitForTimeout(100);

  // Enter the items editor with F3.
  await page.keyboard.press('F3');
  await page.waitForTimeout(150);
  const entered = await page.evaluate(() => ({
    mode: window.__voxelgame.app.mode,
    open: window.__voxelgame.equipmentEditor.isOpen,
    badge: document.body.classList.contains('equip-mode'),
  }));
  assert.equal(entered.mode, 'equip');
  assert.equal(entered.open, true, 'items editor must open on F3');
  assert.equal(entered.badge, true, 'body must carry equip-mode');

  // Build a club: paint a couple of voxels with the real mouse.
  await page.mouse.move(640, 400);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(100);
  const paint = async () => {
    await page.mouse.move(640, 400);
    const target = await page.evaluate(() =>
      window.__voxelgame.equipmentEditor._ghostCell ? [...window.__voxelgame.equipmentEditor._ghostCell] : null);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(80);
    return target;
  };
  const firstTarget = await paint();
  const secondTarget = await paint();
  assert.ok(firstTarget, 'placement must have a target on an empty grid');
  assert.notDeepEqual(secondTarget, firstTarget, 'clicking twice must paint two different cells');
  const painted = await page.evaluate(() => window.__voxelgame.equipmentEditor.item.microVoxels.length);
  assert.equal(painted, 2, 'LMB must paint one micro voxel per click');

  // Grip mode: G, then click to set the grip on the hovered cell.
  await page.keyboard.press('KeyG');
  await page.waitForTimeout(80);
  const gripMode = await page.evaluate(() => window.__voxelgame.equipmentEditor.gripMode);
  assert.equal(gripMode, true, 'G must toggle grip mode');
  await page.mouse.move(640, 400);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
  const grip = await page.evaluate(() => window.__voxelgame.equipmentEditor.item.grip);
  assert.ok(grip && grip.x >= 0 && grip.x < 8 && grip.y >= 0 && grip.y < 8 && grip.z >= 0 && grip.z < 8,
    'grip must be set to a cell inside the grid');
  const gripLabel = await page.evaluate(() => document.querySelector('#ep-grip-label').textContent);
  assert.equal(gripLabel, `${grip.x},${grip.y},${grip.z}`, 'panel must show the grip cell');

  // Rotate the direction arrow with R.
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(80);
  const yaw = await page.evaluate(() => window.__voxelgame.equipmentEditor.item.yaw);
  assert.equal(yaw, 90, 'R must rotate the direction by 90°');
  const arrowVisible = await page.evaluate(() => window.__voxelgame.equipmentEditor.dirArrow.visible);
  assert.equal(arrowVisible, true, 'direction arrow must be visible');

  // Make it a ranged weapon and set the muzzle (barrel end) with M + click.
  await page.evaluate(() => window.__voxelgame.equipmentEditor._setKind('ranged'));
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(60);
  await page.mouse.move(640, 400);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
  const muzzle = await page.evaluate(() => {
    const ee = window.__voxelgame.equipmentEditor;
    return {
      kind: ee.item.weapon.kind,
      anim: ee.item.weapon.anim,
      muzzle: ee.item.weapon.muzzle ? { ...ee.item.weapon.muzzle } : null,
      markerVisible: ee.muzzleMarker.visible,
    };
  });
  assert.equal(muzzle.kind, 'ranged', 'kind must switch to ranged');
  assert.equal(muzzle.anim, 'gun', 'ranged weapons default to the gun animation');
  assert.ok(muzzle.muzzle && muzzle.muzzle.x >= 0 && muzzle.muzzle.x < 8, 'muzzle must be set inside the grid');
  assert.equal(muzzle.markerVisible, true, 'the muzzle marker must be visible');

  // Ranged weapons default to the standard aim spread, editable in degrees.
  const spread = await page.evaluate(() => {
    const ee = window.__voxelgame.equipmentEditor;
    const row = document.querySelector('#ep-spread-row');
    return {
      value: document.querySelector('#ep-spread').value,
      visible: getComputedStyle(row).display !== 'none',
      radians: ee.item.weapon.spread,
    };
  });
  assert.equal(spread.visible, true, 'the spread field must show for ranged weapons');
  assert.equal(spread.value, '1.15', 'a new ranged weapon defaults to 1.15° spread');
  assert.ok(Math.abs(spread.radians - 0.02) < 1e-6, '1.15° must equal the 0.02 rad default');

  // Editing the field writes radians back into the weapon profile.
  const edited = await page.evaluate(() => {
    const ee = window.__voxelgame.equipmentEditor;
    const input = document.querySelector('#ep-spread');
    input.value = '3';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { radians: ee.item.weapon.spread };
  });
  assert.ok(Math.abs(edited.radians - (3 * Math.PI) / 180) < 1e-6, 'spread field must round-trip to radians');

  // A melee weapon hides the field.
  await page.evaluate(() => window.__voxelgame.equipmentEditor._setKind('melee'));
  const meleeHidden = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#ep-spread-row')).display === 'none');
  assert.equal(meleeHidden, true, 'the spread field must hide for melee weapons');

  // Back to ranged for the save below (the tuned 3° spread survives).
  await page.evaluate(() => window.__voxelgame.equipmentEditor._setKind('ranged'));

  // Give it a name + stats, then save. Reach can go up to sniper range (1000 m).
  const reachMax = await page.evaluate(() => document.querySelector('#ep-reach').max);
  assert.equal(reachMax, '1000', 'the reach input must allow up to 1000 m');
  await page.evaluate(() => {
    const ee = window.__voxelgame.equipmentEditor;
    document.querySelector('#ep-name').value = 'Club';
    ee._ui.damage.value = '22';
    ee._ui.reach.value = '1000';
    ee._ui.cooldown.value = '0.4';
    ee.save();
  });
  await page.evaluate(() => window.__voxelgame.app.save());
  const equipBundle = await readWorldFile();
  const equipArr = equipBundle.equip ?? [];
  const saved = { count: equipArr.length, item: equipArr[0] };
  assert.equal(saved.count, 1, 'equipment registry must persist one item');
  assert.equal(saved.item.id, 'club');
  assert.equal(saved.item.name, 'Club');
  assert.equal(saved.item.yaw, 90);
  assert.deepEqual(saved.item.grip, grip, 'grip must round-trip through save');
  assert.deepEqual(saved.item.stats, { damage: 22, reach: 1000, cooldown: 0.4, durability: 40 });
  assert.deepEqual(saved.item.weapon.muzzle, muzzle.muzzle, 'muzzle must round-trip through save');
  assert.equal(saved.item.weapon.kind, 'ranged');
  assert.ok(Math.abs(saved.item.weapon.spread - (3 * Math.PI) / 180) < 1e-6, 'spread must round-trip through save');

  // The catalogue lists it.
  await page.evaluate(() => window.__voxelgame.equipCatalogue.show());
  await page.waitForTimeout(100);
  const catItems = await page.evaluate(() =>
    [...document.querySelectorAll('#equip-catalogue .cat-item')].map((c) => c.querySelector('.cat-name').textContent));
  assert.deepEqual(catItems, ['Club'], 'catalogue must list the saved item');

  // Back to the world editor.
  await page.keyboard.press('F3');
  await page.waitForTimeout(150);
  const exited = await page.evaluate(() => ({
    mode: window.__voxelgame.app.mode,
    open: window.__voxelgame.equipmentEditor.isOpen,
  }));
  assert.equal(exited.mode, 'edit', 'F3 again must exit the items editor');
  assert.equal(exited.open, false);

  // The item appears in the E inventory's "Equippable Items" section —
  // alongside the built-in quest items (granny's teapot), which are placeable
  // quest objectives, not authored equipment (hidden from the catalogue,
  // never persisted, but still placed in maps for fetch quests).
  await page.evaluate(() => window.__voxelgame.inventory.show());
  await page.waitForTimeout(100);
  const equipItems = await page.evaluate(() =>
    [...document.querySelectorAll('#inventory .equip-grid .inv-item')].map((b) => b.dataset.id));
  assert.ok(equipItems.includes('club'), 'E menu must list the saved equippable item');
  assert.ok(equipItems.includes('granny-teapot'), 'E menu must keep built-in quest items placeable');

  // Selecting it arms the item placement tool.
  await page.evaluate(() => {
    document.querySelector('#inventory .equip-grid .inv-item[data-id="club"]').click();
  });
  await page.waitForTimeout(100);
  const sel = await page.evaluate(() => ({
    itemId: window.__voxelgame.state.get('itemId'),
    tool: window.__voxelgame.tools.active.id,
  }));
  assert.equal(sel.itemId, 'club');
  assert.equal(sel.tool, 'item', 'item tool must activate for an equippable item');

  // Place the club on the ground with the item tool.
  const placed = await page.evaluate(() => {
    const app = window.__voxelgame.app;
    const tool = app.tools.get('item');
    const { renderer, controls } = window.__voxelgame;
    controls.locked = true;
    renderer.camera.position.set(2.25, 3, 2.25);
    renderer.camera.lookAt(2.25, 0, 2.25);
    tool.onMouseDown(0);
    const clubs = [];
    app.world.forEachItem((it) => { if (it.itemId === 'club') clubs.push(it); });
    renderer.camera.rotation.set(controls.pitch, controls.yaw, 0, 'YXZ');
    return { count: clubs.length, id: clubs[0]?.itemId, cells: clubs[0]?.cells };
  });
  assert.equal(placed.count, 1, 'item tool must place the equippable item');
  assert.equal(placed.id, 'club');
  assert.deepEqual(placed.cells, [1, 1, 1], 'an 8³ equippable places at the one-cell footprint');

  // Let the frame loop build the item mesh, then check it rendered.
  await page.waitForTimeout(150);
  const rendered = await page.evaluate(() => {
    const app = window.__voxelgame.app;
    const groups = [];
    app.itemRenderer._groups.forEach((entry) => {
      if (entry.placement.itemId === 'club') groups.push({ id: entry.placement.itemId, visible: entry.mesh.visible });
    });
    return groups;
  });
  assert.deepEqual(rendered, [{ id: 'club', visible: true }], 'placed equippable item must render');

  // Removing it with RMB works too.
  const removed = await page.evaluate(() => {
    const app = window.__voxelgame.app;
    const tool = app.tools.get('item');
    const { renderer, controls } = window.__voxelgame;
    controls.locked = true;
    renderer.camera.position.set(2.25, 3, 2.25);
    renderer.camera.lookAt(2.25, 0, 2.25);
    tool.onMouseDown(2);
    let clubs = 0;
    app.world.forEachItem((it) => { if (it.itemId === 'club') clubs++; });
    renderer.camera.rotation.set(controls.pitch, controls.yaw, 0, 'YXZ');
    return clubs;
  });
  assert.equal(removed, 0, 'item tool RMB must remove the equippable item');
});

T('typing in the items editor fields does not trigger editor shortcuts', async () => {
  await page.evaluate(() => {
    const app = window.__voxelgame.app;
    if (app.mode === 'equip') app.exitEquipEditor();
  });
  await page.keyboard.press('F3');
  await page.waitForTimeout(150);

  // Focus the name field and type letters that are editor shortcuts (g/r/e)
  // plus digits — none may fire an action or reset the field.
  const before = await page.evaluate(() => {
    const ee = window.__voxelgame.equipmentEditor;
    return { gripMode: ee.gripMode, muzzleMode: ee.muzzleMode, colorIndex: ee.colorIndex };
  });
  await page.click('#ep-name', { clickCount: 3 });
  await page.keyboard.type('Grif');
  const name = await page.evaluate(() => {
    const ee = window.__voxelgame.equipmentEditor;
    return {
      value: document.querySelector('#ep-name').value,
      gripMode: ee.gripMode,
      muzzleMode: ee.muzzleMode,
      colorIndex: ee.colorIndex,
      animFocused: document.activeElement.id,
    };
  });
  assert.equal(name.value, 'Grif', 'typed name must survive (not reset by shortcuts)');
  assert.deepEqual(
    { gripMode: name.gripMode, muzzleMode: name.muzzleMode, colorIndex: name.colorIndex },
    before,
    'typing must not change editor state',
  );
  assert.equal(name.animFocused, 'ep-name', 'name field must keep focus');

  // Focus the reach field and type 1000; blurring applies it as 1000.
  await page.click('#ep-reach', { clickCount: 3 });
  await page.keyboard.type('1000');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(60);
  const reach = await page.evaluate(() => {
    const ee = window.__voxelgame.equipmentEditor;
    return { value: document.querySelector('#ep-reach').value, saved: ee.item.stats.reach };
  });
  assert.equal(reach.value, '1000', 'typed reach must persist in the field');
  assert.equal(reach.saved, 1000, 'reach must be applied from the input on blur');

  await page.keyboard.press('F3');
  await page.waitForTimeout(100);
});

T('inventory can assign a placeable object to a hotbar slot', async () => {
  // Open the inventory and hover the "lamp" object.
  await page.evaluate(() => window.__voxelgame.inventory.show());
  await page.waitForTimeout(120);
  const hovered = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#inventory .obj-grid .inv-item')];
    const lamp = btns.find((b) => b.dataset.id === 'lamp');
    lamp.dispatchEvent(new MouseEvent('mouseenter'));
    return window.__voxelgame.inventory.hovered;
  });
  assert.deepEqual(hovered, { kind: 'item', id: 'lamp' }, 'hovering an object must track it');

  // Press 2 -> slot 2 (index 1) holds the object.
  await page.keyboard.press('Digit2');
  await page.waitForTimeout(100);
  const assigned = await page.evaluate(() => window.__voxelgame.toolbar.slots[1]);
  assert.equal(assigned.id, 'lamp', 'the object must be assigned to the slot');
  assert.equal(assigned.kind, 'item');

  // Close the inventory, then press 2 -> the object is selected for placing.
  await page.evaluate(() => window.__voxelgame.inventory.hide());
  await page.waitForTimeout(100);
  await page.keyboard.press('Digit2');
  await page.waitForTimeout(100);
  const sel = await page.evaluate(() => ({
    itemId: window.__voxelgame.state.get('itemId'),
    tool: window.__voxelgame.tools.active.id,
  }));
  assert.equal(sel.itemId, 'lamp', 'pressing the slot key must select the object');
  assert.equal(sel.tool, 'item', 'the item placement tool must arm');
});

T('R rotates the selected object 90° and placements keep the yaw', async () => {
  // Build + save an asymmetric object so the rotation is observable.
  await page.evaluate(() => {
    const app = window.__voxelgame.app;
    app.world.clear();
    for (let x = 0; x < 12; x += 2)
      for (let z = 0; z < 12; z += 2) app.world.place('grass', 'big', x, 0, z);
    app.renderer.clearChunks();
    app.renderer.loadWorldBounds();
    const ie = app.itemEditor;
    ie.item.id = null;
    ie.item.name = 'Arrow';
    ie.item.size = 'small';
    ie.item.microVoxels = [
      { x: 0, y: 0, z: 0, color: [255, 200, 50] },
      { x: 3, y: 0, z: 0, color: [255, 200, 50] },
    ];
    ie._rebuild();
    ie.save();
    app.state.set('itemRotation', 0);
    app.state.set('itemId', 'arrow');
  });
  await page.waitForTimeout(120);

  const before = await page.evaluate(() => ({
    rotation: window.__voxelgame.state.get('itemRotation'),
    tool: window.__voxelgame.tools.active.id,
  }));
  assert.equal(before.rotation, 0);
  assert.equal(before.tool, 'item', 'selecting the object must arm the item tool');

  await page.keyboard.press('KeyR');
  await page.waitForTimeout(100);
  const rot1 = await page.evaluate(() => window.__voxelgame.state.get('itemRotation'));
  assert.equal(rot1, 90, 'R must rotate the selected object 90°');

  await page.keyboard.press('KeyR');
  await page.waitForTimeout(100);
  const rot2 = await page.evaluate(() => window.__voxelgame.state.get('itemRotation'));
  assert.equal(rot2, 180, 'a second R must rotate another 90°');

  // Place it: the stored placement must keep the current yaw.
  const placed = await page.evaluate(() => {
    const app = window.__voxelgame.app;
    const tool = app.tools.get('item');
    const { renderer, controls } = window.__voxelgame;
    controls.locked = true;
    renderer.camera.position.set(2.25, 3, 2.25);
    renderer.camera.lookAt(2.25, 0, 2.25);
    tool.onMouseDown(0);
    const item = app.world.itemAt(4, 2, 4);
    renderer.camera.rotation.set(controls.pitch, controls.yaw, 0, 'YXZ');
    return item ? { itemId: item.itemId, rotation: item.rotation } : null;
  });
  assert.ok(placed, 'item must be placeable after rotating');
  assert.equal(placed.itemId, 'arrow');
  assert.ok(Math.abs(placed.rotation - Math.PI) < 1e-6, `placement must keep the 180° yaw, got ${placed.rotation}`);

  // Leave no trace for later ordering-dependent tests.
  await page.evaluate(() => {
    const app = window.__voxelgame.app;
    app._deleteItem('arrow');
    app.state.set('itemRotation', 0);
    const ie = app.itemEditor;
    ie.item.id = null;
    ie.item.name = 'New Item';
    ie.item.microVoxels = [];
    ie._rebuild();
  });
});

T('item catalogue lists saved items and supports select, edit and delete', async () => {
  // The previous test left "lamp" registered + placed; open the catalogue.
  await page.evaluate(() => window.__voxelgame.ui.cb.items());
  await page.waitForTimeout(120);
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('#item-catalogue .cat-item')].map((c) => c.querySelector('.cat-name').textContent));
  assert.deepEqual(cards, ['Lamp'], 'catalogue must list saved items');

  // Clicking a card arms placement in the world editor and closes the modal.
  await page.evaluate(() => document.querySelector('#item-catalogue .cat-item').click());
  await page.waitForTimeout(120);
  const selected = await page.evaluate(() => ({
    itemId: window.__voxelgame.state.get('itemId'),
    tool: window.__voxelgame.tools.active.id,
    catOpen: window.__voxelgame.catalogue.isOpen,
  }));
  assert.equal(selected.itemId, 'lamp', 'selecting a catalogue item arms it');
  assert.equal(selected.tool, 'item');
  assert.equal(selected.catOpen, false, 'catalogue closes after picking');

  // "Edit" loads the item back into the F2 editor.
  await page.evaluate(() => {
    window.__voxelgame.state.set('itemId', null);
    window.__voxelgame.ui.cb.items();
  });
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#item-catalogue .cat-item .cat-actions .cat-btn')];
    btns.find((b) => b.textContent === 'Edit').click();
  });
  await page.waitForTimeout(150);
  const editing = await page.evaluate(() => ({
    mode: window.__voxelgame.app.mode,
    itemName: window.__voxelgame.itemEditor.item.name,
  }));
  assert.equal(editing.mode, 'item', 'catalogue Edit must open the item editor');
  assert.equal(editing.itemName, 'Lamp');

  // Back to the world editor, then delete the item from the catalogue.
  await page.evaluate(() => window.__voxelgame.app.exitItemEditor());
  await page.waitForTimeout(120);
  await page.evaluate(() => window.__voxelgame.ui.cb.items());
  await page.waitForTimeout(120);
  // Delete is a two-step confirm: first click arms the button, second deletes.
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#item-catalogue .cat-item .cat-actions .cat-btn')];
    btns.find((b) => b.textContent === 'Delete').click();
  });
  await page.waitForTimeout(50);
  const armedText = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#item-catalogue .cat-item .cat-actions .cat-btn')];
    const b = btns.find((x) => x.classList.contains('danger'));
    const text = b.textContent;
    b.click();
    return text;
  });
  assert.equal(armedText, 'Sure?', 'first Delete click must arm, not delete');
  await page.waitForTimeout(150);
  const afterDelete = await page.evaluate(() => ({
    inCatalogue: document.querySelectorAll('#item-catalogue .cat-item').length,
    placedInWorld: window.__voxelgame.app.world.itemAt(4, 2, 4) !== null,
  }));
  assert.equal(afterDelete.inCatalogue, 0, 'deleted item must leave the catalogue');
  assert.equal(afterDelete.placedInWorld, false, 'deleted item placements must be removed');
  await page.evaluate(() => window.__voxelgame.app.save());
  const deletedBundle = await readWorldFile();
  assert.equal((deletedBundle.items ?? []).length, 0, 'deleted item must leave the world file');
});

T('placed objects are lit by the light engine (dark in rooms, bright in the open)', async () => {
  // Save a simple test object through the item editor.
  await page.evaluate(() => {
    const app = window.__voxelgame.app;
    if (app.mode === 'test') app.exitTestMode();
    const ie = app.itemEditor;
    ie.item.id = null; // force a fresh id so the placements reference it
    ie.item.name = 'TestCube';
    ie.item.size = 'small';
    ie.lightOn = false; // must be unlit (the toggle persists from earlier tests)
    ie.item.microVoxels = [
      { x: 0, y: 0, z: 0, color: [200, 200, 200] },
      { x: 1, y: 0, z: 0, color: [200, 200, 200] },
    ];
    ie._rebuild();
    ie.save();
  });

  // Sealed concrete room with an object inside + a control object in open sky.
  await page.evaluate(() => {
    const app = window.__voxelgame.app;
    app.world.clear();
    const S = 'small';
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        for (let y = 0; y <= 6; y++) {
          const wall = Math.abs(x) === 3 || Math.abs(z) === 3 || y === 0 || y === 6;
          if (wall) app.world.place('concrete', S, x, y, z);
        }
      }
    }
    app.world.placeItem('testcube', 'small', 0, 1, 0);
    app.world.placeItem('testcube', 'small', 1, 8, 1); // above the roof: open sky
    app.renderer.clearChunks();
    app.renderer.loadWorldBounds();
    app._refreshItemLights();
    app.itemRenderer.rebuildAll();
  });
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    const ir = window.__voxelgame.itemRenderer;
    const maxSky = (key) => {
      const e = ir._groups.get(key);
      if (!e) return null;
      const light = e.mesh.geometry.attributes.light;
      let max = 0;
      for (let i = 0; i < light.count; i++) max = Math.max(max, light.array[i * 2]);
      return max;
    };
    return {
      room: maxSky('0,1,0'),
      open: maxSky('1,8,1'),
      isShader: ir._groups.get('0,1,0').mesh.material.type === 'ShaderMaterial',
    };
  });
  assert.equal(result.isShader, true, 'objects must render with the lit shader');
  assert.ok(result.room < 0.05, 'object inside a sealed room must be dark');
  assert.ok(result.open > 0.9, 'object in open sky must be bright');
});

T('placing a light-emitting object bakes its light into the world instantly', async () => {
  // Save a light-bearing object.
  await page.evaluate(() => {
    const app = window.__voxelgame.app;
    if (app.mode === 'test') app.exitTestMode();
    const ie = app.itemEditor;
    ie.item.id = null;
    ie.item.name = 'GlowLamp';
    ie.item.size = 'small';
    ie.item.microVoxels = [{ x: 0, y: 0, z: 0, color: [255, 200, 50] }];
    ie.lightOn = true;
    ie.lightColor = [255, 220, 150];
    ie.lightStrength = 3;
    ie._rebuild();
    ie.save();
  });

  // Sealed concrete room.
  await page.evaluate(() => {
    const app = window.__voxelgame.app;
    app.world.clear();
    const S = 'small';
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        for (let y = 0; y <= 6; y++) {
          const wall = Math.abs(x) === 3 || Math.abs(z) === 3 || y === 0 || y === 6;
          if (wall) app.world.place('concrete', S, x, y, z);
        }
      }
    }
    app.renderer.clearChunks();
    app.renderer.loadWorldBounds();
    app.itemRenderer.rebuildAll();
  });

  const maxChunkBlock = async () => page.evaluate(() => {
    let max = 0;
    for (const c of window.__voxelgame.renderer.chunks.values()) {
      // packed geometry: shade = [ao, sky, block, emissive] bytes per vertex
      const shade = c.geometry.attributes.shade;
      if (!shade) continue;
      for (let i = 2; i < shade.count * 4; i += 4) max = Math.max(max, shade.array[i] / 255);
    }
    return max;
  });

  const beforeVal = await maxChunkBlock();
  assert.ok(beforeVal < 0.05, 'sealed room must start with no baked block light');

  // Place the lamp via the same path the item tool uses (onItemChange).
  await page.evaluate(() => {
    const app = window.__voxelgame.app;
    app.world.placeItem('glowlamp', 'small', 0, 1, 0);
    app._refreshItemLights();
  });
  await page.waitForTimeout(50);

  const after = await page.evaluate(() => ({
    field: window.__voxelgame.renderer.light.get(0, 2, 0).block,
  }));
  const chunkBlock = await maxChunkBlock();
  assert.ok(after.field > 0, 'light field must contain the object light');
  assert.ok(chunkBlock > 0.1, 'chunk meshes must bake the object light instantly');
});

T('the Resize tool pulls a prefab wall, moving the build volume and not the build', async () => {
  const before = await page.evaluate(() => {
    const app = window.__voxelgame.app;
    if (app.mode === 'test') app.exitTestMode();
    const ringOutside = app.toolRing.tools.map((t) => t.id);
    app.enterPrefabEditor();
    app.world.clear();
    app.world.place('brick', 'small', 0, 0, 0);
    app.world.place('brick', 'small', 3, 0, 2);
    app._seedPrefabBaseplate();

    // Stand west of the box looking east: the crosshair is on the −X wall.
    // The aim goes through FlyControls, which rewrites the camera rotation
    // from its own yaw/pitch on every frame.
    const cam = app.renderer.camera;
    cam.position.set(-4, 1, 1);
    cam.lookAt(2, 1, 1);
    cam.rotation.reorder('YXZ');
    app.controls.yaw = cam.rotation.y;
    app.controls.pitch = cam.rotation.x;
    cam.updateMatrixWorld(true);

    const tool = app.tools.activate('prefabresize');
    const face = tool.aimedFace();
    return {
      ringOutside,
      ringInside: app.toolRing.tools.map((t) => t.id),
      face: face && [face.axis, face.sign],
      dims: [...app.prefabSession.dims],
      screenAxis: tool._screenAxis(app.prefabSession.dims, 0, -1),
    };
  });
  assert.equal(before.ringOutside.includes('prefabresize'), false, 'Resize stays out of the world editor ring');
  assert.equal(before.ringInside.includes('prefabresize'), true, 'Resize joins the ring inside a session');
  assert.deepEqual(before.face, [0, -1], 'aiming west must grab the −X wall');
  assert.ok(Math.hypot(before.screenAxis[0], before.screenAxis[1]) > 0, 'the wall needs a screen direction to drag along');

  // Grab it and pull 3 cells outward (the drag's pixel scale is pinned here so
  // the assertion is about the commit, not about the projection).
  const after = await page.evaluate(() => {
    const app = window.__voxelgame.app;
    const tool = app.tools.active;
    tool.onMouseDown(0);
    tool._drag.pixels = [10, 0];
    tool.onMouseMove(30, 0);
    const dragging = tool.dragging;
    // Measured across the commit alone: the fly camera keeps drifting on its
    // own velocity between calls.
    const camBefore = app.renderer.camera.position.x;
    tool.onMouseUp(0);
    return {
      dragging,
      camShift: app.renderer.camera.position.x - camBefore,
      dims: [...app.prefabSession.dims],
      atOrigin: app.world.get(0, 0, 0)?.type ?? null,
      shifted: app.world.get(3, 0, 0)?.type ?? null,
      baseplate: app.world.get(0, -1, 0)?.type ?? null,
      dirty: app.prefabSession.dirty,
    };
  });
  assert.equal(after.dragging, true, 'holding the wall must swallow mouse deltas');
  assert.equal(after.dims[0], before.dims[0] + 3, 'the volume grows by the pull');
  assert.equal(after.shifted, 'brick', 'content slides so the min corner stays at the origin');
  assert.equal(after.atOrigin, null);
  assert.equal(after.baseplate, 'concrete', 'the baseplate is re-laid under the new volume');
  assert.ok(Math.abs(after.camShift - 1.5) < 1e-6, 'the camera follows the shift, so the build does not jump');
  assert.equal(after.dirty, true);

  // The panel's side toggle is the typed twin: growing Z from its min wall
  // slides the content the same way a drag would.
  const typed = await page.evaluate(() => {
    const app = window.__voxelgame.app;
    const panel = app.prefabPanel;
    panel.setSide(2, 'min');
    const before = [...app.prefabSession.dims];
    panel.el.dimZ.value = String(before[2] + 2);
    panel.el.dimZ.dispatchEvent(new Event('change'));
    // The far block sat at (6,0,2) after the X drag; +2 on the min Z wall moves it to z=4.
    const grown = { dims: [...app.prefabSession.dims], moved: app.world.get(6, 0, 4)?.type ?? null };

    // Shrinking past the content is refused, not clipped.
    panel.el.dimZ.value = '1';
    panel.el.dimZ.dispatchEvent(new Event('change'));
    return { before, grown, afterRefusal: [...app.prefabSession.dims], side: panel.sideFor(2) };
  });
  assert.equal(typed.side, 'min');
  assert.equal(typed.grown.dims[2], typed.before[2] + 2, 'the typed size grows the volume');
  assert.equal(typed.grown.moved, 'brick', 'growing from the min wall slides the content');
  assert.deepEqual(typed.afterRefusal, typed.grown.dims, 'a shrink that would cut content is refused');

  // One history entry per resize: undo walks them back, content and camera too.
  const undone = await page.evaluate(() => {
    const app = window.__voxelgame.app;
    const camBefore = app.renderer.camera.position.x;
    app.undo(); // the typed Z growth
    app.undo(); // the dragged X wall
    const out = {
      dims: [...app.prefabSession.dims],
      atOrigin: app.world.get(0, 0, 0)?.type ?? null,
      camShift: app.renderer.camera.position.x - camBefore,
    };
    app.exitPrefabEditor();
    return out;
  });
  assert.deepEqual(undone.dims, before.dims);
  assert.equal(undone.atOrigin, 'brick');
  assert.ok(Math.abs(undone.camShift + 1.5) < 1e-6, 'undo carries the camera back too');
});

T('a prefab session pastes library prefabs into its own build volume', async () => {
  const armed = await page.evaluate(() => {
    const app = window.__voxelgame.app;
    if (app.mode === 'test') app.exitTestMode();
    app.enterPrefabEditor();
    app.world.clear();
    app._seedPrefabBaseplate();

    // A one-block prefab, straight into the library cache — the tool reads
    // prefabs from there, so no server round trip is needed.
    app.prefabs._cache.set('e2e_kiosk', {
      id: 'e2e_kiosk',
      name: 'E2E Kiosk',
      dims: [2, 2, 2],
      blocks: [{ type: 'brick', size: 'small', x: 0, y: 0, z: 0 }],
      items: [],
      decals: [],
      paint: [],
    });

    app.openPrefabBrowser();
    const browser = {
      open: app.prefabBrowser.isOpen,
      pasteMode: app.prefabBrowser.pasteMode,
      newHidden: app.prefabBrowser._newBtn.hidden,
    };
    app._placePrefab('e2e_kiosk');
    return {
      browser,
      closedOnPick: !app.prefabBrowser.isOpen,
      tool: app.tools.active?.id,
      inHand: app.state.get('prefabId'),
      stillInSession: !!app.prefabSession,
    };
  });
  assert.equal(armed.browser.open, true, 'the library opens from inside a session');
  assert.equal(armed.browser.pasteMode, true, 'inside a session it opens in paste mode');
  assert.equal(armed.browser.newHidden, true, 'New Prefab steps aside — one session at a time');
  assert.equal(armed.closedOnPick, true);
  assert.equal(armed.tool, 'prefab', 'a card arms the Prefab tool');
  assert.equal(armed.inHand, 'e2e_kiosk');
  assert.equal(armed.stillInSession, true, 'picking a prefab must not end the session');

  // Stamp it on the baseplate. The aim is pinned so the assertion is about
  // the paste, not about the raycast.
  const pasted = await page.evaluate(() => {
    const app = window.__voxelgame.app;
    const tool = app.tools.active;
    tool.pick = () => ({ cell: [2, -1, 2], normal: [0, 1, 0] });
    tool.update(); // builds the ghost, and with it the content box
    tool.onMouseDown(0);
    const placed = app.world.get(2, 0, 2)?.type ?? null;
    app.undo();
    return {
      placed,
      dirty: app.prefabSession.dirty,
      afterUndo: app.world.get(2, 0, 2)?.type ?? null,
    };
  });
  assert.equal(pasted.placed, 'brick', 'the paste lands on the baseplate, inside the volume');
  assert.equal(pasted.dirty, true, 'a paste marks the prefab unsaved');
  assert.equal(pasted.afterUndo, null, 'the paste is one undoable entry');

  // F6 peels back one layer: the open library first, the session only after.
  const stepped = await page.evaluate(() => {
    const app = window.__voxelgame.app;
    app.openPrefabBrowser();
    app.togglePrefabBrowser();
    const out = {
      browserClosed: !app.prefabBrowser.isOpen,
      stillInSession: !!app.prefabSession,
    };
    app.exitPrefabEditor();
    out.leftSession = !app.prefabSession;
    app.openPrefabBrowser();
    out.pasteModeOutside = app.prefabBrowser.pasteMode;
    app.prefabBrowser.hide();
    app.state.set('prefabId', null);
    app.prefabs._cache.delete('e2e_kiosk');
    return out;
  });
  assert.equal(stepped.browserClosed, true, 'F6 shuts the library it opened');
  assert.equal(stepped.stillInSession, true, 'closing the library must not end the session');
  assert.equal(stepped.leftSession, true);
  assert.equal(stepped.pasteModeOutside, false, 'outside a session the library places into the world again');
});
