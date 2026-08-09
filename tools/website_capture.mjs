// website_capture.mjs — re-shoot website screenshots + hero video from the real game.
//
// Renders game.html headless (with the world baked into build/game-play.js — run
// `npm run build` first after editing the map), teleports the camera to staged
// spots, and writes JPGs + a trimmed looping hero.webm into website/assets/.
//
// Usage:
//   node tools/website_capture.mjs survey   — aerial recon shots to /tmp (pick vantage points)
//   node tools/website_capture.mjs stills   — overwrite website/assets/*.jpg
//   node tools/website_capture.mjs video    — record + trim website/assets/hero.webm
//
// Camera positions are in METERS (map cell coords × 0.5). Edit SHOTS/DOLLY below
// after a map change; `survey` helps find the new landmarks.

import { homedir, tmpdir } from 'node:os';
import { existsSync, readdirSync, mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'website', 'assets');
const TMP = join(tmpdir(), 'voxelgame-capture');

// ---- staged shots (meters; lookAt = [x,y,z]; phase: 0=noon 0.16=golden 0.32=dusk 0.45=night) ----
const SHOTS = [
  { name: 'hero_golden', pos: [14, 1.2, 7.5], lookAt: [2, 2.2, 9], phase: 0.16 },
  { name: 'world_aerial', pos: [5, 12, 27], lookAt: [5, 0, 5], phase: 0.07 },
  { name: 'dusk_street', pos: [11, 1.3, 10.5], lookAt: [0, 2.5, 9], phase: 0.32 },
  { name: 'street_stop', pos: [8.5, 1.4, 3.5], lookAt: [7.5, 1.5, 11], phase: 0.07 },
  { name: 'warsztat', pos: [9.5, 1.2, 6], lookAt: [0, 2.5, 5], phase: 0.1 },
  { name: 'street_view', pos: [10.5, 1.3, 14.5], lookAt: [4.5, 2.5, 2], phase: 0.16 },
  // hud shots: HUD + hands visible, weapon equipped, short wait so mobs animate/approach
  { name: 'zombies_gameplay', pos: [10.5, 1.0, 10.5], lookAt: [14, 1.6, 14.2], phase: 0.1, hud: true, holdMs: 3000 },
  // dialog shot: opens dialogue with the first NPC after placing the camera
  { name: 'granny_dialog', pos: [2.2, 1.0, 12.6], lookAt: [4.75, 1.55, 11.6], phase: 0.08, hud: true, dialog: true },
];

// hero video dolly (meters): eased from→to while looking at `look`
const DOLLY = { from: [6.8, 2.4, 16.5], to: [6.8, 1.8, 5.6], look: [4.8, 2.3, 0.8], phase: 0.16, durMs: 9000 };

function findChromium() {
  const cache = join(homedir(), '.cache', 'ms-playwright');
  for (const d of readdirSync(cache).filter((x) => x.startsWith('chromium-'))) {
    const exe = join(cache, d, 'chrome-linux', 'chrome');
    if (existsSync(exe)) return exe;
  }
  throw new Error('No cached chromium (install with: npx playwright-core install chromium)');
}

const GPU_ARGS = ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

async function bootGame(page, { blackout = false } = {}) {
  await page.goto(`file://${ROOT}/game.html`);
  if (blackout)
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.id = 'blackout';
      d.style.cssText = 'position:fixed;inset:0;background:#000;z-index:9999';
      document.body.appendChild(d);
    });
  await page.waitForFunction(() => !!window.__voxelgame, { timeout: 20000 });
  await page.evaluate(() => window.__voxelgame.ui.btnNew.click());
  await page.waitForTimeout(3500);
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'clean';
    s.textContent =
      '#hud,#crosshair,#quest,#toast,#pickup,#touch-layer,#hit-feedback{display:none!important}' +
      '#game canvas{animation:none!important;filter:none!important}';
    document.head.appendChild(s);
    window.__voxelgame.hand.group.visible = false;
  });
}

async function placeCamera(page, { pos, lookAt, phase, hud = false }) {
  await page.evaluate(
    ({ pos, lookAt, phase, hud }) => {
      const g = window.__voxelgame;
      const r = g.renderer;
      if (r.lighting?.dayNightSpeed) r._skyTime = phase / r.lighting.dayNightSpeed;
      const dx = lookAt[0] - pos[0], dy = lookAt[1] - (pos[1] + g.walk.eyeHeight), dz = lookAt[2] - pos[2];
      g.walk.position.set(pos[0], pos[1], pos[2]);
      g.walk.velocity.set(0, 0, 0);
      g.walk.yaw = Math.atan2(-dx, -dz);
      g.walk.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      document.getElementById('clean').disabled = hud;
      g.hand.group.visible = hud;
    },
    { pos, lookAt, phase, hud }
  );
}

async function stills() {
  mkdirSync(ASSETS, { recursive: true });
  const browser = await chromium.launch({ executablePath: findChromium(), args: GPU_ARGS });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await bootGame(page);
  await page.evaluate(() => {
    const g = window.__voxelgame;
    g.stats.equip('primary', 'akm_kalach');
    g.stats.addAmmo('rifle', 90);
    g._selectSlot(0);
    g._updateHeldItem();
    g._renderEquipment();
    g._updateHud();
    g._updateAmmoHud();
  });
  for (const shot of SHOTS) {
    await placeCamera(page, shot);
    if (shot.dialog)
      await page.evaluate(() => {
        const g = window.__voxelgame;
        const n = (g.npcs?.npcs ?? [])[0];
        if (n) g._startDialog(n);
      });
    await page.waitForTimeout(shot.holdMs ?? 400);
    await page.screenshot({ path: join(ASSETS, `${shot.name}.jpg`), type: 'jpeg', quality: 88 });
    if (shot.dialog) await page.evaluate(() => window.__voxelgame._closeDialog());
    console.log('still:', shot.name);
  }
  await browser.close();
}

async function survey() {
  const out = join(TMP, 'survey');
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: findChromium(), args: GPU_ARGS });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await bootGame(page);
  const center = await page.evaluate(() => {
    const g = window.__voxelgame;
    let mn = [1e9, 1e9], mx = [-1e9, -1e9];
    g.world.forEachVoxel((v) => {
      const [x, , z] = v.anchor;
      mn = [Math.min(mn[0], x), Math.min(mn[1], z)];
      mx = [Math.max(mx[0], x), Math.max(mx[1], z)];
    });
    return { cx: ((mn[0] + mx[0]) / 2) * 0.5, cz: ((mn[1] + mx[1]) / 2) * 0.5, span: Math.max(mx[0] - mn[0], mx[1] - mn[1]) * 0.5 };
  });
  const { cx, cz, span } = center;
  const d = span * 0.9, h = span * 0.6;
  const views = [
    ['top_down', [cx, span * 1.8, cz], 0, -1.55],
    ['from_south', [cx, h, cz + d], 0, -0.5],
    ['from_north', [cx, h, cz - d], Math.PI, -0.5],
    ['from_east', [cx + d, h, cz], Math.PI / 2, -0.5],
    ['from_west', [cx - d, h, cz], -Math.PI / 2, -0.5],
  ];
  for (const [name, pos, yaw, pitch] of views) {
    await page.evaluate(
      ({ pos, yaw, pitch }) => {
        const g = window.__voxelgame;
        if (g.renderer.lighting?.dayNightSpeed) g.renderer._skyTime = 0.05 / g.renderer.lighting.dayNightSpeed;
        g.walk.position.set(pos[0], pos[1], pos[2]);
        g.walk.velocity.set(0, 0, 0);
        g.walk.yaw = yaw;
        g.walk.pitch = pitch;
      },
      { pos, yaw, pitch }
    );
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(out, `${name}.jpg`), type: 'jpeg', quality: 80 });
    console.log('survey:', name);
  }
  await browser.close();
  console.log('survey shots in', out);
}

async function video() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  // pass 1: record with a black cover over boot so the trim cut point is detectable
  {
    const browser = await chromium.launch({ executablePath: findChromium(), args: GPU_ARGS });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: TMP, size: { width: 1280, height: 720 } },
    });
    const page = await ctx.newPage();
    await bootGame(page, { blackout: true });
    await page.evaluate((DOLLY) => {
      const g = window.__voxelgame;
      if (g.renderer.lighting?.dayNightSpeed) g.renderer._skyTime = DOLLY.phase / g.renderer.lighting.dayNightSpeed;
      const t0 = performance.now();
      g.walk.update = () => {
        const u = Math.min(1, (performance.now() - t0) / DOLLY.durMs);
        const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        const p = DOLLY.from.map((f, i) => f + (DOLLY.to[i] - f) * e);
        const dx = DOLLY.look[0] - p[0], dy = DOLLY.look[1] - p[1], dz = DOLLY.look[2] - p[2];
        g.walk.camera.position.set(p[0], p[1], p[2]);
        g.walk.camera.rotation.set(Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0, 'YXZ');
      };
      requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById('blackout').remove()));
    }, DOLLY);
    await page.waitForTimeout(DOLLY.durMs + 600);
    await page.close();
    await ctx.close();
    await browser.close();
    renameSync(join(TMP, readdirSync(TMP).find((f) => f.endsWith('.webm'))), join(TMP, 'raw.webm'));
  }
  // pass 2: trim the black lead-in by re-encoding in-browser (canvas + MediaRecorder)
  {
    const browser = await chromium.launch({
      executablePath: findChromium(),
      args: ['--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
    });
    const page = await browser.newPage({ viewport: { width: 1300, height: 760 } });
    await page.goto(`file://${TMP}/`);
    const b64 = await page.evaluate(async (videoUrl) => {
      const v = document.createElement('video');
      v.src = videoUrl;
      v.muted = true;
      document.body.appendChild(v);
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('load failed')); });
      const W = 1280, H = 720;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const c = canvas.getContext('2d', { willReadFrequently: true });
      const seekTo = (t) => new Promise((res) => { v.onseeked = res; v.currentTime = t; });
      let start = 3.0;
      for (let t = 3.0; t < 8; t += 0.1) {
        await seekTo(t);
        c.drawImage(v, 0, 0, W, H);
        const d = c.getImageData(W / 2 - 50, H / 2 - 50, 100, 100).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
        if (sum / (d.length / 4) > 30) { start = t + 0.15; break; }
      }
      const stream = canvas.captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 2_600_000 });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const done = new Promise((res) => { rec.onstop = res; });
      await seekTo(start);
      let drawing = true;
      (function draw() { if (!drawing) return; c.drawImage(v, 0, 0, W, H); requestAnimationFrame(draw); })();
      rec.start(250);
      await v.play();
      await new Promise((res) => { v.onended = res; });
      drawing = false;
      rec.stop();
      await done;
      const buf = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer();
      let s = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }, `file://${TMP}/raw.webm`);
    await browser.close();
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 100_000) throw new Error(`trimmed video suspiciously small: ${buf.length}`);
    writeFileSync(join(ASSETS, 'hero.webm'), buf);
    console.log('hero.webm written:', buf.length, 'bytes');
  }
}

const mode = process.argv[2];
if (mode === 'stills') await stills();
else if (mode === 'survey') await survey();
else if (mode === 'video') await video();
else {
  console.log('usage: node tools/website_capture.mjs <survey|stills|video>');
  process.exit(1);
}
