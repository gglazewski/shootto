// make_kiosk_prefab.mjs — author the "Kiosk Ruchu '94" prefab.
//
// A classic mid-90s Polish street kiosk (kiosk Ruchu): dark pressed-metal
// panels on a concrete plinth, a wraparound window band over the counter,
// an overhanging corrugated-steel roof floating on a shadow gap, a steel
// service door in the back and a painted RUCH sign over the front glass.
// Newspapers went over the counter ledge; the interior gets its shelf,
// counter and ceiling lamp so the kiosk reads right through the glass.
//
// Emits exactly the voxelprefab v1 format the editor's prefab library reads,
// straight into map/prefabs/ — open it with Prefabs → Edit to polish, or
// Prefabs → card click to stamp it into a world.
//
//   node tools/make_kiosk_prefab.mjs
//
// Volume [9, 8, 7] cells (4.5 × 4 × 3.5 m); body x1..7, z1..5, front at +z.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const blocks = [];
const put = (x, y, z, type, extra = {}) => blocks.push({ x, y, z, size: 'small', type, ...extra });

const X0 = 1, X1 = 7; // body west/east walls
const Z0 = 1, Z1 = 5; // body back/front walls
const DOOR_X = 3;     // steel door anchor (spans x3..4, y1..4) in the back wall

// --- concrete plinth (y0) ---
for (let x = X0; x <= X1; x++) for (let z = Z0; z <= Z1; z++) put(x, 0, z, 'concrete');

// --- panel walls (y1..y2), door opening in the back ---
for (let y = 1; y <= 2; y++) {
  for (let x = X0; x <= X1; x++) {
    if (!(x >= DOOR_X && x <= DOOR_X + 1)) put(x, y, Z0, 'kiosk'); // back (door gap)
    put(x, y, Z1, 'kiosk'); // front (solid up to the counter)
  }
  for (let z = Z0 + 1; z <= Z1 - 1; z++) {
    put(X0, y, z, 'kiosk');
    put(X1, y, z, 'kiosk');
  }
}

// --- window band (y3..y4): glass all around, panel corner posts ---
for (let y = 3; y <= 4; y++) {
  put(X0, y, Z0, 'kiosk');
  put(X1, y, Z0, 'kiosk');
  put(X0, y, Z1, 'kiosk');
  put(X1, y, Z1, 'kiosk');
  for (let x = X0 + 1; x <= X1 - 1; x++) {
    put(x, y, Z1, 'glass'); // front: pane along x (rotation 0)
    if (!(x >= DOOR_X && x <= DOOR_X + 1)) put(x, y, Z0, 'kiosk'); // back stays solid
  }
  for (let z = Z0 + 1; z <= Z1 - 1; z++) {
    put(X0, y, z, 'glass', { rotation: 1 }); // sides: pane along z
    put(X1, y, z, 'glass', { rotation: 1 });
  }
}

// --- steel service door in the back (2 × 4 cells = 1 × 2 m) ---
blocks.push({ x: DOOR_X, y: 1, z: Z0, size: 'door', type: 'door_steel' });

// --- fascia + ceiling slab (y5) ---
for (let x = X0; x <= X1; x++) for (let z = Z0; z <= Z1; z++) put(x, 5, z, 'kiosk');

// --- corrugated roof (y6): 1-cell overhang, floating on a shadow gap ---
for (let x = 0; x <= 8; x++) for (let z = 0; z <= 6; z++) put(x, 6, z, 'blacha', { variant: 'upper' });

// --- roof vent (y7) ---
put(2, 7, 2, 'metal');

// --- counter ledge outside the front glass (newspapers went here) ---
for (let x = X0 + 1; x <= X1 - 1; x++) put(x, 2, Z1 + 1, 'wood_dark', { variant: 'upper' });

// --- interior: counter, newspaper shelf, ceiling lamp ---
for (let x = X0 + 1; x <= X1 - 1; x++) {
  put(x, 2, Z1 - 1, 'wood_dark', { variant: 'upper' }); // inner counter
  put(x, 3, Z0 + 1, 'planks'); // press shelf on the back wall
}
put(4, 4, 3, 'lamp');

// --- painted RUCH sign over the front glass (fascia, faces +z) ---
const sign = {
  id: 'decal_text_ruch94',
  text: 'RUCH',
  fg: '#f2ecd9',
  bg: '#245c38',
  height: 1,
  width: 3,
};
const decals = [
  { id: sign.id, x: 3, y: 5, z: Z1, face: 'pz' },
];

const prefab = {
  format: 'voxelprefab',
  version: 1,
  id: 'kiosk_ruchu_94',
  name: "Kiosk Ruchu '94",
  cellSize: 0.5,
  dims: [9, 8, 7],
  blocks,
  items: [],
  decals,
  textDecals: [sign],
};

const out = join(ROOT, 'map', 'prefabs', 'kiosk_ruchu_94.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(prefab));
console.log(`wrote ${out}: ${blocks.length} blocks, ${decals.length} decal(s)`);
