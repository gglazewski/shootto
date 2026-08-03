import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
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
  const s = await startServer({ port: 0, worldFile: world, root: base });
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
