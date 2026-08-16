// Materials.js — built-in stackable repair materials.
//
// Materials are equip-registry entries with kind 'material': they drop from
// mobs (see GameApp._dropLoot), place in the world like any equippable item,
// and picking one up adds to the player's material counts (PlayerStats
// .materials) instead of taking an equipment slot. Repairing a weapon at an
// NPC consumes them (see REPAIR_COST / GameApp._repairFix).
//
// Like QuestItems, built-ins are code, not authored content — they register
// before the author's saved registry loads so a re-skin under the same id
// wins, and serializeEquipRegistry skips them. Pure module (no three.js/DOM).

import { registerEquipItem, getEquipItem } from './EquipmentRegistry.js';

/** What one repair consumes: one adhesive (duck tape or glue, whichever the
 *  player has) plus this many scrap pieces of any sort. */
export const REPAIR_COST = Object.freeze({ adhesive: 1, scrap: 2 });

/** Fraction of a weapon's BASE durability permanently lost per repair (at
 *  least 1 point) — patched-up weapons cap lower each time, so breaking for
 *  good is inevitable. */
export const REPAIR_DECAY_FRACTION = 0.25;

/** Ids the repair cost draws from, in spend order. */
export const ADHESIVE_IDS = Object.freeze(['duck-tape', 'glue']);
export const SCRAP_IDS = Object.freeze(['scrap-metal', 'scrap-wood', 'scrap-glass']);

/** Most one stack of a material holds (backpack grid display). */
export const MATERIAL_STACK = 16;

const put = (out, x, y, z, color) => out.push({ x, y, z, color: [...color] });

/** A fat silver ring of tape, lying flat, with a peeled tab. */
function duckTapeVoxels() {
  const silver = [176, 180, 186];
  const dark = [120, 124, 130];
  const out = [];
  for (let x = 1; x <= 6; x++) {
    for (let z = 1; z <= 6; z++) {
      const edge = x === 1 || x === 6 || z === 1 || z === 6;
      const corner = (x === 1 || x === 6) && (z === 1 || z === 6);
      const hole = x >= 3 && x <= 4 && z >= 3 && z <= 4;
      if (corner || hole) continue;
      for (let y = 0; y <= 2; y++) put(out, x, y, z, edge && y === 1 ? dark : silver);
    }
  }
  put(out, 6, 2, 3, dark); // peeled tab
  put(out, 7, 2, 3, dark);
  return out;
}

/** A white glue bottle with an orange twist nozzle. */
function glueVoxels() {
  const white = [235, 235, 228];
  const orange = [226, 138, 54];
  const out = [];
  for (let y = 0; y <= 3; y++) {
    for (let x = 2; x <= 5; x++) {
      for (let z = 2; z <= 5; z++) {
        const corner = (x === 2 || x === 5) && (z === 2 || z === 5);
        if (corner && (y === 0 || y === 3)) continue;
        put(out, x, y, z, white);
      }
    }
  }
  for (let x = 3; x <= 4; x++) for (let z = 3; z <= 4; z++) put(out, x, 4, z, orange);
  put(out, 3, 5, 3, orange); // nozzle tip
  return out;
}

/** A small pile of splintered planks. */
function scrapWoodVoxels() {
  const brown = [138, 100, 60];
  const dark = [104, 74, 44];
  const out = [];
  for (let x = 0; x <= 6; x++) put(out, x, 0, 2, brown);          // long plank
  for (let x = 1; x <= 7; x++) put(out, x, 0, 4, dark);           // second plank
  for (let x = 2; x <= 5; x++) put(out, x, 1, 3, brown);          // stacked stub
  put(out, 3, 2, 3, dark);                                        // splinter on top
  put(out, 6, 1, 4, dark);
  return out;
}

/** Jagged pale-blue shards. */
function scrapGlassVoxels() {
  const glass = [168, 208, 222];
  const bright = [214, 238, 246];
  const out = [];
  // Three shards of falling height.
  for (const [bx, bz, h] of [[1, 2, 3], [4, 4, 2], [6, 1, 1]]) {
    for (let y = 0; y < h; y++) put(out, bx, y, bz, y === h - 1 ? bright : glass);
  }
  put(out, 2, 0, 4, glass);
  put(out, 3, 0, 1, bright);
  put(out, 5, 0, 2, glass);
  return out;
}

/** A bent rusty plate with rivets. */
function scrapMetalVoxels() {
  const steel = [130, 134, 140];
  const rust = [150, 92, 58];
  const out = [];
  for (let x = 1; x <= 6; x++) {
    for (let z = 2; z <= 5; z++) {
      const y = x >= 5 ? 1 : 0; // plate bends up at one end
      put(out, x, y, z, (x + z) % 4 === 0 ? rust : steel);
    }
  }
  put(out, 2, 1, 3, steel); // rivets
  put(out, 4, 1, 4, rust);
  return out;
}

export const BUILTIN_MATERIALS = Object.freeze([
  { id: 'duck-tape', name: 'Duck Tape', voxels: duckTapeVoxels },
  { id: 'glue', name: 'Glue', voxels: glueVoxels },
  { id: 'scrap-wood', name: 'Scrap Wood', voxels: scrapWoodVoxels },
  { id: 'scrap-glass', name: 'Scrap Glass', voxels: scrapGlassVoxels },
  { id: 'scrap-metal', name: 'Scrap Metal', voxels: scrapMetalVoxels },
].map((m) => Object.freeze({
  id: m.id,
  name: m.name,
  kind: 'material',
  builtin: true,
  grid: [8, 8, 8],
  microVoxels: m.voxels(),
  grip: null,
  grip2: null,
  yaw: 0,
})));

export const MATERIAL_IDS = Object.freeze(BUILTIN_MATERIALS.map((m) => m.id));

/** True when an id names a registered material item. */
export function isMaterialId(id) {
  return getEquipItem(id)?.kind === 'material';
}

/** Register every built-in material (idempotent). Call before loading the
 *  author's saved equip registry so authored overrides win. */
export function registerBuiltinMaterials() {
  for (const def of BUILTIN_MATERIALS) registerEquipItem(def);
}
