// game.e2e.test.js — browser smoke test for the playable game (game.html).
//
// Serves game.html with server.mjs (the game is file driven: the world lives
// in the world file behind /api/world). Tests seed the editor's localStorage
// keys exactly like before, then call window.__syncNewGame() which mirrors
// those keys into the world file and starts a new game. Checks: the main menu
// renders with 3 slots, New Game loads the authored world, the player can
// move, and save/load slots round-trip through localStorage.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
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

// A small map + one object, in the same JSON the editor writes to storage.
const FLOOR = [];
for (let x = 0; x < 8; x += 2) {
  for (let z = 0; z < 8; z += 2) FLOOR.push({ x, y: 0, z, size: 'big', type: 'grass' });
}
const MAP = JSON.stringify({
  format: 'voxelmap',
  version: 1,
  cellSize: 0.5,
  spawn: [2, 4, 2],
  blocks: FLOOR,
  items: [{ itemId: 'lamp', x: 0, y: 2, z: 0, size: 'small', rotation: 0 }],
});
const ITEMS = JSON.stringify([
  { id: 'lamp', name: 'Lamp', size: 'small', solid: true, microVoxels: [{ x: 0, y: 0, z: 0, color: [255, 200, 50] }], light: null },
  { id: 'sword', name: 'Sword', size: 'small', solid: true, microVoxels: [{ x: 0, y: 0, z: 0, color: [200, 200, 200] }], light: null },
  { id: 'medkit', name: 'Medkit', size: 'small', solid: false, microVoxels: [{ x: 0, y: 0, z: 0, color: [255, 80, 80] }], light: null },
]);

let browser;
let page;
let srv; // running server.mjs instance

// An empty map (used to blank the world file for the slot round-trip test).
const EMPTY_MAP = { format: 'voxelmap', version: 1, cellSize: 0.5, spawn: null, spawnYaw: 0, blocks: [], items: [], mobs: [], decals: [] };

/** Write (merge) the world file the game reads. Only the provided keys are
 *  replaced; the rest carry over from whatever is on disk, mirroring how the
 *  old per-key localStorage seeds accumulated. */
async function writeWorld(patch) {
  const url = `http://localhost:${srv.port}/api/world`;
  let cur = {};
  try {
    const res = await fetch(url);
    const t = await res.text();
    if (t && t !== 'null') cur = JSON.parse(t);
  } catch { /* fresh file */ }
  const norm = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  const bundle = {
    format: 'voxelbundle', version: 1,
    map: patch.map ? norm(patch.map) : cur.map ?? EMPTY_MAP,
    items: patch.items ? norm(patch.items) : cur.items ?? [],
    equip: patch.equip ? norm(patch.equip) : cur.equip ?? [],
  };
  await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bundle) });
}

/** Injected into the page: mirrors the legacy localStorage seed keys into the
 *  world file, then starts a new game (which loads from that file). With no
 *  keys set it is exactly newGame(). */
function installSyncNewGame() {
  window.__syncNewGame = async () => {
    let cur = {};
    try {
      const res = await fetch('/api/world');
      const t = await res.text();
      if (t && t !== 'null') cur = JSON.parse(t);
    } catch { /* fresh file */ }
    const read = (key) => {
      const raw = localStorage.getItem(key);
      if (raw == null) return undefined;
      try { return JSON.parse(raw); } catch { return undefined; }
    };
    const bundle = {
      format: 'voxelbundle', version: 1,
      map: read('voxelmap.save') ?? cur.map,
      items: read('voxelitem.items') ?? cur.items ?? [],
      equip: read('voxelequip.items') ?? cur.equip ?? [],
    };
    await fetch('/api/world', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bundle) });
    await window.__voxelgame.newGame();
  };
}

before(async () => {
  if (!available) return;
  browser = await globalThis.__pwChromium.launch({
    executablePath: chromiumExe,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(installSyncNewGame);

  // The game reads the world file, so point the server at a temp file and seed
  // it with the map + items the first test expects (the editor's authored world).
  const tmp = join(tmpdir(), `voxelgame-game-e2e-${Date.now().toString(36)}`);
  mkdirSync(join(tmp, 'worlds'), { recursive: true });
  srv = await startServer({
    port: 0, worldFile: join(tmp, 'voxelbundle.json'), root: ROOT,
    worldsDir: join(tmp, 'worlds'),
    splashFile: join(tmp, 'splash.json'),
    editorStateFile: join(tmp, 'editor.json'),
  });
  await writeWorld({ map: MAP, items: ITEMS, equip: [] });
});

after(async () => {
  if (mobile) await mobile.close();
  if (browser) await browser.close();
  if (srv) srv.server.close();
});

const T = (name, fn) => test(name, { skip }, fn);

async function loadGame() {
  await page.goto(`http://localhost:${srv.port}/game.html`);
  await page.waitForFunction(() => !!window.__voxelgame, { timeout: 15000 });
  await page.waitForTimeout(300);
}

T('menu shows and New Game loads the seeded editor world', async () => {
  // Seed editor storage before the game reads it.
  await page.addInitScript(({ map, items }) => {
    localStorage.setItem('voxelmap.save', map);
    localStorage.setItem('voxelitem.items', items);
  }, { map: MAP, items: ITEMS });
  await loadGame();

  const menu = await page.evaluate(() => ({
    menuVisible: !window.__voxelgame.ui.menu.classList.contains('hidden'),
    slots: [...document.querySelectorAll('#slots-menu .slot-row')].length,
    mode: window.__voxelgame.mode,
  }));
  assert.equal(menu.menuVisible, true, 'main menu must be visible');
  assert.equal(menu.slots, 3, 'menu must render 3 load slots');
  assert.equal(menu.mode, 'menu');

  await page.evaluate(() => window.__voxelgame.ui.btnNew.click());
  await page.waitForTimeout(200);

  const playing = await page.evaluate(() => ({
    mode: window.__voxelgame.mode,
    count: window.__voxelgame.world.count,
    items: (() => { let n = 0; window.__voxelgame.world.forEachItem(() => n++); return n; })(),
    spawn: window.__voxelgame.world.spawn ? [...window.__voxelgame.world.spawn] : null,
    hud: getComputedStyle(window.__voxelgame.ui.hud).display !== 'none',
  }));
  assert.equal(playing.mode, 'playing');
  assert.equal(playing.count, 16);
  assert.equal(playing.items, 1);
  assert.deepEqual(playing.spawn, [2, 4, 2]);
  assert.equal(playing.hud, true, 'HUD must show while playing');
});

T('player can walk in the world', async () => {
  const moved = await page.evaluate(() => {
    const { walk, mode } = window.__voxelgame;
    // Stand on the 1m floor: big blocks span cells 0..7 (world 0..4m) and
    // their tops sit at world y = 1.0.
    walk.position.set(3.5, 1.0, 3.5);
    walk.velocity.set(0, 0, 0);
    walk.yaw = 0;
    walk.keys.clear();
    walk.keys.add('KeyW');
    const startZ = walk.position.z;
    for (let i = 0; i < 20; i++) walk.update(1 / 60);
    walk.keys.clear();
    return { moved: walk.position.z < startZ, z: walk.position.z, y: walk.position.y, mode };
  });
  assert.equal(moved.mode, 'playing');
  assert.equal(moved.moved, true, 'W must move the player forward (-z)');
  assert.ok(moved.y >= 1.0 - 0.01, `player must stay on the floor, got y=${moved.y}`);
});

T('save/load: position + pickups persist, map edits reach the save', async () => {
  // Pick up the lamp, move somewhere, then save to slot 0. The world is
  // static, so the save stores only player state + pickup tombstones.
  const saved = await page.evaluate(async () => {
    const g = window.__voxelgame;
    g.walk.position.set(3.5, 1.0, 1.5);
    g.walk.yaw = 0.7;
    g.world.removeItemAt(0, 2, 0); // pick up the lamp (state-level)
    await g.saveSlot(0);
    const slot = await g.saves.read('slot0');
    return {
      pos: [slot.player.x, slot.player.y, slot.player.z],
      yaw: slot.player.yaw,
      format: slot.format,
      pickedUp: slot.pickedUp,
      savedAt: !!slot.savedAt,
    };
  });
  assert.deepEqual(saved.pos, [3.5, 1.0, 1.5]);
  assert.equal(saved.yaw, 0.7);
  assert.equal(saved.format, 'voxelsave');
  assert.deepEqual(saved.pickedUp, [{ itemId: 'lamp', x: 0, y: 2, z: 0 }], 'the pickup must be tombstoned');
  assert.equal(saved.savedAt, true);

  // Edit the authored map (one extra block), reload, then load slot 0: the
  // EDITED map must win — plus the pickup stays gone and position restores.
  const edited = JSON.parse(MAP);
  edited.blocks = [...edited.blocks, { x: 10, y: 0, z: 10, size: 'big', type: 'grass' }];
  await writeWorld({ map: edited });
  await loadGame();
  await page.evaluate(() => window.__voxelgame.loadSlot(0));
  await page.waitForTimeout(200);

  const loaded = await page.evaluate(() => {
    const { world, walk, mode } = window.__voxelgame;
    return {
      mode,
      count: world.count,
      lampThere: !!world.itemAt(0, 2, 0),
      pos: [walk.position.x, walk.position.y, walk.position.z],
      yaw: walk.yaw,
    };
  });
  assert.equal(loaded.mode, 'playing', 'loading a slot must enter play');
  assert.equal(loaded.count, 17, 'map edits must reach the loaded save');
  assert.equal(loaded.lampThere, false, 'the picked-up lamp must stay gone');
  assert.ok(Math.abs(loaded.pos[0] - 3.5) < 1e-6, `position x restored, got ${loaded.pos[0]}`);
  assert.ok(Math.abs(loaded.yaw - 0.7) < 1e-6, `yaw restored, got ${loaded.yaw}`);

  // Blank the world file for the tests that follow; the init script keeps
  // the cumulative localStorage state in step for later __syncNewGame calls.
  await writeWorld({ map: EMPTY_MAP });
  await page.addInitScript(({ map }) => localStorage.setItem('voxelmap.save', map), { map: JSON.stringify(EMPTY_MAP) });
});

T('death is canon: staged slow-mo sequence, respawn empty-handed', async () => {
  await loadGame();
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);

  const dead = await page.evaluate(() => {
    const g = window.__voxelgame;
    g.stats.equip('primary', 'sword');
    g.stats.addMaterial('scrap', 5);
    g.stats.damage(1000);
    g.gameOver();
    return {
      mode: g.mode,
      dying: g.container.classList.contains('dying'),
      titleShown: g.ui.deathTitle.classList.contains('show'),
    };
  });
  assert.equal(dead.mode, 'dead');
  assert.equal(dead.dying, true, 'the canvas desaturation class must be on');
  assert.equal(dead.titleShown, false, 'the title must not pop in instantly');

  // Drive the sequence clock by hand — swiftshader frame times can exceed the
  // loop's dt clamp, so waiting real seconds under-accumulates sequence time.
  const staged = await page.evaluate(() => {
    const g = window.__voxelgame;
    g._updateDeath(1.2); // past the title delay, before the button delay
    const midway = {
      titleShown: g.ui.deathTitle.classList.contains('show'),
      buttonShown: g.ui.btnRespawn.classList.contains('show'),
    };
    g._updateDeath(1.6); // past the button delay
    return {
      midway,
      titleShown: g.ui.deathTitle.classList.contains('show'),
      buttonShown: g.ui.btnRespawn.classList.contains('show'),
    };
  });
  assert.equal(staged.midway.titleShown, true, 'YOU DIED must fade in first');
  assert.equal(staged.midway.buttonShown, false, 'the respawn button must come later');
  assert.equal(staged.titleShown, true);
  assert.equal(staged.buttonShown, true, 'the respawn button must have faded in');

  const respawned = await page.evaluate(() => {
    const g = window.__voxelgame;
    g.respawn();
    return {
      mode: g.mode,
      health: g.stats.health,
      primary: g.stats.equipment.primary,
      scrap: g.stats.materialCount('scrap'),
      dying: g.container.classList.contains('dying'),
      deathHidden: g.ui.death.classList.contains('hidden'),
      roll: g.renderer.camera.rotation.z,
    };
  });
  assert.equal(respawned.mode, 'playing');
  assert.equal(respawned.health, 100, 'respawn restores full health');
  assert.equal(respawned.primary, null, 'carried gear is gone forever');
  assert.equal(respawned.scrap, 0, 'carried materials are gone forever');
  assert.equal(respawned.dying, false, 'desaturation must be torn down');
  assert.equal(respawned.deathHidden, true);
  assert.equal(respawned.roll, 0, 'camera tilt must reset');
});

T('HUD shows health, armor, equipment slots and fists by default', async () => {
  await loadGame();
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);

  const hud = await page.evaluate(() => {
    const g = window.__voxelgame;
    return {
      health: g.stats.health,
      armor: g.stats.armor,
      healthText: document.querySelector('#health-text').textContent,
      armorText: document.querySelector('#armor-text').textContent,
      slots: document.querySelectorAll('#equipment .eq-slot').length,
      slotLabels: [...document.querySelectorAll('#equipment .eq-slot-name')].map((e) => e.textContent),
      hand: document.querySelector('#hand').textContent,
      activeSlot: g.stats.activeSlotName,
    };
  });
  assert.equal(hud.health, 100);
  assert.equal(hud.armor, 0, 'armor starts empty — it comes from armor pickups');
  assert.equal(hud.healthText, '100');
  assert.equal(hud.armorText, '0');
  assert.equal(hud.slots, 4, 'HUD must render 4 equipment slots');
  assert.deepEqual(hud.slotLabels, ['—', '—', '—', '—']);
  assert.equal(hud.hand, 'Fists', 'empty hand must show fists');
  assert.equal(hud.activeSlot, 'primary');
});

T('equipped items render their editor-style icon in the hotbar', async () => {
  await loadGame();
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);
  const out = await page.evaluate(() => {
    const g = window.__voxelgame;
    // Empty slots show the dash label, not an icon.
    const empty = document.querySelector('#equipment .eq-slot');
    const emptyBefore = {
      hasCanvas: !!empty.querySelector('canvas'),
      label: empty.querySelector('.eq-slot-name')?.textContent,
    };
    g.stats.equip('primary', 'sword');
    g._updateHud();
    const slot0 = document.querySelector('#equipment .eq-slot');
    const canvas = slot0.querySelector('canvas');
    return {
      emptyBefore,
      hasCanvas: !!canvas,
      canvasSize: canvas ? [canvas.width, canvas.height] : null,
      title: slot0.title,
      active: slot0.classList.contains('active'),
    };
  });
  assert.equal(out.emptyBefore.hasCanvas, false, 'empty slot must not show an icon');
  assert.equal(out.emptyBefore.label, '—');
  assert.equal(out.hasCanvas, true, 'an equipped item must render an icon canvas');
  assert.ok(out.canvasSize[0] > 0 && out.canvasSize[1] > 0, 'the icon canvas must have pixels');
  assert.equal(out.title, 'Sword (1)', 'slot tooltip must show the item name');
  assert.equal(out.active, true, 'the equipped slot stays selected');
});

T('equipment switching, injection use and attack work', async () => {
  await loadGame();
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);

  const result = await page.evaluate(() => {
    const g = window.__voxelgame;
    // equip a sword in primary and a medkit in injection
    g.stats.equip('primary', 'sword');
    g.stats.equip('injection', 'medkit');
    g._updateHud();

    const beforeDamage = { health: g.stats.health, armor: g.stats.armor };
    g.stats.damage(50);
    const afterDamage = { health: g.stats.health, armor: g.stats.armor };

    // select slot 2 (extra) -> empty, so fists
    g._selectSlot(2);
    const extraHand = document.querySelector('#hand').textContent;
    const extraActive = g.stats.activeSlotName;

    // back to primary -> sword in hand
    g._selectSlot(0);
    const primaryHand = document.querySelector('#hand').textContent;

    // use the injection (heals, consumes it)
    g._useInjection();
    const injectionGone = !g.stats.equipment.injection;
    const healed = g.stats.health;

    return { beforeDamage, afterDamage, extraHand, extraActive, primaryHand, injectionGone, healed };
  });
  assert.ok(result.afterDamage.health < result.beforeDamage.health, 'damage must reduce health');
  assert.equal(result.extraActive, 'extra');
  assert.equal(result.extraHand, 'Fists', 'empty slot attacks with fists');
  assert.equal(result.primaryHand, 'Sword', 'equipped primary shows its weapon name');
  assert.equal(result.injectionGone, true, 'injection consumed on use');
  assert.ok(result.healed > result.afterDamage.health, 'injection must heal');
});

T('left click attacks but does not destroy blocks', async () => {
  await loadGame();
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);

  const attacked = await page.evaluate(() => {
    const g = window.__voxelgame;
    const { renderer } = g;
    document.pointerLockElement = g.webgl.domElement; // fake lock for the attack guard
    renderer.camera.position.set(1.25, 1.0, 1.25);
    renderer.camera.lookAt(1.25, 0, 1.25);
    const before = g.world.count;
    g._attackCooldown = 0;
    g._attack();
    const after = g.world.count;
    document.pointerLockElement = null;
    return { before, after };
  });
  assert.equal(attacked.after, attacked.before, 'blocks are not destructible — attack must not change the world');
});

T('attack pops smoke on a wall hit but not on empty air', async () => {
  await loadGame();
  await page.evaluate(async () => {
    const g = window.__voxelgame;
    await window.__syncNewGame();
    g.world.clear();
    g.renderer.clearChunks();
    g.world.place('grass', 'big', 2, 0, 2); // block at world x 1..2, y 0..1, z 1..2
    g.renderer.loadWorldBounds();
  });
  await page.waitForTimeout(150);

  const result = await page.evaluate(() => {
    const g = window.__voxelgame;
    const { renderer } = g;
    const smokeCount = () => g.smoke._mesh.filter((p) => p.alive).length;
    document.pointerLockElement = g.webgl.domElement;

    // Hit: aim at an OFF-CENTER point on the block's top face (plane y=1.0),
    // so the exact impact spot differs from the face center (1.5,1.0,1.5).
    renderer.camera.position.set(1.5, 2.0, 1.5);
    renderer.camera.lookAt(1.7, 0.5, 1.8);
    const hitPoint = g._aim();
    const onTopFace = !!hitPoint && Math.abs(hitPoint[1] - 1.0) < 0.001;
    const faceCenter = hitPoint && [1.5, 1.0, 1.5].every((v, i) => Math.abs(v - hitPoint[i]) < 0.001);
    g._attackCooldown = 0;
    g._attack();
    const afterHit = smokeCount();
    const puffPos = g.smoke._mesh.filter((p) => p.alive)[0]?.mesh.position.toArray();

    // Miss: look at empty sky.
    renderer.camera.lookAt(5, 6, 5);
    const missPoint = g._aim();
    const afterMiss = (() => { g._attackCooldown = 0; g._attack(); return smokeCount(); })();

    // Smoke expires over time.
    g.smoke.update(1.2);
    const afterExpire = smokeCount();

    document.pointerLockElement = null;
    return { hitPoint, onTopFace, faceCenter, puffPos, missPoint, afterHit, afterMiss, afterExpire };
  });
  assert.ok(result.hitPoint, 'aiming at a block must find a hit point');
  assert.equal(result.onTopFace, true, 'smoke must originate on the hit surface (top face), not the voxel center');
  assert.equal(result.faceCenter, false, 'hit point must be the exact aim spot, not the face center');
  assert.equal(result.missPoint, null, 'aiming at empty sky must miss');
  assert.equal(result.afterHit, 12, 'a connected hit must spawn a smoke puff');
  assert.equal(result.afterMiss, 12, 'a miss must not add smoke (still the previous puff)');
  assert.equal(result.afterExpire, 0, 'smoke must fade out after its lifetime');
  assert.ok(Array.isArray(result.puffPos), 'puff meshes must have a position');
});

T('smoke is lit by the world — dark in a sealed room, bright in open sky', async () => {
  await loadGame();
  const out = await page.evaluate(async () => {
    const g = window.__voxelgame;
    await window.__syncNewGame();
    // The game starts at night; force midday so "open sky" is actually bright.
    g.renderer._skyTime = 0;
    g.renderer._updateSky(0);
    g.world.clear();
    g.renderer.clearChunks();

    // Sealed room: floor + ceiling + four walls of opaque big blocks, so the
    // interior has no sky light and no block light.
    for (let x = 0; x < 8; x += 2) {
      for (let z = 0; z < 8; z += 2) {
        g.world.place('grass', 'big', x, 0, z);
        g.world.place('grass', 'big', x, 12, z);
      }
    }
    for (let y = 2; y <= 11; y += 2) {
      for (let z = 0; z < 8; z += 2) {
        g.world.place('grass', 'big', 0, y, z);
        g.world.place('grass', 'big', 6, y, z);
      }
      for (let x = 0; x < 8; x += 2) {
        g.world.place('grass', 'big', x, y, 0);
        g.world.place('grass', 'big', x, y, 6);
      }
    }
    g.renderer.loadWorldBounds();
    g.smoke.clear();
    g.smoke.puff([1.5, 3, 1.5]); // interior cell (3, 6, 3)
    const dark = g.smoke._mesh.find((p) => p.alive).mesh.material.color.toArray();

    // Open sky: a floor only, smoke above it.
    g.world.clear();
    g.renderer.clearChunks();
    for (let x = 0; x < 8; x += 2) {
      for (let z = 0; z < 8; z += 2) g.world.place('grass', 'big', x, 0, z);
    }
    g.renderer.loadWorldBounds();
    g.smoke.clear();
    g.smoke.puff([1.5, 3, 1.5]);
    const bright = g.smoke._mesh.find((p) => p.alive).mesh.material.color.toArray();
    return { dark, bright };
  });
  // Sealed-room smoke must be much dimmer than open-sky smoke.
  const darkLum = out.dark[0] + out.dark[1] + out.dark[2];
  const brightLum = out.bright[0] + out.bright[1] + out.bright[2];
  assert.ok(brightLum > 1, `open-sky smoke must be bright (lum ${brightLum})`);
  assert.ok(darkLum < brightLum * 0.35, `sealed-room smoke must be dark (dark ${darkLum} vs bright ${brightLum})`);
});

T('a placed equippable item renders in the game', async () => {
  await loadGame();
  // Simulate a pistol made in the F3 editor: seed the equipment registry and a
  // map with the pistol placed, then start a new game (which reloads storage).
  await page.evaluate((floor) => {
    localStorage.setItem('voxelequip.items', JSON.stringify([
      {
        id: 'pistol', name: 'Pistol',
        microVoxels: [
          { x: 3, y: 3, z: 4, color: [70, 70, 75] },
          { x: 3, y: 3, z: 5, color: [40, 40, 45] },
        ],
        grip: { x: 3, y: 3, z: 4 },
        yaw: 90,
        stats: { damage: 20, reach: 3, cooldown: 0.3 },
      },
    ]));
    localStorage.setItem('voxelmap.save', JSON.stringify({
      format: 'voxelmap', version: 1, cellSize: 0.5, spawn: [2, 4, 2],
      blocks: floor,
      items: [{ itemId: 'pistol', x: 0, y: 2, z: 0, size: 'small', rotation: 0 }],
    }));
  }, FLOOR);
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(200);

  const result = await page.evaluate(() => {
    const g = window.__voxelgame;
    const groups = [];
    g.itemRenderer._groups.forEach((entry) => {
      groups.push({ id: entry.placement.itemId, visible: entry.mesh.visible, tris: entry.geo.index.count });
    });
    return { groups, equipId: g.itemRenderer._groups.get('0,2,0')?.placement.itemId };
  });
  assert.equal(result.groups.length, 1, 'placed equippable item must have a mesh group');
  assert.equal(result.groups[0].id, 'pistol');
  assert.equal(result.groups[0].visible, true, 'the pistol mesh must be visible');
  assert.ok(result.groups[0].tris > 0, 'the pistol mesh must have geometry (not empty)');
});

T('aiming at an equippable item highlights it and E picks it up', async () => {
  await loadGame();
  await page.evaluate(() => {
    localStorage.setItem('voxelequip.items', JSON.stringify([
      {
        id: 'pistol', name: 'Pistol',
        microVoxels: [{ x: 3, y: 3, z: 4, color: [70, 70, 75] }],
        grip: { x: 3, y: 3, z: 4 }, yaw: 90,
        stats: { damage: 20, reach: 3, cooldown: 0.3 },
      },
    ]));
    localStorage.setItem('voxelmap.save', JSON.stringify({
      format: 'voxelmap', version: 1, cellSize: 0.5, spawn: [2, 4, 2],
      blocks: [],
      items: [{ itemId: 'pistol', x: 0, y: 2, z: 0, size: 'small', rotation: 0 }],
    }));
  });
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);

  // Aim at the pistol: highlight + prompt appear, then E picks it up.
  const result = await page.evaluate(() => {
    const g = window.__voxelgame;
    const { renderer } = g;
    // Within arm's reach: pickups only register within PICKUP_RANGE (1 m).
    renderer.camera.position.set(0.25, 1.25, 1.2);
    renderer.camera.lookAt(0.25, 1.25, 0.25);
    g._updatePickup();
    const pickup = document.querySelector('#pickup');
    const aimed = g._pickupTarget
      ? { id: g._pickupTarget.item.itemId, markerVisible: g._pickupOutline.visible }
      : null;
    const prompt = {
      visible: !pickup.classList.contains('hidden'),
      text: pickup.textContent.replace(/\s+/g, ' ').trim(),
    };

    g._pickup();
    // The item detaches from the world and floats to the player before the
    // grant: during the flight nothing is equipped yet.
    const midFlight = {
      primary: g.stats.equipment.primary,
      worldItems: (() => { let n = 0; g.world.forEachItem(() => n++); return n; })(),
      flying: !!g.pickupFX._group,
    };
    g.pickupFX.update(1); // let the item finish flying to the player
    const after = {
      primary: g.stats.equipment.primary,
      hand: document.querySelector('#hand').textContent,
      worldItems: (() => { let n = 0; g.world.forEachItem(() => n++); return n; })(),
      markerVisible: g._pickupOutline.visible,
      flying: !!g.pickupFX._group,
    };
    return { aimed, prompt, midFlight, after };
  });
  assert.deepEqual(result.aimed, { id: 'pistol', markerVisible: true }, 'aiming at the pistol must highlight it');
  assert.equal(result.prompt.visible, true, 'pickup prompt must be visible');
  assert.ok(result.prompt.text.includes('E') && result.prompt.text.includes('Pistol'), `prompt text: ${result.prompt.text}`);
  assert.equal(result.midFlight.primary, null, 'during the flight the item is not granted yet');
  assert.equal(result.midFlight.worldItems, 0, 'the placed item leaves the world as soon as it is picked up');
  assert.equal(result.midFlight.flying, true, 'a copy of the item must be floating to the player');
  assert.equal(result.after.primary, 'pistol', 'E must put the pistol in an equipment slot once it arrives');
  assert.equal(result.after.hand, 'Pistol', 'HUD hand must show the picked-up weapon name');
  assert.equal(result.after.worldItems, 0, 'the placed item must stay removed from the world');
  assert.equal(result.after.flying, false, 'the flying copy must be gone after the pickup completes');

  // Looking away hides the highlight + prompt.
  const away = await page.evaluate(() => {
    const g = window.__voxelgame;
    g.renderer.camera.lookAt(5, 6, 5);
    g._updatePickup();
    return { target: g._pickupTarget, promptHidden: document.querySelector('#pickup').classList.contains('hidden') };
  });
  assert.equal(away.target, null, 'aiming away must clear the pickup target');
  assert.equal(away.promptHidden, true, 'aiming away must hide the prompt');
});

T('rapid pickups queue up and are granted one at a time', async () => {
  await loadGame();
  await page.evaluate(() => {
    localStorage.setItem('voxelequip.items', JSON.stringify([
      {
        id: 'pistol', name: 'Pistol',
        microVoxels: [{ x: 3, y: 3, z: 4, color: [70, 70, 75] }],
        grip: { x: 3, y: 3, z: 4 }, yaw: 90,
        stats: { damage: 20, reach: 3, cooldown: 0.3 },
      },
    ]));
    localStorage.setItem('voxelmap.save', JSON.stringify({
      format: 'voxelmap', version: 1, cellSize: 0.5, spawn: [2, 4, 2],
      blocks: [],
      items: [
        { itemId: 'pistol', x: 0, y: 2, z: 0, size: 'small', rotation: 0 },
        { itemId: 'pistol', x: 2, y: 2, z: 0, size: 'small', rotation: 0 },
      ],
    }));
  });
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);

  const out = await page.evaluate(() => {
    const g = window.__voxelgame;
    const { renderer } = g;
    // Pick up pistol A (both stand within PICKUP_RANGE of the camera).
    renderer.camera.position.set(0.25, 1.25, 1.2);
    renderer.camera.lookAt(0.25, 1.25, 0.25);
    g._updatePickup();
    g._pickup();
    // Immediately aim at and pick up pistol B.
    renderer.camera.position.set(1.25, 1.25, 1.2);
    renderer.camera.lookAt(1.25, 1.25, 0.25);
    g._updatePickup();
    g._pickup();
    const queued = {
      primary: g.stats.equipment.primary,
      secondary: g.stats.equipment.secondary,
      queueLen: g._pickupQueue.length,
      flying: g.pickupFX.active,
    };
    g.pickupFX.update(1); // A's flight lands
    const afterA = {
      primary: g.stats.equipment.primary,
      secondary: g.stats.equipment.secondary,
      flying: g.pickupFX.active,
    };
    g.pickupFX.update(1); // B's flight lands
    const afterB = {
      primary: g.stats.equipment.primary,
      secondary: g.stats.equipment.secondary,
      queueLen: g._pickupQueue.length,
      flying: g.pickupFX.active,
      worldItems: (() => { let n = 0; g.world.forEachItem(() => n++); return n; })(),
    };
    return { queued, afterA, afterB };
  });
  assert.equal(out.queued.primary, null, 'nothing is granted before the first flight lands');
  assert.equal(out.queued.queueLen, 1, 'the second pickup must queue behind the first');
  assert.equal(out.queued.flying, true, 'the first pickup is airborne');
  assert.equal(out.afterA.primary, 'pistol', 'the first pickup is granted when it arrives');
  assert.equal(out.afterA.flying, true, 'the second pickup starts flying after the first lands');
  assert.equal(out.afterB.primary, 'pistol', 'the second pickup lands in the primary slot');
  assert.equal(out.afterB.secondary, 'pistol', 'the second pickup lands in the secondary slot');
  assert.equal(out.afterB.queueLen, 0, 'the queue must drain fully');
  assert.equal(out.afterB.worldItems, 0, 'both items must leave the world');
});

T('equipping an item renders it in the hand at the grip voxel', async () => {
  await loadGame();
  await page.evaluate(() => {
    localStorage.setItem('voxelequip.items', JSON.stringify([
      {
        id: 'pistol', name: 'Pistol',
        microVoxels: [
          { x: 3, y: 3, z: 4, color: [70, 70, 75] },
          { x: 3, y: 3, z: 5, color: [40, 40, 45] },
        ],
        grip: { x: 3, y: 3, z: 4 }, yaw: 90,
        stats: { damage: 20, reach: 3, cooldown: 0.3 },
      },
    ]));
  });
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);

  const result = await page.evaluate(() => {
    const g = window.__voxelgame;
    const T = g.hand.THREE;
    g.stats.equip('primary', 'pistol');
    g._updateHud(); // triggers _updateHeldItem

    const held = g.hand._heldGroup;
    if (!held) return { held: false };
    g.hand.group.updateMatrixWorld(true);

    // Grip voxel (held group origin) must coincide with the palm centre.
    const gripWorld = new T.Vector3();
    held.getWorldPosition(gripWorld);
    const palm = g.hand.right.pivot.children.find((c) => c.isMesh && c.position.y === 0.06);
    const palmWorld = new T.Vector3();
    palm.getWorldPosition(palmWorld);

    // Item forward (grid +Z rotated by yaw, then by the hand) must point toward
    // the view.
    const yaw = (90 * Math.PI) / 180;
    const itemFwd = new T.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).transformDirection(held.matrixWorld);
    const camForward = g.renderer.camera.getWorldDirection(new T.Vector3());

    // With a weapon, a swing must animate the right (weapon) hand.
    g.hand.swing();
    const swungRight = !!g.hand.right.anim;

    // Equipping starts a hands-dip: the shared root drops below rest, then
    // eases back up over the animation.
    const dipStarted = !!g.hand._equip;
    g.hand.update(0.1); // well into the drop
    const dipped = g.hand.group.position.y < -0.1;
    g.hand.update(1); // past the end — hands back to rest
    const risen = g.hand.group.position.y === 0;

    return {
      held: true,
      visible: held.visible,
      onRightPivot: held.parent === g.hand.right.pivot,
      gripInPivot: held.position.toArray(),
      gripAtPalm: gripWorld.distanceTo(palmWorld) < 0.01,
      forwardAligned: itemFwd.dot(camForward) > 0.9,
      swungRight,
      dipStarted,
      dipped,
      risen,
    };
  });
  assert.equal(result.held, true, 'held item mesh must exist');
  assert.equal(result.visible, true, 'held item must be visible');
  assert.equal(result.onRightPivot, true, 'held item must attach to the right-hand pivot');
  assert.deepEqual(result.gripInPivot, [0, 0.06, 0], 'grip voxel must sit at the palm centre');
  assert.equal(result.gripAtPalm, true, 'grip voxel must coincide with the palm in world space');
  assert.equal(result.dipStarted, true, 'equipping a weapon must start the hands-dip animation');
  assert.equal(result.dipped, true, 'the hands must drop below rest when a weapon is equipped');
  assert.equal(result.risen, true, 'the hands must return to rest once the dip finishes');
  assert.equal(result.forwardAligned, true, 'item forward must point toward the view');
  assert.equal(result.swungRight, true, 'with a weapon, swing must animate the right hand');

  // Equipping nothing (fists) removes the held item.
  const cleared = await page.evaluate(() => {
    const g = window.__voxelgame;
    g.stats.unequip('primary');
    g._updateHud();
    return g.hand._heldGroup;
  });
  assert.equal(cleared, null, 'unequipping must clear the held item');
});

T('a ranged weapon recoils, flashes at the muzzle and smokes at the range-limited hit', async () => {
  await loadGame();
  await page.evaluate(() => {
    localStorage.setItem('voxelequip.items', JSON.stringify([
      {
        id: 'pistol', name: 'Pistol',
        microVoxels: [{ x: 3, y: 3, z: 4, color: [70, 70, 75] }],
        grip: { x: 3, y: 3, z: 4 }, yaw: 90,
        stats: { damage: 20, reach: 3, cooldown: 0.2 }, // reach 3 m = 6 cells
        weapon: { kind: 'ranged', hands: 'one', muzzle: { x: 3, y: 3, z: 5 }, anim: 'gun', recoil: 0.08 },
      },
    ]));
  });
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);

  const result = await page.evaluate(() => {
    const g = window.__voxelgame;
    g.stats.equip('primary', 'pistol');
    g._updateHud();
    const { renderer } = g;
    const smokeCount = () => g.smoke._mesh.filter((p) => p.alive).length;

    // Hit: a wall block within the pistol's range.
    g.world.clear();
    g.renderer.clearChunks();
    g.world.place('grass', 'big', 2, 0, 2);
    g.renderer.loadWorldBounds();
    document.pointerLockElement = g.webgl.domElement;
    renderer.camera.position.set(1.5, 2.0, 1.5);
    renderer.camera.lookAt(1.7, 0.5, 1.8);
    g._attackCooldown = 0;
    g._attack();
    const muzzleWorld = g.hand.heldMuzzleWorld(new g.hand.THREE.Vector3());
    // The attached flash sits on the held weapon at the muzzle voxel.
    const T = g.hand.THREE;
    const flashWorld = new T.Vector3();
    g.hand.group.updateMatrixWorld(true);
    g.hand._heldFlash.getWorldPosition(flashWorld);
    const flashNearMuzzle = muzzleWorld && g.hand._heldFlash.visible &&
      flashWorld.distanceTo(muzzleWorld) < 0.2;
    const sparkAlive = g.muzzleFX._sparks.some((s) => s.alive);
    const muzzleSmokeAlive = g.muzzleFX._smoke.some((p) => p.alive);
    const hit = {
      anim: g.hand.right.anim?.name,
      flash: g.hand._heldFlash.visible,
      smoke: smokeCount(),
      sparkAlive,
      muzzleSmokeAlive,
    };

    // Miss: aim at empty sky — same recoil/flash, but no impact smoke.
    renderer.camera.lookAt(5, 6, 5);
    g._attackCooldown = 0;
    g._attack();
    const miss = { anim: g.hand.right.anim?.name, smoke: smokeCount() };

    document.pointerLockElement = null;
    return { hit, miss, flashNearMuzzle, muzzleWorld: muzzleWorld?.toArray() };
  });

  assert.equal(result.hit.anim, 'gun', 'ranged attack must play the gun recoil');
  assert.equal(result.hit.flash, true, 'a shot must show a muzzle flash');
  assert.equal(result.hit.smoke, 12, 'a shot within range must smoke at the impact');
  assert.equal(result.flashNearMuzzle, true, 'the flash must sit at the barrel (muzzle voxel)');
  assert.equal(result.hit.sparkAlive, true, 'a shot must throw little sparks from the muzzle');
  assert.equal(result.hit.muzzleSmokeAlive, true, 'a shot must leave gentle muzzle smoke');
  assert.equal(result.miss.anim, 'gun', 'a miss still recoils');
  assert.equal(result.miss.smoke, 12, 'a shot past range must not add impact smoke');
});

T('firing lights the barrel and the surrounding scene', async () => {
  await loadGame();
  await page.evaluate(() => {
    localStorage.setItem('voxelequip.items', JSON.stringify([
      {
        id: 'pistol', name: 'Pistol',
        microVoxels: [{ x: 3, y: 3, z: 4, color: [70, 70, 75] }],
        grip: { x: 3, y: 3, z: 4 }, yaw: 90,
        stats: { damage: 20, reach: 3, cooldown: 0.2 },
        weapon: { kind: 'ranged', hands: 'one', muzzle: { x: 3, y: 3, z: 5 }, anim: 'gun', recoil: 0.08 },
      },
    ]));
  });
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);
  const out = await page.evaluate(() => {
    const g = window.__voxelgame;
    g.stats.equip('primary', 'pistol');
    g._updateHud();
    document.pointerLockElement = g.webgl.domElement;
    g.renderer.camera.lookAt(5, 6, 5);
    const hasPointLight = !!g.hand._flashLight;
    const hasFlashWorld = typeof g.hand.flashWorld === 'function';
    const uniforms = () => {
      const m = g.renderer.material.uniforms;
      return { intensity: m.uFlashIntensity.value, pos: m.uFlashPos.value.toArray() };
    };
    const before = uniforms();
    g._attackCooldown = 0;
    g._attack();
    g.hand.update(1 / 60);
    g._updateFlashLight();
    const during = uniforms();
    const pointLight = g.hand._flashLight?.intensity ?? 0;
    const flash = g.hand.flashWorld(new g.hand.THREE.Vector3());
    const flashDist = flash ? flash.pos.distanceTo(g.renderer.camera.position) : null;
    g.hand.update(0.2); // past the 0.08 s flash
    g._updateFlashLight();
    const after = uniforms();
    document.pointerLockElement = null;
    return { hasPointLight, hasFlashWorld, before, during, after, pointLight, flashDist };
  });
  assert.equal(out.hasPointLight, true, 'a muzzle flash PointLight must ride the held weapon');
  assert.equal(out.hasFlashWorld, true, 'PlayerHand must expose flashWorld()');
  assert.equal(out.before.intensity, 0, 'the scene flash light starts off');
  assert.ok(out.during.intensity > 0, `firing must light the scene (uniform ${out.during.intensity})`);
  assert.equal(out.pointLight > 0, true, 'the PointLight switches on while firing');
  assert.ok(out.flashDist !== null && out.flashDist < 2, `the flash must sit at the muzzle (${out.flashDist} m from camera)`);
  assert.equal(out.after.intensity, 0, 'the scene light must switch off once the flash dies');
});

T('a long-range weapon can hit far past melee reach', async () => {
  await loadGame();
  await page.evaluate(() => {
    localStorage.setItem('voxelequip.items', JSON.stringify([
      {
        id: 'sniper', name: 'Sniper',
        microVoxels: [{ x: 3, y: 3, z: 4, color: [30, 40, 60] }],
        grip: { x: 3, y: 3, z: 4 }, yaw: 0,
        stats: { damage: 80, reach: 1000, cooldown: 1.2 }, // 1000 m = 2000 cells
        weapon: { kind: 'ranged', hands: 'one', muzzle: { x: 3, y: 3, z: 5 }, anim: 'gun', recoil: 0.15, spread: 0 }, // perfectly accurate — this tests reach, not spread
      },
    ]));
  });
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);

  const result = await page.evaluate(() => {
    const g = window.__voxelgame;
    const T = g.hand.THREE;
    g.stats.equip('primary', 'sniper');
    g._updateHud();
    const { renderer } = g;
    const smokeCount = () => g.smoke._mesh.filter((p) => p.alive).length;

    // A wall 60 m away (120 cells) — far beyond any melee reach.
    g.world.clear();
    g.renderer.clearChunks();
    g.world.place('grass', 'big', 0, 0, 120);
    g.renderer.loadWorldBounds();
    document.pointerLockElement = g.webgl.domElement;
    renderer.camera.position.set(0.25, 2.5, 0);
    renderer.camera.lookAt(0.5, 0.5, 60.5); // centre of the wall 60 m away
    g._attackCooldown = 0;
    g._attack();
    const hit = { smoke: smokeCount(), flash: g.hand._heldFlash.visible, anim: g.hand.right.anim?.name };

    document.pointerLockElement = null;
    return { hit };
  });
  assert.equal(result.hit.smoke, 12, 'a 1000 m weapon must hit a wall 60 m away');
  assert.equal(result.hit.flash, true, 'the long-range shot still flashes at the muzzle');
  assert.equal(result.hit.anim, 'gun');
  assert.equal(result.hit.flash, true, 'the long-range shot still flashes at the muzzle');
  assert.equal(result.hit.anim, 'gun');
});

T('ranged weapons scatter shots away from the exact crosshair', async () => {
  await loadGame();
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);
  const out = await page.evaluate(() => {
    const g = window.__voxelgame;
    const cam = g.renderer.camera;
    cam.rotation.set(0, 0, 0, 'YXZ'); // look straight ahead (-Z)
    const base = cam.getWorldDirection(new g.hand.THREE.Vector3());
    const baseArr = base.toArray();
    const gun = { kind: 'ranged', spread: 0.2 }; // a wide cone for the test
    const melee = { kind: 'melee', spread: 0 };
    let maxDev = 0;
    let diverged = false;
    for (let i = 0; i < 60; i++) {
      const d = g._aimDir(gun);
      const ang = Math.acos(Math.max(-1, Math.min(1, d.dot(base))));
      maxDev = Math.max(maxDev, ang);
      if (ang > 0.001) diverged = true;
    }
    let meleeDev = 0;
    for (let i = 0; i < 10; i++) {
      const d = g._aimDir(melee);
      meleeDev = Math.max(meleeDev, Math.abs(d.dot(base) - 1));
    }
    return { baseArr, diverged, maxDev, meleeDev };
  });
  assert.equal(out.diverged, true, 'a spread weapon must scatter shots off the crosshair');
  assert.ok(out.maxDev > 0.1, `spread shots must deviate by a meaningful angle (max ${out.maxDev} rad)`);
  assert.ok(out.meleeDev < 1e-6, 'a zero-spread weapon aims exactly at the crosshair');
});

T('the crosshair opens with weapon spread and blooms with each shot', async () => {
  await loadGame();
  await page.evaluate(() => {
    localStorage.setItem('voxelequip.items', JSON.stringify([
      {
        id: 'spray', name: 'Spray',
        microVoxels: [{ x: 3, y: 3, z: 4, color: [70, 70, 75] }],
        grip: { x: 3, y: 3, z: 4 }, yaw: 0,
        stats: { damage: 10, reach: 20, cooldown: 0.1 },
        weapon: { kind: 'ranged', hands: 'one', spread: 0.02, anim: 'gun', recoil: 0.05 },
      },
    ]));
  });
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);
  const out = await page.evaluate(() => {
    const g = window.__voxelgame;
    const cross = document.querySelector('#crosshair');
    const spreadPx = () => {
      const v = getComputedStyle(cross).getPropertyValue('--spread').trim();
      return v ? Number(v.replace('px', '')) : 0;
    };
    // Fists/melee: no spread, crosshair tight.
    g._updateCrosshair();
    const fistsPx = spreadPx();

    // A spread weapon opens the reticle to its base spread.
    g.stats.equip('primary', 'spray');
    g._updateHud();
    g._updateCrosshair();
    const basePx = spreadPx();

    // Rapid fire: each shot stacks bloom, opening the crosshair further.
    document.pointerLockElement = g.webgl.domElement;
    g.renderer.camera.rotation.set(0, 0, 0, 'YXZ');
    g._attackCooldown = 0;
    g._attack();
    const bloomAfterOne = g._bloom;
    g._updateCrosshair();
    const oneShotPx = spreadPx();
    for (let i = 0; i < 2; i++) {
      g._attackCooldown = 0;
      g._attack();
    }
    const bloomAfterThree = g._bloom;
    g._updateCrosshair();
    const threeShotPx = spreadPx();

    // Waiting past full recovery regenerates back to the base spread.
    g._bloom = 0.01;
    for (let i = 0; i < 120; i++) g._frame(1 / 60); // ~2 s of recovery
    const recovered = g._bloom;
    g._updateCrosshair();
    const recoveredPx = spreadPx();

    document.pointerLockElement = null;
    return { fistsPx, basePx, bloomAfterOne, oneShotPx, bloomAfterThree, threeShotPx, recovered, recoveredPx };
  });
  assert.equal(out.fistsPx, 0, 'fists/melee keep the crosshair tight');
  assert.equal(out.basePx, 6, 'the crosshair reflects the weapon base spread (0.02 rad)');
  assert.ok(out.oneShotPx > out.basePx, 'a shot must open the crosshair');
  assert.ok(Math.abs(out.bloomAfterOne - 0.01) < 1e-9, `each shot adds one bloom kick (${out.bloomAfterOne})`);
  assert.ok(Math.abs(out.bloomAfterThree - 0.03) < 1e-9, `rapid shots stack the bloom (${out.bloomAfterThree})`);
  assert.ok(out.threeShotPx > out.oneShotPx, 'more shots open the crosshair further');
  assert.equal(out.recovered, 0, 'waiting long enough fully regenerates the spread');
  assert.equal(out.recoveredPx, out.basePx, 'after recovery the crosshair returns to its base spread');
});

T('a magazine gun fires, empties, and auto-reloads from carried ammo', async () => {
  await loadGame();
  await page.evaluate(() => {
    localStorage.setItem('voxelequip.items', JSON.stringify([
      {
        id: 'pistol', name: 'Pistol',
        microVoxels: [{ x: 3, y: 3, z: 4, color: [70, 70, 75] }],
        grip: { x: 3, y: 3, z: 4 }, yaw: 90,
        stats: { damage: 20, reach: 3, cooldown: 0.2 },
        weapon: { kind: 'ranged', hands: 'one', muzzle: { x: 3, y: 3, z: 5 }, anim: 'gun', recoil: 0.08, magazine: 3, ammo: 'pistol' },
      },
    ]));
  });
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);

  // One-handed weapon → the left hand stays lowered. The HUD shows the full mag
  // (3) against the carried pistol ammo (granted here — fresh players start at 0).
  const equipped = await page.evaluate(() => {
    const g = window.__voxelgame;
    g.stats.equip('primary', 'pistol');
    g.stats.ammo.pistol = 30;
    g._updateHud();
    return {
      leftVisible: g.hand.left.group.visible,
      ammoHidden: document.querySelector('#ammo').classList.contains('hidden'),
      ammo: document.querySelector('#ammo').textContent,
      carried: g.stats.ammo.pistol,
    };
  });
  assert.equal(equipped.leftVisible, false, 'one-handed weapon must lower the left hand');
  assert.equal(equipped.ammoHidden, false, 'ammo HUD must show for a magazine gun');
  assert.equal(equipped.carried, 30, 'player starts carrying pistol ammo');
  assert.equal(equipped.ammo, '3/30', 'HUD must show mag / carried');

  // Fire all three rounds → empty magazine → auto-reload with hands down.
  const emptied = await page.evaluate(() => {
    const g = window.__voxelgame;
    document.pointerLockElement = g.webgl.domElement;
    g.renderer.camera.lookAt(5, 6, 5);
    for (let i = 0; i < 3; i++) {
      g._attackCooldown = 0;
      g._attack();
    }
    document.pointerLockElement = null;
    const ammo = g._ammo.get('pistol');
    return {
      current: ammo?.current,
      reloading: g._reloading,
      handsDown: !!g.hand._reload,
      hud: document.querySelector('#ammo').textContent,
    };
  });
  assert.equal(emptied.current, 0, 'three shots must empty the magazine');
  assert.equal(emptied.reloading, true, 'an empty magazine must auto-reload');
  assert.equal(emptied.handsDown, true, 'hands must dip down to reload');
  assert.equal(emptied.hud, '0/30', 'HUD must show 0 in the mag, carried intact');

  // Wait for the reload to finish → a full mag is pulled from carried ammo.
  // Drive simulated time instead of wall-clock waiting: the reload timer
  // counts down by dt per frame (clamped at 0.1 s), so under slow swiftshader
  // frames a 1.4 s reload can take arbitrarily long in real time.
  await page.evaluate(() => {
    const g = window.__voxelgame;
    for (let i = 0; i < 240 && g._reloading; i++) g._frame(1 / 60);
  });
  const ready = await page.evaluate(() => {
    const g = window.__voxelgame;
    const ammo = g._ammo.get('pistol');
    return {
      current: ammo?.current,
      reloading: g._reloading,
      handsUp: Math.abs(g.hand.group.position.y) < 0.01,
      carried: g.stats.ammo.pistol,
      hud: document.querySelector('#ammo').textContent,
    };
  });
  assert.equal(ready.current, 3, 'reload must refill the magazine');
  assert.equal(ready.reloading, false, 'reload must finish');
  assert.equal(ready.handsUp, true, 'hands must come back up after reload');
  assert.equal(ready.carried, 27, 'reload must spend carried ammo (30 - 3)');
  assert.equal(ready.hud, '3/27');

  // Unequipping (fists) brings both hands back; the ammo counter stays and
  // shows infinite ammo.
  const fists = await page.evaluate(() => {
    const g = window.__voxelgame;
    g.stats.unequip('primary');
    g._updateHud();
    return {
      leftVisible: g.hand.left.group.visible,
      ammoHidden: document.querySelector('#ammo').classList.contains('hidden'),
      ammo: document.querySelector('#ammo').textContent,
    };
  });
  assert.equal(fists.leftVisible, true, 'fists must show both hands');
  assert.equal(fists.ammoHidden, false, 'ammo counter must stay visible');
  assert.equal(fists.ammo, '∞/∞', 'fists/melee must show infinite ammo');
});

T('ammo counter is always visible: infinite for fists, durability for melee', async () => {
  await loadGame();
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);
  const out = await page.evaluate(() => {
    const g = window.__voxelgame;
    const ammo = document.querySelector('#ammo');
    const read = () => ({ hidden: ammo.classList.contains('hidden'), text: ammo.textContent });
    const fists = read();
    // A melee item (sword) is magazine-less but wears out — the counter
    // shows its remaining durability instead.
    g.stats.equip('primary', 'sword');
    g._updateHud();
    const melee = read();
    return { fists, melee };
  });
  assert.deepEqual(out.fists, { hidden: false, text: '∞/∞' }, 'fresh game (fists) shows infinite ammo');
  assert.deepEqual(out.melee, { hidden: false, text: '10/10' }, 'a breakable melee weapon shows durability');
});

T('an empty gun with no carried ammo cannot reload', async () => {
  await loadGame();
  await page.evaluate(() => {
    localStorage.setItem('voxelequip.items', JSON.stringify([
      {
        id: 'pistol', name: 'Pistol',
        microVoxels: [{ x: 3, y: 3, z: 4, color: [70, 70, 75] }],
        grip: { x: 3, y: 3, z: 4 }, yaw: 90,
        stats: { damage: 20, reach: 3, cooldown: 0.2 },
        weapon: { kind: 'ranged', hands: 'one', muzzle: { x: 3, y: 3, z: 5 }, anim: 'gun', recoil: 0.08, magazine: 2, ammo: 'pistol' },
      },
    ]));
  });
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);

  const out = await page.evaluate(() => {
    const g = window.__voxelgame;
    g.stats.equip('primary', 'pistol');
    g.stats.ammo.pistol = 0; // no carried ammo for this type
    g._updateHud();
    document.pointerLockElement = g.webgl.domElement;
    g.renderer.camera.lookAt(5, 6, 5);
    // Fire the 2-round mag, then a third attack tries to reload.
    for (let i = 0; i < 2; i++) { g._attackCooldown = 0; g._attack(); }
    const before = { current: g._ammo.get('pistol').current, reloading: g._reloading, hud: document.querySelector('#ammo').textContent };
    g._attackCooldown = 0;
    g._attack();
    const after = { current: g._ammo.get('pistol').current, reloading: g._reloading, handsDown: !!g.hand._reload, hud: document.querySelector('#ammo').textContent };
    document.pointerLockElement = null;
    return { before, after };
  });
  assert.deepEqual(out.before, { current: 0, reloading: false, hud: '0/0' }, 'empty mag, no carried ammo');
  assert.equal(out.after.reloading, false, 'with no ammo to load there is no reload');
  assert.equal(out.after.handsDown, false, 'hands stay up (nothing to reload)');
  assert.equal(out.after.hud, '0/0');
});

T('R reloads the weapon in hand using the weapon reload time', async () => {
  await loadGame();
  await page.evaluate(() => {
    localStorage.setItem('voxelequip.items', JSON.stringify([
      {
        id: 'smg', name: 'SMG',
        microVoxels: [{ x: 3, y: 3, z: 4, color: [70, 70, 75] }],
        grip: { x: 3, y: 3, z: 4 }, yaw: 90,
        stats: { damage: 10, reach: 3, cooldown: 0.15 },
        weapon: { kind: 'ranged', hands: 'one', muzzle: { x: 3, y: 3, z: 5 }, anim: 'gun', recoil: 0.08, magazine: 4, ammo: 'pistol', reload: 0.5 },
      },
    ]));
  });
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);

  // Carry ammo, equip the gun, fire one round so the mag is not full.
  const fired = await page.evaluate(() => {
    const g = window.__voxelgame;
    g.stats.equip('primary', 'smg');
    g.stats.ammo.pistol = 20;
    g._updateHud();
    document.pointerLockElement = g.webgl.domElement;
    g.renderer.camera.lookAt(5, 6, 5);
    g._attackCooldown = 0;
    g._attack();
    document.pointerLockElement = null;
    return { current: g._ammo.get('smg').current };
  });
  assert.equal(fired.current, 3, 'one shot leaves 3 in the mag');

  // Press R → a reload starts, timed by the weapon's reload field (0.5 s).
  await page.keyboard.press('KeyR');
  await page.waitForFunction(() => window.__voxelgame._reloading, { timeout: 2000 });
  await page.evaluate(() => { const g = window.__voxelgame; g._frame(1 / 60); g._frame(1 / 60); });
  const started = await page.evaluate(() => {
    const g = window.__voxelgame;
    return { reloading: g._reloading, handsDown: !!g.hand._reload, timer: g._reloadTimer };
  });
  assert.equal(started.reloading, true, 'R must start a reload');
  assert.equal(started.handsDown, true, 'hands must dip to reload');
  // The timer started at the weapon's 0.5 s and is counting down; a default
  // 1.4 s reload would still be above 1 s here.
  assert.ok(started.timer > 0 && started.timer < 0.5, `the 0.5 s weapon reload must be used (got ${started.timer})`);

  // It finishes after ~0.5 s and pulls a full mag from carried ammo — drive
  // simulated time (wall-clock waits flake when swiftshader frames are slow).
  await page.evaluate(() => {
    const g = window.__voxelgame;
    for (let i = 0; i < 60 && g._reloading; i++) g._frame(1 / 60);
  });
  const done = await page.evaluate(() => {
    const g = window.__voxelgame;
    return { current: g._ammo.get('smg').current, reloading: g._reloading, carried: g.stats.ammo.pistol };
  });
  assert.equal(done.reloading, false, 'reload must finish after the weapon time');
  assert.equal(done.current, 4, 'reload must refill the magazine');
  assert.equal(done.carried, 19, 'reload tops the mag up with 1 round (20 - 1)');
});

// --- mobs (Doom-style sprites + navmesh chasers) ---

// Same floor as above plus one imp spawn point sitting on it.
const MOB_MAP = JSON.stringify({
  format: 'voxelmap',
  version: 1,
  cellSize: 0.5,
  spawn: [2, 4, 2],
  blocks: FLOOR,
  items: [],
  mobs: [{ type: 'imp', x: 3, y: 2, z: 3 }],
});

async function loadMobGame() {
  await page.addInitScript(({ map, items }) => {
    localStorage.setItem('voxelmap.save', map);
    localStorage.setItem('voxelitem.items', items);
  }, { map: MOB_MAP, items: ITEMS });
  await loadGame();
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(300);
}

T('mobs spawn from editor spawn points and render as billboards', async () => {
  await loadMobGame();
  const out = await page.evaluate(() => {
    const g = window.__voxelgame;
    const m = g.mobs.mobs[0];
    return {
      count: g.mobs.mobs.length,
      sprites: g.mobs.renderer.sprites.size,
      valid: !!m && m.valid,
      pos: m ? [m.pos.x, m.pos.y, m.pos.z] : null,
      state: m ? m.state : null,
      kills: g.mobs.kills,
    };
  });
  assert.equal(out.count, 1, 'one mob from the editor spawn point');
  assert.equal(out.sprites, 1, 'one billboard sprite per mob');
  assert.equal(out.valid, true);
  assert.deepEqual(out.pos, [1.75, 1.0, 1.75], 'mob snaps onto the walkable floor');
  assert.equal(out.kills, 0);
});

T('mobs aggro, chase, attack and die to the player', async () => {
  await loadMobGame();
  const out = await page.evaluate(() => {
    const g = window.__voxelgame;
    const mob = g.mobs.mobs[0];
    const startHealth = g.stats.health;
    // Player 3 m away in line of sight (mob at -z from the camera).
    const player = { x: 1.75, y: 1.0, z: 4.75 };
    const d0 = Math.hypot(player.x - mob.pos.x, player.z - mob.pos.z);
    for (let i = 0; i < 40; i++) mob.update(0.1, player);
    const d1 = Math.hypot(player.x - mob.pos.x, player.z - mob.pos.z);
    const aggro = mob.aggro;

    // Step in front of the mob (0.6 m north) and fight it with fists. Aim at
    // the mob's chest rather than dead-ahead so the punch ray always passes
    // through its AABB — mobs roll a random height, and a short one can duck
    // under a perfectly horizontal eye-level ray.
    const mp = mob.pos;
    g.walk.position.set(mp.x, 1.0, mp.z + 0.6);
    g.walk.camera.position.set(mp.x, 2.62, mp.z + 0.6);
    g.walk.camera.lookAt(mp.x, 1.2, mp.z);
    const healthBefore = g.stats.health;
    const fightPos = { x: mp.x, y: 1.0, z: mp.z + 0.6 };
    for (let i = 0; i < 60; i++) {
      g._attackCooldown = 0;
      g._attack();
      g.mobs.update(0.05, fightPos);
    }
    return {
      aggro,
      d0,
      d1,
      kills: g.mobs.kills,
      alive: g.mobs.mobs.length,
      dead: mob.dead,
      startHealth,
      health: g.stats.health,
    };
  });
  assert.equal(out.aggro, true, 'mob must aggro on sight');
  assert.ok(out.d1 < out.d0 - 0.1, `mob must chase the player (${out.d0} -> ${out.d1})`);
  assert.equal(out.kills, 1, 'player must kill the mob');
  assert.equal(out.alive, 0, 'the dead mob is removed from the manager');
  assert.equal(out.dead, true);
  assert.ok(out.health < out.startHealth, 'the mob must have hurt the player');
});

T('a melee weapon wears out on mobs and breaks — wall hits cost nothing', async () => {
  await loadMobGame();
  await page.evaluate(() => {
    localStorage.setItem('voxelequip.items', JSON.stringify([
      {
        id: 'bat', name: 'Bat',
        microVoxels: [{ x: 3, y: 3, z: 4, color: [120, 90, 60] }],
        grip: { x: 3, y: 3, z: 4 }, yaw: 0,
        // Damage 1 keeps the imp alive through both swings; durability 2
        // means the second landed hit snaps the bat.
        stats: { damage: 1, reach: 3, cooldown: 0.2, durability: 2 },
        weapon: { kind: 'melee', hands: 'one', anim: 'punch' },
      },
    ]));
  });
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(300);

  const out = await page.evaluate(() => {
    const g = window.__voxelgame;
    const mob = g.mobs.mobs[0];
    g.stats.equip('primary', 'bat');
    g._updateHud();
    document.pointerLockElement = g.webgl.domElement;
    const hud = () => document.querySelector('#ammo').textContent;

    // Beating on the floor costs nothing — degradation is flesh-only.
    g.walk.position.set(1.75, 1.0, 4.75);
    g.walk.camera.position.set(1.75, 2.6, 4.75);
    g.walk.camera.lookAt(1.75, 0, 4.75);
    g._attackCooldown = 0;
    g._attack();
    const wall = { wear: g.stats.wear.primary, hud: hud() };

    // Two landed hits on the mob: the first wears the bat, the second breaks
    // it (aim at the chest — see the fists fight above).
    const mp = mob.pos;
    g.walk.position.set(mp.x, 1.0, mp.z + 0.6);
    g.walk.camera.position.set(mp.x, 2.62, mp.z + 0.6);
    g.walk.camera.lookAt(mp.x, 1.2, mp.z);
    g._attackCooldown = 0;
    g._attack();
    const afterOne = { wear: g.stats.wear.primary, item: g.stats.equipment.primary, hud: hud() };
    g._attackCooldown = 0;
    g._attack();
    const afterTwo = {
      item: g.stats.equipment.primary,
      hud: hud(),
      brokeCard: document.querySelector('#qtoasts .qt.q-broke')?.textContent ?? null,
    };
    document.pointerLockElement = null;
    return { wall, afterOne, afterTwo, mobAlive: !mob.dead };
  });
  assert.deepEqual(out.wall, { wear: 0, hud: '2/2' }, 'hitting the world must not wear the weapon');
  assert.deepEqual(out.afterOne, { wear: 1, item: 'bat', hud: '1/2' }, 'a landed hit costs one durability');
  assert.equal(out.afterTwo.item, null, 'the bat breaks and the slot empties');
  assert.equal(out.afterTwo.hud, '∞/∞', 'back to fists after the break');
  assert.equal(out.afterTwo.brokeCard, 'BrokenBat', 'the break announces as a card');
  assert.equal(out.mobAlive, true, 'the 1-damage swings must not have killed the imp');
});

T('gun shots stop and knock a mob back', async () => {
  await loadMobGame();
  await page.evaluate(() => {
    localStorage.setItem('voxelequip.items', JSON.stringify([
      {
        id: 'pistol', name: 'Pistol',
        microVoxels: [{ x: 3, y: 3, z: 4, color: [70, 70, 75] }],
        grip: { x: 3, y: 3, z: 4 }, yaw: 0,
        stats: { damage: 20, reach: 6, cooldown: 0.3 },
        weapon: { kind: 'ranged', hands: 'one', muzzle: { x: 3, y: 3, z: 5 }, anim: 'gun', recoil: 0.1, spread: 0 },
      },
    ]));
  });
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);

  const out = await page.evaluate(() => {
    const g = window.__voxelgame;
    g.stats.equip('primary', 'pistol');
    g._updateHud();
    const mob = g.mobs.mobs[0];
    const mp = mob.pos;
    // Player east of the mob, shooting west at it — the bullet shoves it -x.
    g.renderer.camera.position.set(mp.x + 2, 1.6, mp.z);
    g.renderer.camera.lookAt(mp.x, 1.0, mp.z);
    g._attackCooldown = 0;
    const before = mob.pos.x;
    g._attack();
    const staggered = mob.staggerTimer > 0;
    const knocked = mob.knock.x < 0;
    g.mobs.update(0.1, g.walk.position); // the stagger slides the mob back
    const after = mob.pos.x;
    return { staggered, knocked, before, after, alive: !mob.dead, health: mob.health };
  });
  assert.equal(out.staggered, true, 'a gun shot must stagger the mob');
  assert.equal(out.knocked, true, 'a powerful gun must knock the mob back along the shot');
  assert.ok(out.after < out.before - 0.01, `the mob must be shoved backward (${out.before} -> ${out.after})`);
  assert.equal(out.alive, true, 'a 20 dmg pistol must not kill the 30 hp imp');
});

T('hitting a mob splatters blood in front of its billboard', async () => {
  await loadMobGame();
  await page.evaluate(() => {
    localStorage.setItem('voxelequip.items', JSON.stringify([
      {
        id: 'pistol', name: 'Pistol',
        microVoxels: [{ x: 3, y: 3, z: 4, color: [70, 70, 75] }],
        grip: { x: 3, y: 3, z: 4 }, yaw: 0,
        stats: { damage: 10, reach: 6, cooldown: 0.3 },
        weapon: { kind: 'ranged', hands: 'one', muzzle: { x: 3, y: 3, z: 5 }, anim: 'gun', recoil: 0.1, spread: 0 },
      },
    ]));
  });
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);

  const out = await page.evaluate(() => {
    const g = window.__voxelgame;
    const T = g.hand.THREE;
    g.stats.equip('primary', 'pistol');
    g._updateHud();
    const mob = g.mobs.mobs[0];
    const mp = mob.pos;
    // Player east of the mob (camera side = +x), shooting west at it.
    g.renderer.camera.position.set(mp.x + 2, 1.6, mp.z);
    g.renderer.camera.lookAt(mp.x, 1.0, mp.z);
    const smokeBefore = g.smoke._mesh.filter((p) => p.alive).length;
    g._attackCooldown = 0;
    g._attack();
    const drops = g.blood._mesh.filter((p) => p.alive);
    const smokeAfter = g.smoke._mesh.filter((p) => p.alive).length;
    // Blood must sit on the camera side of the mob centre (in front of the
    // camera-facing sprite), not behind or dead-centre under it.
    const v = new T.Vector3();
    let inFront = 0;
    for (const d of drops) {
      v.set(d.mesh.position.x - mp.x, 0, d.mesh.position.z - mp.z);
      if (v.x > 0) inFront++; // camera is at +x, so x > mob centre = in front
    }
    return { drops: drops.length, smokeBefore, smokeAfter, inFront };
  });
  assert.ok(out.drops >= 10, `a mob hit must splatter blood (${out.drops} droplets)`);
  assert.equal(out.smokeAfter, out.smokeBefore, 'a mob hit must not puff gray smoke');
  assert.ok(out.inFront > out.drops / 2, `most blood must spawn in front of the mob (${out.inFront}/${out.drops})`);
});

T('being hit flashes the red vignette + screen blur', async () => {
  await loadGame();
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);

  const flashed = await page.evaluate(() => {
    const g = window.__voxelgame;
    const healthBefore = g.stats.health;
    g._mobHitsPlayer(15, { x: 0, y: 1, z: 0 });
    return {
      damaged: g.stats.health < healthBefore,
      hurtClass: document.body.classList.contains('hurt'),
      vignette: getComputedStyle(document.querySelector('#hit-feedback')).animationName,
      blur: getComputedStyle(document.querySelector('#game canvas')).animationName,
    };
  });
  assert.equal(flashed.damaged, true, 'the hit must damage the player');
  assert.equal(flashed.hurtClass, true, 'a hit must set the hurt class');
  assert.equal(flashed.vignette, 'hit-vignette', 'the red vignette animation must play');
  assert.equal(flashed.blur, 'hit-blur', 'the screen blur animation must play');

  // The flash decays once the vignette animation completes.
  await page.waitForFunction(() => !document.body.classList.contains('hurt'), null, { timeout: 3000 });
  const cleared = await page.evaluate(() => ({
    hurtClass: document.body.classList.contains('hurt'),
    feedbackOpacity: Number(getComputedStyle(document.querySelector('#hit-feedback')).opacity),
  }));
  assert.equal(cleared.hurtClass, false, 'the hurt class must clear after the flash');
  assert.equal(cleared.feedbackOpacity, 0, 'the vignette element returns to invisible');
});

T('hit feedback grows stronger as health drops', async () => {
  await loadGame();
  await page.evaluate(() => window.__syncNewGame());
  await page.waitForTimeout(150);
  const out = await page.evaluate(() => {
    const g = window.__voxelgame;
    const vars = () => {
      const s = document.body.style;
      return {
        int: parseFloat(s.getPropertyValue('--hit-int')),
        blur: parseFloat(s.getPropertyValue('--hit-blur')),
        stop: parseFloat(s.getPropertyValue('--hit-stop')),
      };
    };
    g.stats.health = 100;
    g._hitFlash();
    const full = vars();
    g.stats.health = 25;
    g._hitFlash();
    const low = vars();
    g.stats.health = 0;
    g._hitFlash();
    const empty = vars();
    return { full, low, empty };
  });
  assert.ok(out.full.int < out.low.int && out.low.int < out.empty.int,
    `vignette intensity must rise as HP falls (${out.full.int} -> ${out.low.int} -> ${out.empty.int})`);
  assert.ok(out.full.blur < out.low.blur && out.low.blur < out.empty.blur,
    `blur must strengthen as HP falls (${out.full.blur} -> ${out.low.blur} -> ${out.empty.blur})`);
  assert.ok(out.full.stop > out.low.stop && out.low.stop > out.empty.stop,
    `vignette must cover more of the screen as HP falls (${out.full.stop}% -> ${out.low.stop}% -> ${out.empty.stop}%)`);
});

// --- mobile touch controls (emulated coarse-pointer device) ---

let mobile;

async function loadMobileGame() {
  if (!mobile || mobile.isClosed()) {
    mobile = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    await mobile.addInitScript(installSyncNewGame);
  }
  await mobile.addInitScript(({ map, items }) => {
    localStorage.setItem('voxelmap.save', map);
    localStorage.setItem('voxelitem.items', items);
  }, { map: MAP, items: ITEMS });
  await mobile.goto(`http://localhost:${srv.port}/game.html`);
  await mobile.waitForFunction(() => !!window.__voxelgame, { timeout: 15000 });
  await mobile.waitForTimeout(300);
}

T('mobile: coarse pointer enables the touch layer and controls', async () => {
  await loadMobileGame();
  const info = await mobile.evaluate(() => ({
    coarse: matchMedia('(pointer: coarse)').matches,
    fine: matchMedia('(pointer: fine)').matches,
    isTouch: window.__voxelgame.isTouch,
    hasTouchControls: !!window.__voxelgame.touch,
    layerExists: !!document.getElementById('touch-layer'),
  }));
  assert.equal(info.coarse, true);
  assert.equal(info.fine, false);
  assert.equal(info.isTouch, true, 'must detect the touch device');
  assert.equal(info.hasTouchControls, true, 'TouchControls must be wired');

  const inMenu = await mobile.evaluate(() =>
    document.getElementById('touch-layer').classList.contains('hidden'));
  assert.equal(inMenu, true, 'touch layer hidden in the menu');

  await mobile.evaluate(() => window.__syncNewGame());
  await mobile.waitForTimeout(150);
  const inPlay = await mobile.evaluate(() => ({
    hidden: document.getElementById('touch-layer').classList.contains('hidden'),
    mode: window.__voxelgame.mode,
    buttons: ['#btn-attack', '#btn-pickup', '#btn-crouch']
      .map((s) => !!document.querySelector(s)),
    dropped: ['#btn-pause', '#btn-reload', '#btn-inject', '#btn-sprint']
      .map((s) => !document.querySelector(s)),
    slots: document.querySelectorAll('#slots-mobile .slot-btn').length,
  }));
  assert.equal(inPlay.mode, 'playing');
  assert.equal(inPlay.hidden, false, 'touch layer visible while playing');
  assert.equal(inPlay.buttons.every(Boolean), true, 'all action buttons present');
  assert.equal(inPlay.dropped.every(Boolean), true, 'reload/inject/sprint/pause buttons removed');
  assert.equal(inPlay.slots, 4, 'four mobile slot buttons');
});

T('mobile: joystick moves the player and look drag rotates the camera', async () => {
  await loadMobileGame();
  await mobile.evaluate(() => window.__syncNewGame());
  await mobile.waitForTimeout(150);
  const moved = await mobile.evaluate(() => {
    const g = window.__voxelgame;
    const layer = document.getElementById('touch-layer');
    const st = (target, type, x, y, id) => target.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
    // Stand on the floor facing -z, clear any held keys.
    g.walk.position.set(3.5, 1.0, 3.5);
    g.walk.velocity.set(0, 0, 0);
    g.walk.yaw = 0;
    g.walk.keys.clear();
    // Joystick on the left, drag straight up = forward.
    st(layer, 'pointerdown', 50, 600, 1);
    st(layer, 'pointermove', 50, 530, 1);
    const startZ = g.walk.position.z;
    for (let i = 0; i < 20; i++) g.walk.update(1 / 60);
    const forwardZ = g.walk.position.z;
    const keyed = g.walk.keys.has('KeyW');
    // Look drag on the right side of the screen while the joystick is held.
    st(layer, 'pointerdown', 300, 400, 2);
    const yaw0 = g.walk.yaw;
    st(layer, 'pointermove', 340, 400, 2);
    const yaw1 = g.walk.yaw;
    st(layer, 'pointerup', 340, 400, 2);
    st(layer, 'pointerup', 50, 530, 1);
    return { keyed, forwardZ, startZ, yaw0, yaw1, keys: [...g.walk.keys] };
  });
  assert.equal(moved.keyed, true, 'joystick up must press W');
  assert.ok(moved.forwardZ < moved.startZ - 0.05,
    `joystick must move the player forward (${moved.startZ} -> ${moved.forwardZ})`);
  assert.ok(Math.abs(moved.yaw1 - moved.yaw0) > 0.001,
    `look drag must rotate the camera (${moved.yaw0} -> ${moved.yaw1})`);
  assert.equal(moved.keys.length, 0, 'releasing clears the movement keys');
});

T('mobile: attack holds to fire, slots select and crouch toggles', async () => {
  await loadMobileGame();
  await mobile.evaluate(() => window.__syncNewGame());
  await mobile.waitForTimeout(150);
  const out = await mobile.evaluate(() => {
    const g = window.__voxelgame;
    const q = (s) => document.querySelector(s);
    const st = (target, type, id) => target.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', clientX: 0, clientY: 0, bubbles: true, cancelable: true,
    }));
    // Hold fire: auto-repeat inside _frame.
    st(q('#btn-attack'), 'pointerdown', 11);
    const holding = g.touch.attacking;
    g._attackCooldown = 0;
    g._frame(1 / 60);
    const fired = g._attackCooldown > 0;
    st(q('#btn-attack'), 'pointerup', 11);
    const released = !g.touch.attacking;
    // Slot 3 (index 2).
    const slot3 = q('#slots-mobile .slot-btn[data-index="2"]');
    st(slot3, 'pointerdown', 12);
    const activeSlot = g.stats.activeSlot;
    const activeClass = slot3.classList.contains('active');
    // Crouch toggle on/off.
    st(q('#btn-crouch'), 'pointerdown', 15);
    const crouchOn = g.walk.keys.has('KeyC');
    const crouchLit = q('#btn-crouch').classList.contains('on');
    st(q('#btn-crouch'), 'pointerdown', 16);
    const crouchOff = !g.walk.keys.has('KeyC');
    // Pickup button is wired (no target -> no-op without an aimed item).
    const pickupWired = g.touch.cb.pickup !== null;
    return { holding, fired, released, activeSlot, activeClass, crouchOn, crouchLit, crouchOff, pickupWired };
  });
  assert.equal(out.holding, true, 'fire button held');
  assert.equal(out.fired, true, 'holding fire must attack');
  assert.equal(out.released, true, 'releasing stops the attack');
  assert.equal(out.activeSlot, 2, 'tapping slot 3 must select it');
  assert.equal(out.activeClass, true, 'selected slot is highlighted');
  assert.equal(out.crouchOn, true, 'crouch toggles on');
  assert.equal(out.crouchLit, true, 'crouch button lights while active');
  assert.equal(out.crouchOff, true, 'crouch toggles off');
  assert.equal(out.pickupWired, true, 'pickup button is wired');
});

T('mobile: equipped items render icons in the mobile hotbar', async () => {
  await loadMobileGame();
  const out = await mobile.evaluate(() => {
    const g = window.__voxelgame;
    const btn = (i) => document.querySelector(`#slots-mobile .slot-btn[data-index="${i}"]`);
    const before = { canvas: !!btn(0).querySelector('canvas'), text: btn(0).textContent.trim() };
    g.stats.equip('primary', 'sword');
    g._updateHud();
    const after = {
      canvas: !!btn(0).querySelector('canvas'),
      active: btn(0).classList.contains('active'),
      emptyCanvas: !!btn(1).querySelector('canvas'),
      emptyText: btn(1).textContent.trim(),
    };
    return { before, after };
  });
  assert.deepEqual(out.before, { canvas: false, text: '1' }, 'empty mobile slot shows its number');
  assert.equal(out.after.canvas, true, 'equipped item must show an icon in the mobile hotbar');
  assert.equal(out.after.active, true, 'the selected mobile slot stays highlighted');
  assert.equal(out.after.emptyCanvas, false, 'empty mobile slot stays icon-free');
  assert.equal(out.after.emptyText, '2', 'empty mobile slot keeps its number');
});


