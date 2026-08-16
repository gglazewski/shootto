// meshWorkerMain.js — Web Worker entry for off-thread chunk meshing.
//
// Bundled separately (build/mesh-worker.js, see package.json build:worker).
// The main thread sends plain-data chunk snapshots (ChunkSnapshot); this
// worker rebuilds the world/light stubs and runs the exact same
// buildChunkMesh the synchronous path uses, then transfers the packed
// buffers back — so worker output is byte-identical to main-thread output.
//
// Protocol:
//  { type:'init', tiles: [[name, index]...], atlas, decalDefs: [def...] }
//    tiles    = the atlas' name->index map (re-sent when the atlas rebuilds,
//               e.g. runtime text-sign tiles)
//    decalDefs= the full decal registry, replayed so runtime-registered
//               decals (text signs) resolve here too. Static defs re-register
//               over themselves harmlessly.
//  { type:'mesh', id, snapshot }  ->  { id, data }  (buffers transferred)

import { buildChunkMesh } from './ChunkMeshBuilder.js';
import { snapshotStubs } from './ChunkSnapshot.js';
import { getDecal, tileFor, registerDecal } from './VoxelTypes.js';

let tileMap = new Map();
let atlas = { width: 4, height: 2 };

// Same resolution logic as AtlasTexture.three.js: block ids (per-face
// tiles), decal ids (their single tile) and raw tile names all route through
// one callback.
const tileIndexFor = (typeId, face) => tileMap.get(getDecal(typeId)?.tile ?? tileFor(typeId, face) ?? typeId);

const transferListOf = (d) => [
  d.positions.buffer, d.normals.buffer, d.shade.buffer,
  d.uvLocal.buffer, d.tileInfo.buffer, d.indices.buffer,
];

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    tileMap = new Map(msg.tiles);
    atlas = msg.atlas;
    for (const def of msg.decalDefs ?? []) registerDecal(def);
    return;
  }
  if (msg.type === 'mesh') {
    const snap = msg.snapshot;
    const { world, light } = snapshotStubs(snap);
    const data = buildChunkMesh(world, light, snap.origin, snap.size, tileIndexFor, atlas, { packed: true });
    const transfer = transferListOf(data);
    if (data.transparent) transfer.push(...transferListOf(data.transparent));
    self.postMessage({ id: msg.id, data }, transfer);
  }
};
