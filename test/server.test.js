import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server.mjs';

let base;
let port;
let server;

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'voxel-server-'));
  mkdirSync(join(base, 'map'), { recursive: true });
  const world = join(base, 'map', 'voxelbundle.json');
  writeFileSync(world, JSON.stringify({ format: 'voxelbundle', version: 1, map: { format: 'voxelmap', version: 1, cellSize: 0.5, blocks: [{ x: 0, y: 0, z: 0, size: 'big', type: 'grass' }], items: [] }, items: [] }));
  const s = await startServer({
    port: 0,
    worldFile: world,
    root: base,
    worldsDir: join(base, 'map', 'worlds'),
    splashFile: join(base, 'map', 'splash.json'),
  });
  server = s.server;
  port = s.port;
});

after(() => server?.close());

test('serves index.html over http', async () => {
  const res = await fetch(`http://localhost:${port}/index.html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('GET /api/world returns the world file on disk', async () => {
  const res = await fetch(`http://localhost:${port}/api/world`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.format, 'voxelbundle');
  assert.equal(data.map.blocks.length, 1);
});

test('PUT /api/world writes the body to the world file', async () => {
  const body = JSON.stringify({ format: 'voxelbundle', version: 1, map: { format: 'voxelmap', version: 1, cellSize: 0.5, blocks: [{ x: 0, y: 0, z: 0, size: 'big', type: 'sand' }], items: [] }, items: [] });
  const res = await fetch(`http://localhost:${port}/api/world`, { method: 'PUT', body, headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 200);
  const saved = JSON.parse(readFileSync(join(base, 'map', 'voxelbundle.json'), 'utf8'));
  assert.equal(saved.map.blocks[0].type, 'sand');
});

test('PUT /api/world rejects invalid JSON', async () => {
  const res = await fetch(`http://localhost:${port}/api/world`, { method: 'PUT', body: 'not json' });
  assert.equal(res.status, 400);
});

test('GET /api/world returns null when no world file exists', async () => {
  const empty = join(base, 'map', 'empty.json');
  const s = await startServer({ port: 0, worldFile: empty, root: base });
  try {
    const res = await fetch(`http://localhost:${s.port}/api/world`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'null');
  } finally {
    s.server.close();
  }
});

test('missing static files 404', async () => {
  const res = await fetch(`http://localhost:${port}/does-not-exist.js`);
  assert.equal(res.status, 404);
});

// --- world library ---

const WORLD_BODY = JSON.stringify({ format: 'voxelbundle', version: 1, map: { format: 'voxelmap', version: 1, cellSize: 0.5, blocks: [], items: [] }, items: [] });

test('GET /api/worlds returns [] when the library is empty', async () => {
  const res = await fetch(`http://localhost:${port}/api/worlds`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test('PUT then GET a world in a nested folder', async () => {
  const put = await fetch(`http://localhost:${port}/api/worlds/campaign/01-farm.json`, { method: 'PUT', body: WORLD_BODY });
  assert.equal(put.status, 200);
  const get = await fetch(`http://localhost:${port}/api/worlds/campaign/01-farm.json`);
  assert.equal(get.status, 200);
  assert.equal((await get.json()).format, 'voxelbundle');

  const list = await (await fetch(`http://localhost:${port}/api/worlds`)).json();
  assert.deepEqual(list.map((e) => [e.path, e.type]), [
    ['campaign', 'folder'],
    ['campaign/01-farm.json', 'world'],
  ]);
  const world = list.find((e) => e.type === 'world');
  assert.equal(world.size, WORLD_BODY.length);
  assert.equal(typeof world.mtime, 'number');
});

test('PUT world rejects invalid JSON and non-.json paths', async () => {
  let res = await fetch(`http://localhost:${port}/api/worlds/bad.json`, { method: 'PUT', body: 'not json' });
  assert.equal(res.status, 400);
  res = await fetch(`http://localhost:${port}/api/worlds/bad.txt`, { method: 'PUT', body: WORLD_BODY });
  assert.equal(res.status, 400);
});

test('world paths cannot escape the library', async () => {
  for (const evil of ['..%2Fvoxelbundle.json', '.hidden%2Fx.json', '~%2Fx.json']) {
    const res = await fetch(`http://localhost:${port}/api/worlds/${evil}`, { method: 'PUT', body: WORLD_BODY });
    assert.equal(res.status, 400, evil);
  }
});

test('worlds-ops mkdir and move reorganize the tree', async () => {
  await fetch(`http://localhost:${port}/api/worlds/loose.json`, { method: 'PUT', body: WORLD_BODY });
  let res = await fetch(`http://localhost:${port}/api/worlds-ops`, { method: 'POST', body: JSON.stringify({ op: 'mkdir', path: 'sandbox' }) });
  assert.equal(res.status, 200);
  res = await fetch(`http://localhost:${port}/api/worlds-ops`, { method: 'POST', body: JSON.stringify({ op: 'move', from: 'loose.json', to: 'sandbox/loose.json' }) });
  assert.equal(res.status, 200);
  const list = await (await fetch(`http://localhost:${port}/api/worlds`)).json();
  const paths = list.map((e) => e.path);
  assert.ok(paths.includes('sandbox/loose.json'));
  assert.ok(!paths.includes('loose.json'));
});

test('DELETE removes a world and folders recursively', async () => {
  await fetch(`http://localhost:${port}/api/worlds/doomed/x.json`, { method: 'PUT', body: WORLD_BODY });
  const res = await fetch(`http://localhost:${port}/api/worlds/doomed`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.ok(!existsSync(join(base, 'map', 'worlds', 'doomed')));
  const missing = await fetch(`http://localhost:${port}/api/worlds/doomed/x.json`);
  assert.equal(missing.status, 404);
});

// --- splash manifest ---

test('GET /api/splash returns null before any manifest exists', async () => {
  const res = await fetch(`http://localhost:${port}/api/splash`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'null');
});

test('PUT then GET the splash manifest', async () => {
  const body = JSON.stringify({ format: 'splashlist', version: 1, entries: [{ world: 'campaign/01-farm.json', cam: 'c1' }] });
  const put = await fetch(`http://localhost:${port}/api/splash`, { method: 'PUT', body });
  assert.equal(put.status, 200);
  const data = await (await fetch(`http://localhost:${port}/api/splash`)).json();
  assert.equal(data.entries.length, 1);
  assert.equal(readFileSync(join(base, 'map', 'splash.json'), 'utf8'), body);
});
