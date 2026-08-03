// game.e2e.test.js — browser smoke test for the playable game (game.html).
//
// Loads game.html, seeds the editor's localStorage keys the game reads, then
// checks: the main menu renders with 3 slots, New Game loads the editor world,
// the player can move, and save/load slots round-trip through localStorage.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GAME = `file://${join(ROOT, 'game.html')}`;

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

before(async () => {
  if (!available) return;
  browser = await globalThis.__pwChromium.launch({
    executablePath: chromiumExe,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
});

after(async () => {
  if (mobile) await mobile.close();
  if (browser) await browser.close();
});

const T = (name, fn) => test(name, { skip }, fn);

async function loadGame() {
  await page.goto(GAME);
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

T('save then load slots round-trips world + position', async () => {
  // Move somewhere, then save to slot 0.
  const saved = await page.evaluate(() => {
    const { walk } = window.__voxelgame;
    walk.position.set(3.5, 1.0, 1.5);
    walk.yaw = 0.7;
    window.__voxelgame.saveSlot(0);
    const raw = JSON.parse(localStorage.getItem('voxelgame.save.0'));
    return { pos: [raw.player.x, raw.player.y, raw.player.z], yaw: raw.player.yaw, hasBundle: !!raw.bundle, savedAt: !!raw.savedAt };
  });
  assert.deepEqual(saved.pos, [3.5, 1.0, 1.5]);
  assert.equal(saved.yaw, 0.7);
  assert.equal(saved.hasBundle, true, 'slot must snapshot the world bundle');
  assert.equal(saved.savedAt, true);

  // Overwrite the editor map, reload, then load slot 0: the saved world wins.
  await page.addInitScript(({ map }) => localStorage.setItem('voxelmap.save', map), { map: JSON.stringify({ format: 'voxelmap', version: 1, cellSize: 0.5, spawn: null, blocks: [], items: [] }) });
  await loadGame();
  await page.evaluate(() => window.__voxelgame.loadSlot(0));
  await page.waitForTimeout(200);

  const loaded = await page.evaluate(() => {
    const { world, walk, mode } = window.__voxelgame;
    return {
      mode,
      count: world.count,
      pos: [walk.position.x, walk.position.y, walk.position.z],
      yaw: walk.yaw,
    };
  });
  assert.equal(loaded.mode, 'playing', 'loading a slot must enter play');
  assert.equal(loaded.count, 16, 'slot must restore the saved world, not the new map');
  assert.ok(Math.abs(loaded.pos[0] - 3.5) < 1e-6, `position x restored, got ${loaded.pos[0]}`);
  assert.ok(Math.abs(loaded.yaw - 0.7) < 1e-6, `yaw restored, got ${loaded.yaw}`);
});

T('HUD shows health, armor, equipment slots and fists by default', async () => {
  await loadGame();
  await page.evaluate(() => window.__voxelgame.newGame());
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
  assert.equal(hud.armor, 100);
  assert.equal(hud.healthText, '100');
  assert.equal(hud.armorText, '100');
  assert.equal(hud.slots, 4, 'HUD must render 4 equipment slots');
  assert.deepEqual(hud.slotLabels, ['—', '—', '—', '—']);
  assert.equal(hud.hand, 'Fists', 'empty hand must show fists');
  assert.equal(hud.activeSlot, 'primary');
});

T('equipment switching, injection use and attack work', async () => {
  await loadGame();
  await page.evaluate(() => window.__voxelgame.newGame());
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
  await page.evaluate(() => window.__voxelgame.newGame());
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
  await page.evaluate(() => {
    const g = window.__voxelgame;
    g.newGame();
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
  await page.evaluate(() => window.__voxelgame.newGame());
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
  await page.evaluate(() => window.__voxelgame.newGame());
  await page.waitForTimeout(150);

  // Aim at the pistol: highlight + prompt appear, then E picks it up.
  const result = await page.evaluate(() => {
    const g = window.__voxelgame;
    const { renderer } = g;
    renderer.camera.position.set(0.25, 1.25, 3.0);
    renderer.camera.lookAt(0.25, 1.25, 0.25);
    g._updatePickup();
    const pickup = document.querySelector('#pickup');
    const aimed = g._pickupTarget
      ? { id: g._pickupTarget.item.itemId, markerVisible: g._pickupMarker.visible }
      : null;
    const prompt = {
      visible: !pickup.classList.contains('hidden'),
      text: pickup.textContent.replace(/\s+/g, ' ').trim(),
    };

    g._pickup();
    const after = {
      primary: g.stats.equipment.primary,
      hand: document.querySelector('#hand').textContent,
      worldItems: (() => { let n = 0; g.world.forEachItem(() => n++); return n; })(),
      markerVisible: g._pickupMarker.visible,
    };
    return { aimed, prompt, after };
  });
  assert.deepEqual(result.aimed, { id: 'pistol', markerVisible: true }, 'aiming at the pistol must highlight it');
  assert.equal(result.prompt.visible, true, 'pickup prompt must be visible');
  assert.ok(result.prompt.text.includes('E') && result.prompt.text.includes('Pistol'), `prompt text: ${result.prompt.text}`);
  assert.equal(result.after.primary, 'pistol', 'E must put the pistol in an equipment slot');
  assert.equal(result.after.hand, 'Pistol', 'HUD hand must show the picked-up weapon name');
  assert.equal(result.after.worldItems, 0, 'the placed item must be removed from the world');

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
  await page.evaluate(() => window.__voxelgame.newGame());
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

    return {
      held: true,
      visible: held.visible,
      onRightPivot: held.parent === g.hand.right.pivot,
      gripInPivot: held.position.toArray(),
      gripAtPalm: gripWorld.distanceTo(palmWorld) < 0.01,
      forwardAligned: itemFwd.dot(camForward) > 0.9,
      swungRight: !!g.hand.right.anim,
    };
  });
  assert.equal(result.held, true, 'held item mesh must exist');
  assert.equal(result.visible, true, 'held item must be visible');
  assert.equal(result.onRightPivot, true, 'held item must attach to the right-hand pivot');
  assert.deepEqual(result.gripInPivot, [0, 0.06, 0], 'grip voxel must sit at the palm centre');
  assert.equal(result.gripAtPalm, true, 'grip voxel must coincide with the palm in world space');
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
  await page.evaluate(() => window.__voxelgame.newGame());
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

T('a long-range weapon can hit far past melee reach', async () => {
  await loadGame();
  await page.evaluate(() => {
    localStorage.setItem('voxelequip.items', JSON.stringify([
      {
        id: 'sniper', name: 'Sniper',
        microVoxels: [{ x: 3, y: 3, z: 4, color: [30, 40, 60] }],
        grip: { x: 3, y: 3, z: 4 }, yaw: 0,
        stats: { damage: 80, reach: 1000, cooldown: 1.2 }, // 1000 m = 2000 cells
        weapon: { kind: 'ranged', hands: 'one', muzzle: { x: 3, y: 3, z: 5 }, anim: 'gun', recoil: 0.15 },
      },
    ]));
  });
  await page.evaluate(() => window.__voxelgame.newGame());
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
  await page.evaluate(() => window.__voxelgame.newGame());
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
  assert.equal(equipped.ammo, '3 / 30', 'HUD must show mag / carried');

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
  assert.equal(emptied.hud, '0 / 30', 'HUD must show 0 in the mag, carried intact');

  // Wait for the reload to finish → a full mag is pulled from carried ammo.
  await page.waitForTimeout(1700);
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
  assert.equal(ready.hud, '3 / 27');

  // Unequipping (fists) brings both hands back.
  const fists = await page.evaluate(() => {
    const g = window.__voxelgame;
    g.stats.unequip('primary');
    g._updateHud();
    return { leftVisible: g.hand.left.group.visible, ammoHidden: document.querySelector('#ammo').classList.contains('hidden') };
  });
  assert.equal(fists.leftVisible, true, 'fists must show both hands');
  assert.equal(fists.ammoHidden, true, 'ammo HUD must hide for fists');
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
  await page.evaluate(() => window.__voxelgame.newGame());
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
  assert.deepEqual(out.before, { current: 0, reloading: false, hud: '0 / 0' }, 'empty mag, no carried ammo');
  assert.equal(out.after.reloading, false, 'with no ammo to load there is no reload');
  assert.equal(out.after.handsDown, false, 'hands stay up (nothing to reload)');
  assert.equal(out.after.hud, '0 / 0');
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
  await page.evaluate(() => window.__voxelgame.newGame());
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
  await page.waitForTimeout(120);
  const started = await page.evaluate(() => {
    const g = window.__voxelgame;
    return { reloading: g._reloading, handsDown: !!g.hand._reload, timer: g._reloadTimer };
  });
  assert.equal(started.reloading, true, 'R must start a reload');
  assert.equal(started.handsDown, true, 'hands must dip to reload');
  // The timer started at the weapon's 0.5 s and is counting down (~0.38 left
  // after the wait); a default 1.4 s reload would still be near 1.3.
  assert.ok(started.timer > 0 && started.timer < 0.5, `the 0.5 s weapon reload must be used (got ${started.timer})`);

  // It finishes after ~0.5 s and pulls a full mag from carried ammo.
  await page.waitForTimeout(700);
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
  await page.evaluate(() => window.__voxelgame.newGame());
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

    // Step in front of the mob (0.6 m north, camera facing -z toward it) and
    // fight it with fists.
    const mp = mob.pos;
    g.walk.position.set(mp.x, 1.0, mp.z + 0.6);
    g.walk.camera.position.set(mp.x, 2.62, mp.z + 0.6);
    g.walk.camera.rotation.set(0, 0, 0, 'YXZ');
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

// --- mobile touch controls (emulated coarse-pointer device) ---

let mobile;

async function loadMobileGame() {
  if (!mobile || mobile.isClosed()) {
    mobile = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
  }
  await mobile.addInitScript(({ map, items }) => {
    localStorage.setItem('voxelmap.save', map);
    localStorage.setItem('voxelitem.items', items);
  }, { map: MAP, items: ITEMS });
  await mobile.goto(GAME);
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

  await mobile.evaluate(() => window.__voxelgame.newGame());
  await mobile.waitForTimeout(150);
  const inPlay = await mobile.evaluate(() => ({
    hidden: document.getElementById('touch-layer').classList.contains('hidden'),
    mode: window.__voxelgame.mode,
    buttons: ['#btn-attack', '#btn-reload', '#btn-pickup', '#btn-inject', '#btn-sprint', '#btn-crouch', '#btn-pause']
      .map((s) => !!document.querySelector(s)),
    slots: document.querySelectorAll('#slots-mobile .slot-btn').length,
  }));
  assert.equal(inPlay.mode, 'playing');
  assert.equal(inPlay.hidden, false, 'touch layer visible while playing');
  assert.equal(inPlay.buttons.every(Boolean), true, 'all action buttons present');
  assert.equal(inPlay.slots, 4, 'four mobile slot buttons');
});

T('mobile: joystick moves the player and look drag rotates the camera', async () => {
  await loadMobileGame();
  await mobile.evaluate(() => window.__voxelgame.newGame());
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

T('mobile: attack holds to fire, slots select, sprint/crouch toggle, pause works', async () => {
  await loadMobileGame();
  await mobile.evaluate(() => window.__voxelgame.newGame());
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
    // Sprint toggle on/off.
    st(q('#btn-sprint'), 'pointerdown', 13);
    const sprintOn = g.walk.keys.has('ShiftLeft');
    st(q('#btn-sprint'), 'pointerdown', 14);
    const sprintOff = !g.walk.keys.has('ShiftLeft');
    // Crouch toggle.
    st(q('#btn-crouch'), 'pointerdown', 15);
    const crouchOn = g.walk.keys.has('KeyC');
    // Pause.
    st(q('#btn-pause'), 'pointerdown', 16);
    const paused = g.mode === 'paused';
    return { holding, fired, released, activeSlot, activeClass, sprintOn, sprintOff, crouchOn, paused };
  });
  assert.equal(out.holding, true, 'fire button held');
  assert.equal(out.fired, true, 'holding fire must attack');
  assert.equal(out.released, true, 'releasing stops the attack');
  assert.equal(out.activeSlot, 2, 'tapping slot 3 must select it');
  assert.equal(out.activeClass, true, 'selected slot is highlighted');
  assert.equal(out.sprintOn, true, 'sprint toggles on');
  assert.equal(out.sprintOff, true, 'sprint toggles off');
  assert.equal(out.crouchOn, true, 'crouch toggles on');
  assert.equal(out.paused, true, 'pause button pauses the game');
});


