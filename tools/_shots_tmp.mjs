// Temp interior shots of the new blok (deleted after review). Meters = cells * 0.5.
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
if (!exe) throw new Error('no chromium found');

const { server, port } = await startServer({ port: 0 });
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForFunction(() => !!window.__voxelgame, { timeout: 30000 });
await page.addStyleTag({ content: '.toolbar, .toolring, #inventory, .notice, #toolbar, [class*=toolbar], [class*=tool-ring] { display: none !important; }' });
await page.waitForTimeout(1500);

async function shot(name, x, y, z, yawDeg, pitchDeg, fov = 75) {
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
  await page.waitForTimeout(2600);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log('shot:', name);
}

// yaw: 0=-z, 90=-x, 180=+z, -90=+x
await shot('int_landing_south', -0.25, 3.1, 20.9, 180, -4);   // G landing: lift + stairs
await shot('int_landing_north', -0.25, 3.1, 24.4, 0, -4);     // G landing: entrance + apt doors
await shot('int_stairs', 0.25, 4.6, 24.4, 0, -6);             // from half-landing back north
await shot('int_living', -13.6, 6.1, 22.6, 0, -4);            // F1 living: meblo + TV + windows
await shot('int_living_back', -13.6, 6.1, 21.0, 180, -4);     // F1 living: wersalka side
await shot('int_kitchen', -11.2, 6.1, 27.9, 0, -6);           // F1 kitchen: kredens etc
await shot('int_bath', -12.6, 6.0, 24.0, 90, -8);             // F1 bathroom: tub+toilet
await shot('int_bedroom', 13.0, 9.1, 25.7, 180, -4);          // F2 east bedroom: bed + balcony door

await browser.close();
server.close();
console.log('done');
