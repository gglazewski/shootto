// server.mjs — local dev/deploy server for the voxel editor.
//
// Serves the game (index.html + build/) over HTTP and exposes a tiny filesystem
// API so the editor can read/write the world file directly on disk instead of
// prompting a download:
//
//   GET  /api/world  -> map/voxelbundle.json (as JSON text)
//   PUT  /api/world  -> write the request body to map/voxelbundle.json
//
// World library (the editor's save/load tree browser) lives under map/worlds/:
//
//   GET    /api/worlds           -> flat listing of the tree
//                                   [{ path, type: 'world'|'folder', size?, mtime? }]
//   GET    /api/worlds/<path>    -> one world file (JSON text)
//   PUT    /api/worlds/<path>    -> write a world (path must end in .json;
//                                   parent folders are created)
//   DELETE /api/worlds/<path>    -> delete a world, or a folder recursively
//   POST   /api/worlds-ops       -> { op: 'mkdir', path } | { op: 'move', from, to }
//
// Splash manifest (which worlds/cameras the main menu shows):
//
//   GET/PUT /api/splash          -> map/splash.json
//
// Editor UI state (which library world is open — survives reloads):
//
//   GET/PUT /api/editor-state    -> map/editor.json
//
// The editor auto-saves here ("Save File" just PUTs), and the deployed game can
// be built from this same map/voxelbundle.json. No runtime deps: node:http only.
//
// Usage: node server.mjs [port]   (default 4173)

import { createServer } from 'node:http';
import { readFile, writeFile, stat, mkdir, rm, rename, readdir } from 'node:fs/promises';
import { join, normalize, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORLD_FILE = join(ROOT, 'map', 'voxelbundle.json');
const WORLDS_DIR = join(ROOT, 'map', 'worlds');
const PREFABS_DIR = join(ROOT, 'map', 'prefabs');
const SPLASH_FILE = join(ROOT, 'map', 'splash.json');
const EDITOR_STATE_FILE = join(ROOT, 'map', 'editor.json');

// Worlds can hold a lot of voxels — accept large uploads (256 MB) so a
// big map never gets cut off mid-save.
const MAX_BODY_BYTES = 256 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
};

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Write a file atomically: the world file is the only copy of a map, so a
 *  crash mid-write must never leave a torn file behind. Writes to a temp
 *  sibling, then renames over the target (rename is atomic on one volume). */
async function writeAtomic(abs, body) {
  const tmp = `${abs}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, abs);
}

/** Resolve a relative world path to an absolute one under `worldsDir`, or
 *  null when it escapes the tree or uses hostile segments. */
function safeWorldPath(worldsDir, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.includes('\0')) return null;
  const segments = rel.split('/').filter(Boolean);
  if (!segments.length) return null;
  // No dot-segments (traversal, hidden files) — plain names only.
  if (segments.some((s) => s.startsWith('.') || s === '~')) return null;
  const abs = normalize(join(worldsDir, ...segments));
  if (abs !== worldsDir && !abs.startsWith(worldsDir + sep)) return null;
  return abs;
}

/** Flat recursive listing of the worlds tree. Folders come with their own
 *  entries so empty ones survive a round-trip; worlds are .json files. */
async function listWorlds(dir, prefix = '') {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // no worlds dir yet — an empty library, not an error
  }
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ path: rel, type: 'folder' });
      out.push(...await listWorlds(join(dir, e.name), rel));
    } else if (e.isFile() && e.name.endsWith('.json')) {
      const info = await stat(join(dir, e.name));
      out.push({ path: rel, type: 'world', size: info.size, mtime: info.mtimeMs });
    }
  }
  return out;
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = normalize(join(ROOT, pathname));
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
  try {
    const info = await stat(file);
    if (!info.isFile()) return send(res, 404, 'not found');
    const body = await readFile(file);
    send(res, 200, body, MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
  } catch {
    send(res, 404, 'not found');
  }
}

export async function startServer({ port = 4173, worldFile = WORLD_FILE, root = ROOT, worldsDir = WORLDS_DIR, prefabsDir = PREFABS_DIR, splashFile = SPLASH_FILE, editorStateFile = EDITOR_STATE_FILE } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // --- world library (tree of world files under map/worlds/) ---
    if (path === '/api/worlds') {
      if (req.method !== 'GET') return send(res, 405, 'method not allowed');
      return send(res, 200, JSON.stringify(await listWorlds(worldsDir)), 'application/json; charset=utf-8');
    }
    if (path.startsWith('/api/worlds/')) {
      const rel = decodeURIComponent(path.slice('/api/worlds/'.length));
      const abs = safeWorldPath(worldsDir, rel);
      if (!abs) return send(res, 400, 'bad world path');
      if (req.method === 'GET') {
        try {
          const body = await readFile(abs);
          return send(res, 200, body, 'application/json; charset=utf-8');
        } catch {
          return send(res, 404, 'not found');
        }
      }
      if (req.method === 'PUT') {
        if (!rel.endsWith('.json')) return send(res, 400, 'world path must end in .json');
        try {
          const body = await readBody(req);
          JSON.parse(body); // validate
          await mkdir(dirname(abs), { recursive: true });
          await writeAtomic(abs, body);
          return send(res, 200, 'ok');
        } catch (e) {
          return send(res, 400, `invalid world json: ${e.message}`);
        }
      }
      if (req.method === 'DELETE') {
        try {
          await rm(abs, { recursive: true });
          return send(res, 200, 'ok');
        } catch {
          return send(res, 404, 'not found');
        }
      }
      return send(res, 405, 'method not allowed');
    }
    // --- prefab library (flat tree of prefab files under map/prefabs/) ---
    if (path === '/api/prefabs') {
      if (req.method !== 'GET') return send(res, 405, 'method not allowed');
      return send(res, 200, JSON.stringify(await listWorlds(prefabsDir)), 'application/json; charset=utf-8');
    }
    if (path.startsWith('/api/prefabs/')) {
      const rel = decodeURIComponent(path.slice('/api/prefabs/'.length));
      const abs = safeWorldPath(prefabsDir, rel);
      if (!abs) return send(res, 400, 'bad prefab path');
      if (req.method === 'GET') {
        try {
          return send(res, 200, await readFile(abs), 'application/json; charset=utf-8');
        } catch {
          return send(res, 404, 'not found');
        }
      }
      if (req.method === 'PUT') {
        if (!rel.endsWith('.json')) return send(res, 400, 'prefab path must end in .json');
        try {
          const body = await readBody(req);
          JSON.parse(body); // validate
          await mkdir(dirname(abs), { recursive: true });
          await writeAtomic(abs, body);
          return send(res, 200, 'ok');
        } catch (e) {
          return send(res, 400, `invalid prefab json: ${e.message}`);
        }
      }
      if (req.method === 'DELETE') {
        try {
          await rm(abs, { recursive: true });
          return send(res, 200, 'ok');
        } catch {
          return send(res, 404, 'not found');
        }
      }
      return send(res, 405, 'method not allowed');
    }
    if (path === '/api/worlds-ops') {
      if (req.method !== 'POST') return send(res, 405, 'method not allowed');
      let op;
      try {
        op = JSON.parse(await readBody(req));
      } catch (e) {
        return send(res, 400, `invalid op json: ${e.message}`);
      }
      if (op?.op === 'mkdir') {
        const abs = safeWorldPath(worldsDir, op.path);
        if (!abs) return send(res, 400, 'bad world path');
        await mkdir(abs, { recursive: true });
        return send(res, 200, 'ok');
      }
      if (op?.op === 'move') {
        const from = safeWorldPath(worldsDir, op.from);
        const to = safeWorldPath(worldsDir, op.to);
        if (!from || !to) return send(res, 400, 'bad world path');
        try {
          await mkdir(dirname(to), { recursive: true });
          await rename(from, to);
          return send(res, 200, 'ok');
        } catch {
          return send(res, 404, 'not found');
        }
      }
      return send(res, 400, 'unknown op');
    }

    // --- splash manifest (worlds + cameras behind the main menu) ---
    if (path === '/api/splash') {
      if (req.method === 'GET') {
        try {
          return send(res, 200, await readFile(splashFile), 'application/json; charset=utf-8');
        } catch {
          return send(res, 200, 'null', 'application/json; charset=utf-8');
        }
      }
      if (req.method === 'PUT') {
        try {
          const body = await readBody(req);
          JSON.parse(body); // validate
          await writeAtomic(splashFile, body);
          return send(res, 200, 'ok');
        } catch (e) {
          return send(res, 400, `invalid splash json: ${e.message}`);
        }
      }
      return send(res, 405, 'method not allowed');
    }

    // --- editor UI state (which library world is open) ---
    if (path === '/api/editor-state') {
      if (req.method === 'GET') {
        try {
          return send(res, 200, await readFile(editorStateFile), 'application/json; charset=utf-8');
        } catch {
          return send(res, 200, 'null', 'application/json; charset=utf-8');
        }
      }
      if (req.method === 'PUT') {
        try {
          const body = await readBody(req);
          JSON.parse(body); // validate
          await writeAtomic(editorStateFile, body);
          return send(res, 200, 'ok');
        } catch (e) {
          return send(res, 400, `invalid editor-state json: ${e.message}`);
        }
      }
      return send(res, 405, 'method not allowed');
    }

    // --- filesystem API ---
    if (path === '/api/world') {
      if (req.method === 'GET') {
        try {
          const body = await readFile(worldFile);
          send(res, 200, body, 'application/json; charset=utf-8');
        } catch {
          send(res, 200, 'null', 'application/json; charset=utf-8');
        }
        return;
      }
      if (req.method === 'PUT') {
        try {
          const body = await readBody(req);
          JSON.parse(body); // validate
          await mkdir(dirname(worldFile), { recursive: true });
          await writeAtomic(worldFile, body);
          send(res, 200, 'ok');
        } catch (e) {
          send(res, 400, `invalid world json: ${e.message}`);
        }
        return;
      }
      return send(res, 405, 'method not allowed');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    await serveStatic(req, res, url);
  });

  await new Promise((resolve) => server.listen(port, resolve));
  const actual = server.address()?.port ?? port;
  return { server, port: actual, worldFile, worldsDir, prefabsDir, splashFile, editorStateFile };
}

// Run directly: `node server.mjs [port]`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2]) || 4173;
  const { port: p } = await startServer({ port });
  console.log(`voxel editor running at http://localhost:${p}`);
  console.log(`world file: ${WORLD_FILE}`);
}
