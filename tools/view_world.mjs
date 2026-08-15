// tools/view_world.mjs — headless screenshot tool: serves the editor, loads
// the live world (map/voxelbundle.json via the server API) and captures
// named camera shots into /tmp/opencode/.
//
// Usage: node tools/view_world.mjs            (uses built-in shot list)
//        node tools/view_world.mjs --list      (print current world bounds)
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

const OUT = '/tmp/opencode';
mkdirSync(OUT, { recursive: true });

const cache = join(homedir(), '.cache', 'ms-playwright');
let exe = null;
for (const d of readdirSync(cache).filter((d) => d.startsWith('chromium-'))) {
  const p = join(cache, d, 'chrome-linux', 'chrome');
  if (existsSync(p)) { exe = p; break; }
}
if (!exe) throw new Error('no chromium found in ~/.cache/ms-playwright');

const { server, port } = await startServer({ port: 0 });
console.log('server on port', port);

const browser = await chromium.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (msg) => { if (msg.type() === 'error') console.log('page error:', msg.text()); });
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForFunction(() => !!window.__voxelgame, { timeout: 30000 });
// hide editor UI chrome for clean shots
await page.addStyleTag({ content: '.toolbar, .toolring, #inventory, .notice, #toolbar, [class*=toolbar], [class*=tool-ring] { display: none !important; }' });
await page.waitForTimeout(1500);

const bounds = await page.evaluate(() => {
  const g = window.__voxelgame;
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9, n = 0;
  g.world.forEachVoxel((v) => {
    const [x, y, z] = v.anchor;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    n++;
  });
  return { n, minX, maxX, minY, maxY, minZ, maxZ, spawn: g.world.spawn, count: g.world.count };
});
console.log('world bounds (cells):', JSON.stringify(bounds));

async function shot(name, x, y, z, yawDeg, pitchDeg, fov = 70) {
  await page.evaluate(({ x, y, z, yaw, pitch, fov }) => {
    const g = window.__voxelgame;
    const cam = g.renderer.camera;
    cam.fov = fov; cam.updateProjectionMatrix();
    cam.position.set(x, y, z);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(pitch * Math.PI / 180, yaw * Math.PI / 180, 0);
    g.controls.yaw = yaw * Math.PI / 180;
    g.controls.pitch = pitch * Math.PI / 180;
    g.renderer.light.field?.moveTo?.(x, y, z);
  }, { x, y, z, yaw: yawDeg, pitch: pitchDeg, fov });
  await page.waitForTimeout(2600); // chunk streaming + light field settle
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log('shot:', name);
}

if (process.argv.includes('--list')) {
  await browser.close(); server.close(); process.exit(0);
}

// --- default shot list: overview + the commie block from several sides ---
// world meters = cells * 0.5. Building cluster ~ x:[-41,12] z:[-3,31].
await shot('overview', 60, 45, 75, -135, -28, 60);
await shot('overview_top', -5, 70, 12, 0, -89, 70);
await shot('blok_front', -14, 6, 45, 180, -4, 65);
await shot('blok_near', -28, 4, 30, 180, 0, 65);
await shot('blok_corner', 20, 8, 40, -160, -8, 65);
await shot('blok_back', -20, 6, -18, 0, -4, 65);
await shot('spawn_view', -2, 8.6, 5.5, 180, 0, 70);

await browser.close();
server.close();
console.log('done');
