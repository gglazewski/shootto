// pack_splash.mjs — bake the menu's splash screens into the deployable build.
//
// Reads map/splash.json (the manifest the editor maintains: which library
// worlds/cameras the main menu shows) and inlines each referenced world from
// map/worlds/ into map/splashpack.json, which the game bundle embeds (see
// src/game/splashPack.js). Runs automatically before `npm run build:game`.
// With no manifest (or no valid entries) it writes an empty pack, so the
// build never breaks — the menu just falls back to the procedural flyover.
//
// Usage: node tools/pack_splash.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPLASH_FILE = join(ROOT, 'map', 'splash.json');
const WORLDS_DIR = join(ROOT, 'map', 'worlds');
const PACK_FILE = join(ROOT, 'map', 'splashpack.json');

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

const manifest = await readJson(SPLASH_FILE);
const entries = [];
const worlds = new Map(); // path -> parsed bundle (or null), fetched once

for (const e of Array.isArray(manifest?.entries) ? manifest.entries : []) {
  if (!e || typeof e.world !== 'string' || typeof e.cam !== 'string') continue;
  // Same guard rails as the server: library paths only, no traversal.
  const segments = e.world.split('/').filter(Boolean);
  if (!segments.length || segments.some((s) => s.startsWith('.'))) {
    console.warn(`splashpack: skipping bad world path "${e.world}"`);
    continue;
  }
  if (!worlds.has(e.world)) worlds.set(e.world, await readJson(join(WORLDS_DIR, ...segments)));
  const bundle = worlds.get(e.world);
  if (!bundle) {
    console.warn(`splashpack: world "${e.world}" not found in map/worlds/ — skipping cam ${e.cam}`);
    continue;
  }
  const cams = Array.isArray(bundle.map?.splashCams) ? bundle.map.splashCams : [];
  if (!cams.some((c) => c?.id === e.cam)) {
    console.warn(`splashpack: cam "${e.cam}" not in "${e.world}" — skipping`);
    continue;
  }
  entries.push({ world: e.world, cam: e.cam, bundle });
}

await writeFile(PACK_FILE, JSON.stringify({ format: 'splashpack', version: 1, entries }, null, 2));
console.log(`splashpack: ${entries.length} splash screen(s) -> map/splashpack.json`);
