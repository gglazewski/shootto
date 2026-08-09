import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';

import { loadSplashEntries } from '../src/game/SplashScreens.js';
import { MenuFlyover } from '../src/game/MenuFlyover.js';
import { World } from '../src/engine/World.js';

// --- loadSplashEntries ---

const jsonRes = (data) => ({ ok: true, json: async () => data, text: async () => JSON.stringify(data) });
const notFound = { ok: false, json: async () => { throw new Error('404'); }, text: async () => 'not found' };

test('loadSplashEntries resolves manifest worlds through the server', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url === '/api/splash') {
      return jsonRes({ format: 'splashlist', version: 1, entries: [
        { world: 'splash/sunset.json', cam: 'cam_a' },
        { world: 'splash/sunset.json', cam: 'cam_b' }, // same world, second cam
        { world: 'missing.json', cam: 'cam_c' },
        { world: 42, cam: 'cam_d' }, // malformed
      ] });
    }
    if (url === '/api/worlds/splash/sunset.json') return jsonRes({ format: 'voxelbundle' });
    return notFound;
  };
  const entries = await loadSplashEntries(fetchFn, null);
  assert.deepEqual(entries.map((e) => e.camId), ['cam_a', 'cam_b']);
  // one world fetch even though two cams reference it
  assert.equal(calls.filter((u) => u.includes('sunset')).length, 1);
});

test('loadSplashEntries falls back to the embedded pack without a server', async () => {
  const failingFetch = async () => { throw new Error('no server'); };
  const pack = { entries: [
    { world: 'a.json', cam: 'c1', bundle: { format: 'voxelbundle' } },
    { world: 'b.json', cam: 'c2' }, // no bundle inlined — skipped
  ] };
  const entries = await loadSplashEntries(failingFetch, pack);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].camId, 'c1');
  assert.equal(JSON.parse(entries[0].worldText).format, 'voxelbundle');

  // A static host answering /api/splash with HTML must also fall through.
  const htmlFetch = async () => ({ ok: true, json: async () => { throw new Error('html'); } });
  assert.equal((await loadSplashEntries(htmlFetch, pack)).length, 1);
});

test('loadSplashEntries returns [] with no server and no pack', async () => {
  assert.deepEqual(await loadSplashEntries(null, null), []);
});

// --- MenuFlyover splash motion ---

function makeFly() {
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  const fly = new MenuFlyover({ THREE, world: new World(), camera });
  return { fly, camera };
}

test('a splash shot drives the camera without any world bounds', () => {
  const { fly, camera } = makeFly();
  // no rebuild(): empty world, no curves — procedural update would no-op
  fly.setSplash({ id: 'c', pos: [10, 8, -4], yaw: 0, pitch: -0.3, motion: 'orbit' });
  fly.update(0.001);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(10, 8, -4)) < 0.01,
    'orbit starts on the captured pose');
});

test('orbit circles the framed point at constant height and distance', () => {
  const { fly, camera } = makeFly();
  fly.setSplash({ id: 'c', pos: [0, 10, 0], yaw: 0, pitch: -0.5, motion: 'orbit' });
  fly.update(0.001);
  const start = camera.position.clone();
  for (let i = 0; i < 100; i++) fly.update(0.5); // 50 seconds of orbit
  assert.equal(camera.position.y, start.y, 'orbit keeps the captured height');
  assert.ok(camera.position.distanceTo(start) > 1, 'camera actually moved');
});

test('zoom in glides along the view direction and settles at the travel cap', () => {
  const { fly, camera } = makeFly();
  // Looking straight down -Z from z=20.
  fly.setSplash({ id: 'c', pos: [0, 5, 20], yaw: 0, pitch: 0, motion: 'zoomin' });
  fly.update(0.001);
  assert.ok(Math.abs(camera.position.z - 20) < 0.01, 'zoom in starts on the pose');
  fly.update(1);
  assert.ok(camera.position.z < 20, 'zoom in moves toward the framed spot');
  for (let i = 0; i < 200; i++) fly.update(1);
  assert.ok(Math.abs(camera.position.z - (20 - 8)) < 0.01, 'push settles at the cap, not inside geometry');
  assert.equal(camera.position.x, 0, 'zoom never strafes');
});

test('zoom out starts on the pose and pulls back; dolly is a zoom-in alias', () => {
  const { fly, camera } = makeFly();
  fly.setSplash({ id: 'c', pos: [0, 5, 20], yaw: 0, pitch: 0, motion: 'zoomout' });
  fly.update(0.001);
  assert.ok(Math.abs(camera.position.z - 20) < 0.01, 'zoom out starts on the pose');
  fly.update(2);
  assert.ok(camera.position.z > 20, 'zoom out retreats along the view direction');

  // Old maps stored 'dolly' — it must behave as zoom in, not fall to orbit.
  fly.setSplash({ id: 'c', pos: [0, 5, 20], yaw: 0, pitch: 0, motion: 'dolly' });
  fly.update(2);
  assert.ok(camera.position.z < 20, 'dolly pushes in like zoomin');
});

test('static drift stays on the pose and clearing the splash resumes the lap', () => {
  const { fly, camera } = makeFly();
  fly.setSplash({ id: 'c', pos: [3, 7, 9], yaw: 1, pitch: 0.2, motion: 'static' });
  for (let i = 0; i < 50; i++) fly.update(0.3);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(3, 7, 9)) < 1e-9);
  fly.setSplash(null);
  assert.equal(fly.splash, null);
  fly.update(0.1); // no curves — must be a clean no-op, not a crash
});
