// One-off analysis of map/worlds/start.json: locate estate-like structures.
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../map/worlds/start.json', import.meta.url), 'utf8'));
const map = data.format === 'voxelbundle' ? data.map : data;
const blocks = map.blocks;
console.log('total blocks:', blocks.length, 'spawn:', map.spawn, 'yaw:', map.spawnYaw);

const estateTypes = new Set(['panel', 'plaster_pastel', 'plaster_yellow', 'plaster_orange', 'plaster_green', 'plaster_blue', 'lastryko', 'window_white', 'balcony_rail', 'door_blok', 'sidelight', 'papa', 'paving', 'brick_sooty', 'brick_yellow', 'lino', 'blacha', 'kiosk', 'garage_brown', 'garage_green', 'garage_red']);

const byType = {};
for (const b of blocks) byType[b.type] = (byType[b.type] || 0) + 1;
const interesting = Object.entries(byType).filter(([t]) => estateTypes.has(t)).sort((a, b) => b[1] - a[1]);
console.log('estate block counts:', interesting);

// Bounding boxes per estate type cluster: collect voxels, cluster by xz proximity.
const pts = blocks.filter((b) => estateTypes.has(b.type));
console.log('estate voxels:', pts.length);
if (pts.length) {
  // coarse grid clustering: 1m cells
  const cells = new Map();
  for (const p of pts) {
    const k = `${Math.floor(p.x / 2)}|${Math.floor(p.z / 2)}`;
    if (!cells.has(k)) cells.set(k, { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, minZ: 1e9, maxZ: -1e9, n: 0, types: {} });
    const c = cells.get(k);
    c.minX = Math.min(c.minX, p.x); c.maxX = Math.max(c.maxX, p.x);
    c.minY = Math.min(c.minY, p.y); c.maxY = Math.max(c.maxY, p.y);
    c.minZ = Math.min(c.minZ, p.z); c.maxZ = Math.max(c.maxZ, p.z);
    c.n++; c.types[p.type] = (c.types[p.type] || 0) + 1;
  }
  // merge overlapping coarse cells into clusters
  const arr = [...cells.entries()];
  const clusters = [];
  const used = new Set();
  for (let i = 0; i < arr.length; i++) {
    if (used.has(i)) continue;
    const stack = [i]; used.add(i);
    const cl = { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, minZ: 1e9, maxZ: -1e9, n: 0, cells: 0 };
    while (stack.length) {
      const j = stack.pop();
      const c = arr[j][1];
      cl.minX = Math.min(cl.minX, c.minX); cl.maxX = Math.max(cl.maxX, c.maxX);
      cl.minY = Math.min(cl.minY, c.minY); cl.maxY = Math.max(cl.maxY, c.maxY);
      cl.minZ = Math.min(cl.minZ, c.minZ); cl.maxZ = Math.max(cl.maxZ, c.maxZ);
      cl.n += c.n; cl.cells++;
      for (let k = 0; k < arr.length; k++) {
        if (used.has(k)) continue;
        const o = arr[k][1];
        if (Math.abs((c.minX + c.maxX) / 2 - (o.minX + o.maxX) / 2) < 6 &&
            Math.abs((c.minZ + c.maxZ) / 2 - (o.minZ + o.maxZ) / 2) < 6) {
          used.add(k); stack.push(k);
        }
      }
    }
    clusters.push(cl);
  }
  clusters.sort((a, b) => b.n - a.n);
  for (const cl of clusters.slice(0, 12)) {
    console.log(`cluster: voxels=${cl.n} x:[${cl.minX},${cl.maxX}] y:[${cl.minY},${cl.maxY}] z:[${cl.minZ},${cl.maxZ}] size=(${cl.maxX - cl.minX + 1},${cl.maxY - cl.minY + 1},${cl.maxZ - cl.minZ + 1})`);
  }
}

// panel-only bounding boxes (commie block detection)
{
  const panels = blocks.filter((b) => b.type === 'panel');
  const cells = new Map();
  for (const p of panels) {
    const k = `${Math.floor(p.x / 2)}|${Math.floor(p.z / 2)}`;
    if (!cells.has(k)) cells.set(k, { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, minZ: 1e9, maxZ: -1e9, n: 0 });
    const c = cells.get(k);
    c.minX = Math.min(c.minX, p.x); c.maxX = Math.max(c.maxX, p.x);
    c.minY = Math.min(c.minY, p.y); c.maxY = Math.max(c.maxY, p.y);
    c.minZ = Math.min(c.minZ, p.z); c.maxZ = Math.max(c.maxZ, p.z);
    c.n++;
  }
  const arr = [...cells.entries()];
  const used = new Set();
  const clusters = [];
  for (let i = 0; i < arr.length; i++) {
    if (used.has(i)) continue;
    const stack = [i]; used.add(i);
    const cl = { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, minZ: 1e9, maxZ: -1e9, n: 0 };
    while (stack.length) {
      const j = stack.pop();
      const c = arr[j][1];
      cl.minX = Math.min(cl.minX, c.minX); cl.maxX = Math.max(cl.maxX, c.maxX);
      cl.minY = Math.min(cl.minY, c.minY); cl.maxY = Math.max(cl.maxY, c.maxY);
      cl.minZ = Math.min(cl.minZ, c.minZ); cl.maxZ = Math.max(cl.maxZ, c.maxZ);
      cl.n += c.n;
      for (let k = 0; k < arr.length; k++) {
        if (used.has(k)) continue;
        const o = arr[k][1];
        if (Math.abs((c.minX + c.maxX) / 2 - (o.minX + o.maxX) / 2) < 4 &&
            Math.abs((c.minZ + c.maxZ) / 2 - (o.minZ + o.maxZ) / 2) < 4) {
          used.add(k); stack.push(k);
        }
      }
    }
    clusters.push(cl);
  }
  clusters.sort((a, b) => b.n - a.n);
  console.log('--- panel clusters ---');
  for (const cl of clusters.slice(0, 8)) {
    console.log(`panel: n=${cl.n} x:[${cl.minX},${cl.maxX}] y:[${cl.minY},${cl.maxY}] z:[${cl.minZ},${cl.maxZ}] size=(${cl.maxX - cl.minX + 1},${cl.maxY - cl.minY + 1},${cl.maxZ - cl.minZ + 1})`);
  }
}

// top-down density map of estate voxels over the main cluster area
{
  const grid = new Map();
  for (const p of pts) {
    if (p.x < -50 || p.x > 40 || p.z < -10 || p.z > 40) continue;
    const k = `${Math.floor(p.x / 2) * 2},${Math.floor(p.z / 2) * 2}`;
    grid.set(k, (grid.get(k) || 0) + 1);
  }
  const xs = [...grid.keys()].map((k) => +k.split(',')[0]);
  const zs = [...grid.keys()].map((k) => +k.split(',')[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  console.log(`--- density (2m cells) x:[${minX},${maxX}] z:[${minZ},${maxZ}] ---`);
  for (let z = minZ; z <= maxZ; z += 2) {
    let row = '';
    for (let x = minX; x <= maxX; x += 2) {
      const n = grid.get(`${x},${z}`) || 0;
      row += n === 0 ? '.' : n > 40 ? '#' : n > 15 ? '+' : '-';
    }
    console.log(`z=${String(z).padStart(3)} ${row}`);
  }
}

// items / decals / mobs in the map
console.log('items:', (map.items || []).map((i) => i.itemId).reduce((m, t) => (m[t] = (m[t] || 0) + 1, m), {}));
console.log('decals:', (map.decals || []).map((d) => d.id).slice(0, 20));
console.log('mobs:', (map.mobs || []).length, 'npcs:', (map.npcs || []).map((n) => n.type));
