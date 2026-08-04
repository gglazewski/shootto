import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const cache = join(homedir(), '.cache', 'ms-playwright');
let exe = null;
for (const d of readdirSync(cache).filter((d) => d.startsWith('chromium-'))) {
  const p = join(cache, d, 'chrome-linux', 'chrome');
  if (existsSync(p)) { exe = p; break; }
}
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.addInitScript(() => {
  localStorage.setItem('voxelmap.save', JSON.stringify({ format: 'voxelmap', version: 1, cellSize: 0.5, spawn: [2, 4, 2], blocks: [], items: [] }));
  localStorage.setItem('voxelequip.items', JSON.stringify([
    { id: 'pistol', name: 'Pistol', microVoxels: [{ x: 3, y: 3, z: 4, color: [70, 70, 75] }], grip: { x: 3, y: 3, z: 4 }, yaw: 90,
      stats: { damage: 20, reach: 3, cooldown: 0.2 }, weapon: { kind: 'ranged', hands: 'one', muzzle: { x: 3, y: 3, z: 5 }, anim: 'gun', recoil: 0.08 } },
  ]));
});
await page.goto('file:///home/greg/Projects/voxelgame/game.html');
await page.waitForFunction(() => !!window.__voxelgame, { timeout: 15000 });
await page.evaluate(() => {
  const g = window.__voxelgame;
  g.newGame();
  // Sealed dark room with a wall ahead of the player.
  g.world.clear(); g.renderer.clearChunks();
  for (let x = 0; x < 8; x += 2) for (let z = 0; z < 8; z += 2) { g.world.place('grass', 'big', x, 0, z); g.world.place('grass', 'big', x, 12, z); }
  for (let y = 2; y <= 11; y += 2) {
    for (let z = 0; z < 8; z += 2) { g.world.place('grass', 'big', 0, y, z); g.world.place('grass', 'big', 6, y, z); }
    for (let x = 0; x < 8; x += 2) { g.world.place('grass', 'big', x, y, 0); g.world.place('grass', 'big', x, y, 6); }
  }
  // Interior wall a couple meters in front of spawn for something to light.
  g.renderer.loadWorldBounds();
  // Player stands in the room facing a wall.
  g.walk.position.set(1.5, 2.0, 4.0);
  g.walk.camera.position.set(1.5, 2.0 + 1.62, 4.0);
  g.walk.camera.lookAt(1.5, 2.0, 1.5);
  g.stats.equip('primary', 'pistol'); g._updateHud();
});
await page.waitForTimeout(400);

// Brightness of the screen center region.
const centerLum = (img) => {
  let sum = 0, n = 0;
  for (let y = 120; y < 480; y += 4) for (let x = 120; x < 680; x += 4) {
    const i = (y * 800 + x) * 4;
    sum += img.data[i] + img.data[i+1] + img.data[i+2]; n += 3;
  }
  return sum / n;
};

await page.screenshot({ path: '/tmp/opencode/dark.png' });
const before = await page.evaluate(() => {
  const g = window.__voxelgame;
  document.pointerLockElement = g.webgl.domElement;
  g._attackCooldown = 0;
  g._attack();
  g.hand.update(1/60);
  g._updateFlashLight();
  return { flash: g.renderer.material.uniforms.uFlashIntensity.value };
});
await page.waitForTimeout(30); // let the frame render with the flash
const duringImg = await page.screenshot({ path: '/tmp/opencode/during.png' });
await page.waitForTimeout(300);
const afterImg = await page.screenshot({ path: '/tmp/opencode/after.png' });
console.log('flash uniform during shot:', before.flash);
console.log('center lum dark:', centerLum(duringImg)); // note: 'during' png was taken at flash time
await page.waitForTimeout(100);
const duringLateImg = await page.screenshot({ path: '/tmp/opencode/during_late.png' });
console.log('center lum just-after-flash (flash still visible in frame?):', centerLum(duringLateImg));
console.log('center lum 300ms later:', centerLum(afterImg));
await browser.close();
