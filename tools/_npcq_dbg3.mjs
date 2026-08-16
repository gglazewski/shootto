// Throwaway: registry state vs panel selection.
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
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForFunction(() => !!window.__voxelgame, { timeout: 60000 });
await page.evaluate(() => window.__voxelgame.npcQuestEditor.open());
await page.waitForTimeout(100);
const st = await page.evaluate(() => {
  const ed = window.__voxelgame.npcQuestEditor;
  // reach the live registry through the editor's module scope? Not global —
  // infer from the sidebar + form instead.
  return {
    npcId: ed.npcId,
    sidebar: [...document.querySelectorAll('.npcq-list .npcq-entry')].map((e) => e.textContent),
    identityTitle: document.querySelector('.npcq-section-head')?.textContent,
    footButtons: [...document.querySelectorAll('.npcq-foot button')].map((b) => b.textContent),
  };
});
console.log(JSON.stringify(st, null, 2));
await browser.close();
server.close();
