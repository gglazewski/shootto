// packedmesh.test.js — the packed/greedy chunk mesh path.
//
// The packed mode must render the same surfaces as the legacy float mode:
// greedy merging only fuses faces with identical shading, so total face area
// per buffer is preserved exactly (modulo position quantization), while the
// triangle count drops on flat runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE, listBlockIds, listDecalIds, shapeFor } from '../src/engine/VoxelTypes.js';
import { buildChunkMesh, packedAtlasUV, POS_QUANT, UV_QUANT } from '../src/engine/ChunkMeshBuilder.js';
import { makeChunkSnapshot, snapshotStubs } from '../src/engine/ChunkSnapshot.js';
import { LightField } from '../src/engine/LightField.js';
import { CELL_SIZE } from '../src/engine/Space.js';

const tile = () => 0;
const lit = { skyAt: () => 15, blockAt: () => 0 };
const atlas = { width: 4, height: 2 };

/** Sum of triangle areas of a buffer; `scale` converts positions to meters. */
function totalArea(data, scale = 1) {
  const p = data.positions, idx = data.indices;
  let area = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
    const ab = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const ac = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const cx = ab[1] * ac[2] - ab[2] * ac[1];
    const cy = ab[2] * ac[0] - ab[0] * ac[2];
    const cz = ab[0] * ac[1] - ab[1] * ac[0];
    area += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2 * scale * scale;
  }
  return area;
}

test('flat slab greedy-merges to one quad per exposed side', () => {
  const w = new World();
  for (let x = 0; x < 4; x++)
    for (let z = 0; z < 4; z++) w.place('stone', SIZE.SMALL, x, 0, z);
  const legacy = buildChunkMesh(w, lit, [0, 0, 0], 16, tile, atlas);
  const packed = buildChunkMesh(w, lit, [0, 0, 0], 16, tile, atlas, { packed: true });
  // legacy: 16 tops + 16 bottoms + 16 side cells = 48 quads
  assert.equal(legacy.indices.length, 48 * 6);
  // packed: 1 top + 1 bottom + 4 sides = 6 quads
  assert.equal(packed.indices.length, 6 * 6);
  assert.equal(packed.positions.length / 3, 24);
  // identical total surface (quantization is exact on cell corners)
  assert.ok(Math.abs(totalArea(legacy) - totalArea(packed, CELL_SIZE / POS_QUANT)) < 1e-9);
});

test('packed buffers use the quantized typed-array layout', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile, atlas, { packed: true });
  assert.ok(m.packed);
  assert.ok(m.positions instanceof Int16Array);
  assert.ok(m.normals instanceof Int8Array);
  assert.ok(m.shade instanceof Uint8Array);
  assert.ok(m.uvLocal instanceof Uint16Array);
  assert.ok(m.tileInfo instanceof Float32Array);
  assert.ok(m.indices instanceof Uint16Array, 'small meshes take 16-bit indices');
  assert.equal(m.shade.length, (m.positions.length / 3) * 4);
});

test('a lone cube merges each face whole with full-bright uniform shade', () => {
  const w = new World();
  w.place('stone', SIZE.SMALL, 3, 3, 3);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile, atlas, { packed: true });
  assert.equal(m.indices.length, 6 * 6);
  for (let v = 0; v < m.positions.length / 3; v++) {
    assert.equal(m.shade[v * 4 + 0], 255, 'ao');
    assert.equal(m.shade[v * 4 + 1], 255, 'sky light');
    assert.equal(m.shade[v * 4 + 2], 0, 'block light');
    assert.equal(m.shade[v * 4 + 3], 0, 'emissive');
  }
});

test('merged quads carry tile-local UVs beyond one tile (shader wraps them)', () => {
  const w = new World();
  for (let x = 0; x < 3; x++) w.place('stone', SIZE.SMALL, x, 0, 0);
  const m = buildChunkMesh(w, lit, [0, 0, 0], 16, tile, atlas, { packed: true });
  const maxUv = Math.max(...m.uvLocal);
  assert.equal(maxUv, 3 * UV_QUANT, 'a 3-cell run spans uv 0..3');
});

test('packed solo faces decode to the same atlas UV as the legacy mesh', () => {
  // A corner arrangement gives AO gradients -> faces stay solo in packed
  // mode, so vertex order matches legacy and UVs must agree 1:1.
  const w = new World();
  w.place('stone', SIZE.SMALL, 1, 0, 1);
  w.place('stone', SIZE.SMALL, 1, 1, 1);
  w.place('stone', SIZE.SMALL, 2, 0, 1);
  const legacy = buildChunkMesh(w, lit, [0, 0, 0], 16, () => 3, atlas);
  const packed = buildChunkMesh(w, lit, [0, 0, 0], 16, () => 3, atlas, { packed: true });
  // find a legacy vertex and its packed twin by position
  let checked = 0;
  for (let v = 0; v < packed.positions.length / 3; v++) {
    const px = packed.positions[v * 3] / POS_QUANT * CELL_SIZE;
    const py = packed.positions[v * 3 + 1] / POS_QUANT * CELL_SIZE;
    const pz = packed.positions[v * 3 + 2] / POS_QUANT * CELL_SIZE;
    for (let l = 0; l < legacy.positions.length / 3; l++) {
      if (
        Math.abs(legacy.positions[l * 3] - px) < 1e-6
        && Math.abs(legacy.positions[l * 3 + 1] - py) < 1e-6
        && Math.abs(legacy.positions[l * 3 + 2] - pz) < 1e-6
        && Math.abs(legacy.colors[l * 3] - packed.shade[v * 4] / 255) < 1 / 255
      ) {
        const [u, vv] = packedAtlasUV(packed, v, atlas);
        // same tile region at 1/UV_QUANT-tile resolution
        if (Math.abs(legacy.uvs[l * 2] - u) < 2e-3 && Math.abs(legacy.uvs[l * 2 + 1] - vv) < 2e-3) {
          checked++;
          break;
        }
      }
    }
  }
  assert.ok(checked >= packed.positions.length / 3 * 0.9, `matched ${checked} packed verts to legacy UVs`);
});

test('packed mode preserves total surface area on a kitchen-sink world', () => {
  const w = new World();
  // ground with cover scatter
  for (let x = 0; x < 10; x++)
    for (let z = 0; z < 10; z++) w.place('grass', SIZE.SMALL, x, 0, z);
  // walls, overhangs (AO gradients), a big block, a rotated block, a slab
  for (let y = 1; y < 5; y++) w.place('stone', SIZE.SMALL, 0, y, 0);
  w.place('stone', SIZE.SMALL, 1, 4, 0);
  w.place('wood', SIZE.BIG, 4, 1, 4);
  w.place('wood', SIZE.SMALL, 7, 1, 2, 1);
  w.place('stone', SIZE.SMALL, 8, 1, 2, 0, 'lower');
  // one of every exotic shape that exists in the registry
  const ids = listBlockIds();
  const paneId = ids.find((id) => shapeFor(id) === 'pane');
  const crossId = ids.find((id) => shapeFor(id) === 'cross');
  const doorId = ids.find((id) => shapeFor(id) === 'door');
  if (paneId) w.place(paneId, SIZE.SMALL, 2, 1, 6);
  if (crossId) w.place(crossId, SIZE.SMALL, 6, 1, 6);
  if (doorId) w.place(doorId, SIZE.DOOR, 10, 1, 8);
  const decalId = listDecalIds()[0];
  if (decalId) w.placeDecal(decalId, 0, 2, 0, 'px');
  w.paintFace(0, 1, 0, 'pz', 'sand');

  const lf = new LightField(w);
  lf.recompute();

  const legacy = buildChunkMesh(w, lf, [0, 0, 0], 16, tile, atlas);
  const packed = buildChunkMesh(w, lf, [0, 0, 0], 16, tile, atlas, { packed: true });

  const scale = CELL_SIZE / POS_QUANT;
  const areaL = totalArea(legacy) + (legacy.transparent ? totalArea(legacy.transparent) : 0);
  const areaP = totalArea(packed, scale) + (packed.transparent ? totalArea(packed.transparent, scale) : 0);
  // Off-lattice geometry (cover diagonals at 0.15 cells, door thickness
  // 0.24) rounds to the 1/256-cell grid, shifting total area by ~0.2% —
  // sub-millimeter in world space. Anything past 0.5% means lost/extra faces.
  assert.ok(Math.abs(areaL - areaP) / areaL < 5e-3, `area legacy=${areaL} packed=${areaP}`);
  assert.equal(!!legacy.transparent, !!packed.transparent);
  assert.ok(packed.indices.length < legacy.indices.length, 'greedy merging must reduce triangles');
});

/** Build the kitchen-sink world used by the parity tests. */
function kitchenSinkWorld() {
  const w = new World();
  for (let x = 0; x < 10; x++)
    for (let z = 0; z < 10; z++) w.place('grass', SIZE.SMALL, x, 0, z);
  for (let y = 1; y < 5; y++) w.place('stone', SIZE.SMALL, 0, y, 0);
  w.place('stone', SIZE.SMALL, 1, 4, 0);
  w.place('wood', SIZE.BIG, 4, 1, 4);
  w.place('wood', SIZE.SMALL, 7, 1, 2, 1);
  w.place('stone', SIZE.SMALL, 8, 1, 2, 0, 'lower');
  const ids = listBlockIds();
  const paneId = ids.find((id) => shapeFor(id) === 'pane');
  const crossId = ids.find((id) => shapeFor(id) === 'cross');
  const doorId = ids.find((id) => shapeFor(id) === 'door');
  if (paneId) w.place(paneId, SIZE.SMALL, 2, 1, 6);
  if (crossId) w.place(crossId, SIZE.SMALL, 6, 1, 6);
  if (doorId) w.place(doorId, SIZE.DOOR, 10, 1, 8);
  const decalId = listDecalIds()[0];
  if (decalId) w.placeDecal(decalId, 0, 2, 0, 'px');
  w.paintFace(0, 1, 0, 'pz', 'sand');
  return w;
}

test('a chunk snapshot meshes byte-identically to the live world (worker parity)', () => {
  const w = kitchenSinkWorld();
  const lf = new LightField(w);
  lf.recompute();

  const live = buildChunkMesh(w, lf, [0, 0, 0], 16, tile, atlas, { packed: true });
  const snap = makeChunkSnapshot(w, lf, [0, 0, 0], 16);
  // simulate the postMessage boundary for the plain-data parts
  const wire = { ...snap, decals: JSON.parse(JSON.stringify(snap.decals)), paint: JSON.parse(JSON.stringify(snap.paint)), palette: JSON.parse(JSON.stringify(snap.palette)) };
  const stubs = snapshotStubs(wire);
  const fromSnap = buildChunkMesh(stubs.world, stubs.light, [0, 0, 0], 16, tile, atlas, { packed: true });

  for (const k of ['positions', 'normals', 'shade', 'uvLocal', 'tileInfo', 'indices']) {
    assert.deepEqual(fromSnap[k], live[k], `opaque ${k} must match`);
    if (live.transparent) assert.deepEqual(fromSnap.transparent[k], live.transparent[k], `transparent ${k} must match`);
  }
  assert.equal(!!fromSnap.transparent, !!live.transparent);
});

test('snapshots cover neighbor probes across the chunk border', () => {
  const w = new World();
  // wall straddling the chunk border: culling + AO probes cross into x=16
  for (let y = 0; y < 4; y++)
    for (let x = 14; x < 19; x++) w.place('stone', SIZE.SMALL, x, y, 5);
  const lf = new LightField(w);
  lf.recompute();
  const live = buildChunkMesh(w, lf, [0, 0, 0], 16, tile, atlas, { packed: true });
  const stubs = snapshotStubs(makeChunkSnapshot(w, lf, [0, 0, 0], 16));
  const fromSnap = buildChunkMesh(stubs.world, stubs.light, [0, 0, 0], 16, tile, atlas, { packed: true });
  assert.deepEqual(fromSnap.positions, live.positions);
  assert.deepEqual(fromSnap.shade, live.shade);
});

test('packed positions stay inside the Int16 chunk-local envelope', () => {
  const w = new World();
  // content at a far-away chunk — chunk-local packing must not overflow
  const [cx, cy, cz] = [4000, 160, -4000];
  for (let x = 0; x < 16; x++)
    for (let z = 0; z < 16; z++) w.place('grass', SIZE.SMALL, cx + x, cy, cz + z);
  const m = buildChunkMesh(w, lit, [cx, cy, cz], 16, tile, atlas, { packed: true });
  assert.ok(m.positions.length > 0);
  let min = Infinity, max = -Infinity;
  for (const p of m.positions) { min = Math.min(min, p); max = Math.max(max, p); }
  // cover tufts may poke 2 cells above; nothing may leave Int16
  assert.ok(min >= -4 * POS_QUANT && max <= 20 * POS_QUANT, `bounds ${min}..${max}`);
});
