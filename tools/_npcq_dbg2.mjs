// Throwaway: dump npcs-tab state after the full assert-style flow.
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

const cache = join(homedir(), '.cache', 'ms-playwright');
let exe = null;
for (const d of readdirSync(cache).filter((d) => d.startsWith('chromium-'))) {
  const p = join(cache, d, 'chrome-linux', 'chrome');
  if (existsSync(p)) { exe = p; break; }
}
const { server, port } = await startServer({ port: 0 });
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForFunction(() => !!window.__voxelgame, { timeout: 60000 });
await page.evaluate(() => window.__voxelgame.npcQuestEditor.open());
await page.waitForTimeout(100);
// to quests
await page.click('.npcq-tabs button:nth-child(2)');
await page.waitForTimeout(100);
// dirty edits
await page.evaluate(() => { document.querySelector('.npcq-title-input').value = 'X'; });
await page.evaluate(() => { document.querySelector('.npcq-objectives .npcq-add').click(); });
await page.waitForTimeout(100);
// clear dirty, back to npcs
await page.evaluate(() => { window.__voxelgame.npcQuestEditor._dirty = false; });
await page.click('.npcq-tabs button:nth-child(1)');
await page.waitForTimeout(150);
const st = await page.evaluate(() => ({
  tab: window.__voxelgame.npcQuestEditor.tab,
  npcId: window.__voxelgame.npcQuestEditor.npcId,
  sections: [...document.querySelectorAll('.npcq-section-head')].map((h) => h.textContent.trim()),
  feet: [...document.querySelectorAll('.npcq-foot')].map((f) => [...f.children].map((b) => b.textContent)),
  primary: !!document.querySelector('.npcq-foot .primary'),
  danger: !!document.querySelector('.npcq-foot .danger'),
}));
console.log(JSON.stringify(st, null, 2));
await browser.close();
server.close();
