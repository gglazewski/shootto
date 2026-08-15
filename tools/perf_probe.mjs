// perf_probe.mjs — measure CPU-side costs that cause frame spikes:
// light recompute, per-chunk rebuilds, blinker edit frames, frame-time stats.
import { chromium } from 'playwright-core';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { startServer } from '../server.mjs';

const cache = join(homedir(), '.cache', 'ms-playwright');
let exe = null;
for (const d of readdirSync(cache).filter((d) => d.startsWith('chromium-'))) {
  const p = join(cache, d, 'chrome-linux', 'chrome');
  if (existsSync(p)) { exe = p; break; }
}

setTimeout(() => { console.error('PROBE TIMEOUT — forcing exit'); process.exit(2); }, 90000).unref();

const { port } = await startServer({ port: 0 });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE:', m.text()); });
await page.goto(`http://localhost:${port}/game.html`);
await page.waitForFunction(() => !!window.__voxelgame, { timeout: 20000 });
await page.evaluate(async () => { const g = window.__voxelgame; if (g.newGame) await g.newGame(); });
// wait for the world + renderer to be populated
await page.waitForFunction(() => {
  const g = window.__voxelgame;
  return g.world && g.renderer && g.renderer.chunks && g.renderer.chunks.size > 0;
}, { timeout: 30000 });
await page.waitForTimeout(500);

const report = await page.evaluate(() => {
  const g = window.__voxelgame;
  const out = {};
  const time = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };

  out.voxels = g.world.voxels.size;
  out.cells = g.world.cells.size;
  out.chunks = g.renderer.chunks.size;

  // tris per chunk
  let tris = 0;
  const perChunk = [];
  for (const [key, mesh] of g.renderer.chunks) {
    const t = (mesh.geometry.index?.count ?? 0) / 3 + (mesh.transparentGeometry?.index?.count ?? 0) / 3;
    tris += t;
    perChunk.push([key, Math.round(t)]);
  }
  perChunk.sort((a, b) => b[1] - a[1]);
  out.totalTris = Math.round(tris);
  out.topChunks = perChunk.slice(0, 8);

  // light recompute (full)
  out.lightRecomputeMs = +time(() => g.renderer.light.recompute()).toFixed(1);

  // rebuild cost of the densest chunks
  out.rebuildMs = perChunk.slice(0, 5).map(([key]) => {
    const ms = time(() => g.renderer._rebuildChunk(key));
    return [key, +ms.toFixed(1)];
  });

  // simulate a blinker edit frame: toggle a voxel + syncChunks
  const anyVoxel = g.world.voxels.values().next().value;
  out.editFrameMs = +time(() => {
    if (anyVoxel) {
      const [ax, ay, az] = anyVoxel.anchor;
      g.world.edits.push({ cells: [[ax, ay, az]], remove: false, type: anyVoxel.type });
      g.world.markDirty(ax, ay, az);
    }
    g.renderer.syncChunks();
  }).toFixed(1);

  // blinkers present
  out.blinkers = g.blinkers?.list?.length ?? 0;

  // scene-wide triangle census by object name prefix
  const groups = {};
  g.renderer.scene.traverse((o) => {
    if (!o.isMesh) return;
    const tris = (o.geometry.index?.count ?? o.geometry.attributes.position?.count ?? 0) / 3;
    const name = o.name || o.material?.name || o.type;
    const key = name.replace(/-[0-9,-]+.*$/, '').replace(/[0-9]+$/, '#') || 'anon';
    groups[key] = (groups[key] ?? 0) + tris;
  });
  out.sceneTrisByGroup = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, Math.round(v)]).sort((a, b) => b[1] - a[1]));
  out.items = g.world.items.size;
  let itemTris = 0;
  const perItem = [];
  for (const [key, entry] of g.itemRenderer?._groups ?? []) {
    const t = (entry.geo.index?.count ?? 0) / 3;
    itemTris += t;
    perItem.push([entry.placement.itemId, Math.round(t)]);
  }
  perItem.sort((a, b) => b[1] - a[1]);
  out.itemTris = Math.round(itemTris);
  out.topItems = perItem.slice(0, 10);
  out.itemRelightMs = +time(() => {
    for (const entry of (g.itemRenderer?._groups?.values() ?? [])) { g.itemRenderer._relight(entry); break; }
  }).toFixed(2);

  // per-system CPU costs
  const p = g.walk.position;
  out.walkUpdateMs = +time(() => g.walk.update(1 / 60)).toFixed(2);
  out.mobsUpdateMs = +time(() => g.mobs.update(1 / 60, p, null)).toFixed(2);
  out.itemRendererUpdateMs = +time(() => g.itemRenderer.update()).toFixed(2);
  out.syncChunksIdleMs = +time(() => g.renderer.syncChunks()).toFixed(2);

  // Simulated blinker frame: soft edits in the building -> syncChunks (deferred
  // budget) + item relight pass.
  out.blinkFrameMs = +time(() => {
    for (const b of g.blinkers.list) {
      const [ax, ay, az] = b.voxel.anchor;
      g.world.edits.push({ cells: [[ax, ay, az]], remove: false, type: b.voxel.type, prevType: b.voxel.type, soft: true });
      g.world.markDirty(ax, ay, az);
    }
    g.renderer.syncChunks();
    g.itemRenderer._lightVersion = -1; // force the relight pass
    g.itemRenderer._lastRelight = 0;
    g.itemRenderer.update();
  }).toFixed(1);

  // Finer breakdown of the relight pass.
  const box = g.renderer.light.lastBox;
  let touched = 0;
  if (box) for (const entry of g.itemRenderer._groups.values()) {
    if (g.itemRenderer._touchesBox(entry, box)) touched++;
  }
  out.lastBox = box;
  out.itemsTouchedByBox = touched;
  const one = [...g.itemRenderer._groups.values()].find((e) => e.lightCells);
  out.relightOneItemMs = one ? +time(() => g.itemRenderer._relight(one)).toFixed(2) : -1;
  out.relightAllItemsMs = +time(() => {
    for (const entry of g.itemRenderer._groups.values()) g.itemRenderer._relight(entry);
  }).toFixed(1);
  out.syncChunksAfterBlinkMs = +time(() => g.renderer.syncChunks()).toFixed(1);

  // frame-time sampling for ~2.5s of real gameplay frames
  return new Promise((resolve) => {
    const times = [];
    let last = performance.now();
    let elapsed = 0;
    const tick = () => {
      const now = performance.now();
      times.push(now - last);
      last = now;
      elapsed += now - last;
      if (times.length < 60) requestAnimationFrame(tick);
      else {
        times.sort((a, b) => a - b);
        out.frameMs = {
          n: times.length,
          p50: +times[Math.floor(times.length * 0.5)].toFixed(1),
          p90: +times[Math.floor(times.length * 0.9)].toFixed(1),
          max: +times[times.length - 1].toFixed(1),
        };
        resolve(out);
      }
    };
    requestAnimationFrame(tick);
  });
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exit(0);
