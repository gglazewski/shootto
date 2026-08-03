// server.mjs — local dev/deploy server for the voxel editor.
//
// Serves the game (index.html + build/) over HTTP and exposes a tiny filesystem
// API so the editor can read/write the world file directly on disk instead of
// prompting a download:
//
//   GET  /api/world  -> map/voxelbundle.json (as JSON text)
//   PUT  /api/world  -> write the request body to map/voxelbundle.json
//
// The editor auto-saves here ("Save File" just PUTs), and the deployed game can
// be built from this same map/voxelbundle.json. No runtime deps: node:http only.
//
// Usage: node server.mjs [port]   (default 4173)

import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORLD_FILE = join(ROOT, 'map', 'voxelbundle.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 32 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
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

export async function startServer({ port = 4173, worldFile = WORLD_FILE, root = ROOT } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

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
          await writeFile(worldFile, body);
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
  return { server, port: actual, worldFile };
}

// Run directly: `node server.mjs [port]`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2]) || 4173;
  const { port: p } = await startServer({ port });
  console.log(`voxel editor running at http://localhost:${p}`);
  console.log(`world file: ${WORLD_FILE}`);
}
