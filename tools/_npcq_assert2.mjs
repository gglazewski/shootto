// Throwaway: full panel assertion, take two.
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
page.on('pageerror', (e) => { console.log('PAGEERROR:', e.message); process.exitCode = 1; });
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForFunction(() => !!window.__voxelgame, { timeout: 60000 });
const ok = (name, cond) => { console.log(cond ? `ok  ${name}` : `FAIL ${name}`); if (!cond) process.exitCode = 1; };

// open lands on the first real NPC with both foot actions
await page.evaluate(() => window.__voxelgame.npcQuestEditor.open());
await page.waitForTimeout(100);
let st = await page.evaluate(() => ({
  identity: document.querySelector('.npcq-section-head')?.textContent,
  foot: [...document.querySelectorAll('.npcq-foot button')].map((b) => b.textContent),
}));
ok('opens on the first NPC', /Identity — /.test(st.identity ?? '') && !st.identity.includes('new character'));
ok('npc foot has save + delete', st.foot.includes('Save NPC') && st.foot.includes('Delete NPC'));

// to quests
await page.click('.npcq-tabs button:nth-child(2)');
await page.waitForTimeout(100);
st = await page.evaluate(() => ({
  tierTag: document.querySelector('.npcq-tier-tag')?.textContent,
  flowbar: !!document.querySelector('.npcq-flowbar'),
  segs: [...document.querySelectorAll('.npcq-flowbar .npcq-seg')].length,
  collapsed: [...document.querySelectorAll('.npcq-section')].map((s) => s.classList.contains('collapsed')),
  badge: document.querySelector('.npcq-section-badge')?.textContent,
  foot: [...document.querySelectorAll('.npcq-foot button')].map((b) => b.textContent),
}));
ok('quests header: tier tag + flow bar with 2 segments', !!st.tierTag && st.flowbar && st.segs === 2);
ok('objectives+dialogue open; rewards+flags collapsed', st.collapsed.length === 4
  && st.collapsed[0] === false && st.collapsed[1] === false && st.collapsed[2] && st.collapsed[3]);
ok('objectives badge', /\d+ goal/.test(st.badge ?? ''));
ok('quests foot has save + delete', st.foot.includes('Save tier') && st.foot.includes('Delete tier'));

// typed text survives a structural re-render
await page.evaluate(() => { document.querySelector('.npcq-title-input').value = 'Draft Survives'; });
await page.evaluate(() => { document.querySelector('.npcq-objectives .npcq-add').click(); });
await page.waitForTimeout(100);
st = await page.evaluate(() => ({
  title: document.querySelector('.npcq-title-input').value,
  badge: document.querySelector('.npcq-section-badge')?.textContent,
}));
ok('title survives add-objective re-render', st.title === 'Draft Survives');
ok('badge recount', /2 goals/.test(st.badge ?? ''));

// collapse keeps text (pure DOM toggle)
await page.evaluate(() => { document.querySelector('.npcq-title-input').value = 'T2'; });
await page.click('.npcq-section-head >> nth=0');
await page.waitForTimeout(50);
st = await page.evaluate(() => ({
  collapsed: document.querySelector('.npcq-section').classList.contains('collapsed'),
  title: document.querySelector('.npcq-title-input').value,
}));
ok('collapse keeps typed text', st.collapsed && st.title === 'T2');

// flow segment dims offer group
await page.evaluate(() => {
  const seg = document.querySelectorAll('.npcq-flowbar .npcq-seg')[0];
  [...seg.querySelectorAll('button')].find((b) => b.textContent.includes('itself')).click();
});
await page.waitForTimeout(50);
ok('auto-start dims offer conversation', await page.evaluate(() => {
  const g = [...document.querySelectorAll('.npcq-subgroup')][0];
  return g.classList.contains('npcq-dim') && getComputedStyle(g.querySelector('.npcq-skipnote')).display !== 'none';
}));

// dirty guard blocks tab switch (confirm auto-dismissed in headless)
await page.click('.npcq-tabs button:nth-child(1)');
await page.waitForTimeout(100);
ok('dirty guard blocks the tab switch', await page.evaluate(() =>
  document.querySelectorAll('.npcq-section').length === 4));
// clear dirty -> switch lands on the NPC sections
await page.evaluate(() => { window.__voxelgame.npcQuestEditor._dirty = false; });
await page.click('.npcq-tabs button:nth-child(1)');
await page.waitForTimeout(100);
st = await page.evaluate(() => ({
  n: document.querySelectorAll('.npcq-section').length,
  collapsed: [...document.querySelectorAll('.npcq-section')].map((s) => s.classList.contains('collapsed')),
  foot: [...document.querySelectorAll('.npcq-foot button')].map((b) => b.textContent),
}));
ok('npc tab: 5 sections, identity open', st.n === 5 && st.collapsed[0] === false
  && st.collapsed.slice(1).every((c) => c === true));
ok('npc foot save + delete', st.foot.includes('Save NPC') && st.foot.includes('Delete NPC'));

await browser.close();
server.close();
