// Compare the two world files + locate estate details (doors, terrain, facade).
import { readFileSync, statSync } from 'node:fs';

for (const f of ['map/voxelbundle.json', 'map/worlds/start.json']) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  const m = d.format === 'voxelbundle' ? d.map : d;
  const c = {};
  for (const b of m.blocks) c[b.type] = (c[b.type] || 0) + 1;
  const st = statSync(f);
  console.log(f, 'mtime:', st.mtime.toISOString(), 'blocks:', m.blocks.length, 'panel:', c.panel || 0, 'spawn:', m.spawn, 'yaw:', m.spawnYaw, 'items:', (m.items || []).length, 'decals:', (m.decals || []).length, 'mobs:', (m.mobs || []).length);
}

// Detail pass on the library world (the one we'll edit)
const d = JSON.parse(readFileSync('map/worlds/start.json', 'utf8'));
const m = d.map;
const blocks = m.blocks;
const at = (x, y, z) => blocks.filter((b) => b.x === x && b.y === y && b.z === z);

console.log('\n--- door_blok / sidelight ---');
for (const b of blocks) if (b.type === 'door_blok' || b.type === 'sidelight') console.log(b);

console.log('\n--- domofon decal + all decals positions ---');
for (const dec of m.decals || []) console.log(dec.id, 'at', dec.x, dec.y, dec.z, 'face', dec.face);

console.log('\n--- terrain height near building (grass columns, sample) ---');
const grass = blocks.filter((b) => b.type === 'grass');
const ys = {};
for (const g of grass) ys[g.y] = (ys[g.y] || 0) + 1;
console.log('grass y histogram:', ys);

// ground extent
let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
for (const g of grass) { minX = Math.min(minX, g.x); maxX = Math.max(maxX, g.x); minZ = Math.min(minZ, g.z); maxZ = Math.max(maxZ, g.z); }
console.log('grass extent:', { minX, maxX, minZ, maxZ });

// facade slice of the panel building: sample types along z at various y for x=-20
console.log('\n--- facade slices of panel building (x=-20 column range) ---');
const panelSet = new Set(blocks.filter((b) => b.type === 'panel').map((b) => `${b.x},${b.y},${b.z}`));
for (const y of [0, 2, 4, 6, 10, 14, 20, 26]) {
  let row = '';
  for (let z = -4; z <= 26; z++) {
    const hits = blocks.filter((b) => b.x >= -22 && b.x <= -18 && b.y === y && b.z === z);
    row += hits.length ? (hits[0].type === 'panel' ? '#' : hits[0].type.slice(0, 1)) : '.';
  }
  console.log(`y=${String(y).padStart(2)} ${row}`);
}

// top view at several heights restricted to building + surroundings
for (const y of [1, 3, 9, 27]) {
  console.log(`\n--- top view y=${y} (x:-52..36 step2, z:-8..44 step2) ---`);
  const grid = new Map();
  for (const b of blocks) {
    if (b.y !== y && !(b.size === 'big' && b.y + 1 === y)) continue;
    const k = `${Math.floor(b.x / 2) * 2},${Math.floor(b.z / 2) * 2}`;
    grid.set(k, b.type);
  }
  for (let z = -8; z <= 44; z += 2) {
    let row = '';
    for (let x = -52; x <= 36; x += 2) {
      const t = grid.get(`${x},${z}`);
      row += !t ? '.' : t === 'grass' ? ',' : t === 'panel' ? '#' : t.startsWith('window') ? 'W' : t.startsWith('door') ? 'D' : t.startsWith('plaster') ? 'p' : t === 'paving' ? '=' : t === 'lastryko' ? 'l' : t === 'wood' || t.startsWith('wood') || t.startsWith('planks') ? 'w' : '*';
    }
    console.log(`z=${String(z).padStart(3)} ${row}`);
  }
}
