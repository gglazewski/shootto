// ChunkSnapshot.js — a plain-data capture of everything buildChunkMesh reads
// for one chunk, so meshing can run in a Web Worker (or anywhere without the
// live World/LightField).
//
// The snapshot covers the chunk plus a margin:
//  - voxels: ±VOX_MARGIN cells. Meshing probes neighbors for culling (±1),
//    corner AO (±1), connecting-tile masks (±2) and pane mitering (±2 via
//    footprints), so 2 covers every read.
//  - light: ±LIGHT_MARGIN cells. Door leaves are up to 4 cells tall/wide and
//    sample one cell past each face, so 5 covers the farthest light read.
// Reads beyond the margins return null/0 in the stub — by construction the
// mesher never makes a meaningful read out there.
//
// Voxel objects are deduplicated into a palette (a BIG voxel is one entry,
// not 8) and shipped as-is; postMessage's structured clone snapshots their
// current state (they are plain data — type/size/anchor/rotation/door/light
// settings).
//
// Decal and paint lookups are indexed per chunk once per World revision
// (paintRev/decalRev) and cached, so a streaming burst of snapshot requests
// does not re-scan the whole paint map per chunk.

const VOX_MARGIN = 2;
const LIGHT_MARGIN = 5;

/** Per-world cached chunk indices of decals/paint, keyed by revision. */
const indexCache = new WeakMap();

function chunkBuckets(world, entries) {
  const s = world.chunkSize;
  const buckets = new Map();
  for (const e of entries) {
    const k = `${Math.floor(e[0] / s)},${Math.floor(e[1] / s)},${Math.floor(e[2] / s)}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, b = []);
    b.push(e);
  }
  return buckets;
}

function decalIndex(world) {
  let c = indexCache.get(world);
  if (!c) indexCache.set(world, c = {});
  if (c.decalRev !== world.decalRev) {
    const entries = [];
    for (const [k, d] of world.decals) {
      const p = k.split(',');
      entries.push([Number(p[0]), Number(p[1]), Number(p[2]), p[3], d]);
    }
    c.decals = chunkBuckets(world, entries);
    c.decalRev = world.decalRev;
  }
  return c.decals;
}

function paintIndex(world) {
  let c = indexCache.get(world);
  if (!c) indexCache.set(world, c = {});
  if (c.paintRev !== world.paintRev) {
    const entries = [];
    for (const [k, rec] of world.paint) {
      const p = k.split(',');
      entries.push([Number(p[0]), Number(p[1]), Number(p[2]), rec]);
    }
    c.paint = chunkBuckets(world, entries);
    c.paintRev = world.paintRev;
  }
  return c.paint;
}

/** Entries from a chunk-bucket index that fall inside a cell box. */
function gatherInBox(world, buckets, min, max) {
  const s = world.chunkSize;
  const out = [];
  for (let cx = Math.floor(min[0] / s); cx <= Math.floor(max[0] / s); cx++)
    for (let cy = Math.floor(min[1] / s); cy <= Math.floor(max[1] / s); cy++)
      for (let cz = Math.floor(min[2] / s); cz <= Math.floor(max[2] / s); cz++) {
        const b = buckets.get(`${cx},${cy},${cz}`);
        if (!b) continue;
        for (const e of b) {
          if (
            e[0] >= min[0] && e[0] <= max[0]
            && e[1] >= min[1] && e[1] <= max[1]
            && e[2] >= min[2] && e[2] <= max[2]
          ) out.push(e);
        }
      }
  return out;
}

/**
 * Capture one chunk's meshing inputs as transferable plain data.
 * @param {import('./World.js').World} world
 * @param {object|null} lightField
 * @param {[number,number,number]} origin chunk min cell coords
 * @param {number} size chunk edge length in cells
 */
export function makeChunkSnapshot(world, lightField, origin, size) {
  const [ox, oy, oz] = origin;
  const vs = size + 2 * VOX_MARGIN;
  const vox = new Uint16Array(vs * vs * vs);
  const palette = [];
  const seen = new Map();
  let i = 0;
  for (let x = ox - VOX_MARGIN; x < ox + size + VOX_MARGIN; x++)
    for (let y = oy - VOX_MARGIN; y < oy + size + VOX_MARGIN; y++)
      for (let z = oz - VOX_MARGIN; z < oz + size + VOX_MARGIN; z++, i++) {
        const v = world.get(x, y, z);
        if (!v) continue;
        let id = seen.get(v);
        if (id == null) {
          id = palette.push(v);
          seen.set(v, id);
        }
        vox[i] = id;
      }

  let light = null;
  if (lightField) {
    const lsz = size + 2 * LIGHT_MARGIN;
    light = new Uint8Array(lsz * lsz * lsz);
    const r = lightField.region;
    let j = 0;
    for (let x = ox - LIGHT_MARGIN; x < ox + size + LIGHT_MARGIN; x++)
      for (let y = oy - LIGHT_MARGIN; y < oy + size + LIGHT_MARGIN; y++)
        for (let z = oz - LIGHT_MARGIN; z < oz + size + LIGHT_MARGIN; z++, j++) {
          if (
            !r
            || x < r.min[0] || x > r.max[0]
            || y < r.min[1] || y > r.max[1]
            || z < r.min[2] || z > r.max[2]
          ) continue; // out-of-region light reads are dark
          light[j] = (lightField.skyAt(x, y, z) << 4) | lightField.blockAt(x, y, z);
        }
  }

  const boxMin = [ox - VOX_MARGIN, oy - VOX_MARGIN, oz - VOX_MARGIN];
  const boxMax = [ox + size + VOX_MARGIN - 1, oy + size + VOX_MARGIN - 1, oz + size + VOX_MARGIN - 1];
  const decals = world.decals?.size ? gatherInBox(world, decalIndex(world), boxMin, boxMax) : [];
  const paint = world.paintCount > 0 ? gatherInBox(world, paintIndex(world), boxMin, boxMax) : [];

  return { origin, size, vox, palette, light, decals, paint, paintCount: world.paintCount };
}

/**
 * Rebuild world-like and lightField-like stubs from a snapshot — exactly the
 * interface buildChunkMesh consumes. Pure; runs in the worker or in tests.
 */
export function snapshotStubs(snap) {
  const { origin: [ox, oy, oz], size } = snap;
  const vs = size + 2 * VOX_MARGIN;
  const vx0 = ox - VOX_MARGIN, vy0 = oy - VOX_MARGIN, vz0 = oz - VOX_MARGIN;
  const decalMap = new Map(snap.decals.map(([x, y, z, f, d]) => [`${x},${y},${z},${f}`, d]));
  const paintMap = new Map(snap.paint.map(([x, y, z, rec]) => [`${x},${y},${z}`, rec]));

  const world = {
    paintCount: snap.paintCount,
    get(x, y, z) {
      const lx = x - vx0, ly = y - vy0, lz = z - vz0;
      if (lx < 0 || ly < 0 || lz < 0 || lx >= vs || ly >= vs || lz >= vs) return null;
      const id = snap.vox[(lx * vs + ly) * vs + lz];
      return id ? snap.palette[id - 1] : null;
    },
    decalAt: (x, y, z, face) => decalMap.get(`${x},${y},${z},${face}`) ?? null,
    paintFor: (x, y, z) => paintMap.get(`${x},${y},${z}`) ?? null,
  };

  let light = null;
  if (snap.light) {
    const lsz = size + 2 * LIGHT_MARGIN;
    const lx0 = ox - LIGHT_MARGIN, ly0 = oy - LIGHT_MARGIN, lz0 = oz - LIGHT_MARGIN;
    const idx = (x, y, z) => {
      const lx = x - lx0, ly = y - ly0, lz = z - lz0;
      if (lx < 0 || ly < 0 || lz < 0 || lx >= lsz || ly >= lsz || lz >= lsz) return -1;
      return (lx * lsz + ly) * lsz + lz;
    };
    light = {
      skyAt(x, y, z) {
        const i = idx(x, y, z);
        return i < 0 ? 0 : snap.light[i] >> 4;
      },
      blockAt(x, y, z) {
        const i = idx(x, y, z);
        return i < 0 ? 0 : snap.light[i] & 0xf;
      },
    };
  }

  return { world, light };
}
