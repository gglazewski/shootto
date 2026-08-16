// Craftables.js — built-in craftable items (see engine/Crafting.js).
//
// Craftables are equip-registry entries the player can make from repair
// materials at a workbench: melee weapons, armor vests and one-use healing
// consumables. Like Materials and QuestItems they are code, not authored
// content — they register before the author's saved registry loads so a
// re-skin under the same id wins, and serializeEquipRegistry skips them.
//
// Healing items are kind 'consumable': they prefer the injection slot and
// `F` uses them (their `consumable` pack says how much they heal). Armor
// vests are kind 'armor' — crafting one straps it on straight away (armor
// points, like a pickup). Pure module (no three.js/DOM).

import { registerEquipItem } from './EquipmentRegistry.js';

const put = (out, x, y, z, color) => out.push({ x, y, z, color: [...color] });

/** A rolled cloth bandage with its tail unrolling to the floor. */
function bandageVoxels() {
  const white = [238, 234, 224];
  const shade = [204, 198, 184];
  const out = [];
  // The roll: a squarish ring standing on its side.
  for (let x = 2; x <= 5; x++) {
    for (let z = 2; z <= 5; z++) {
      const edge = x === 2 || x === 5 || z === 2 || z === 5;
      const hole = x >= 3 && x <= 4 && z >= 3 && z <= 4;
      if (hole) continue;
      for (let y = 0; y <= 3; y++) put(out, x, y, z, edge ? shade : white);
    }
  }
  // The unrolling tail.
  put(out, 3, 0, 6, white);
  put(out, 4, 0, 6, shade);
  put(out, 3, 0, 7, white);
  return out;
}

/** A white first-aid box with a red cross on the lid and a red latch. */
function firstAidVoxels() {
  const white = [232, 230, 222];
  const dark = [198, 194, 184];
  const red = [206, 48, 40];
  const out = [];
  for (let y = 0; y <= 3; y++) {
    for (let x = 1; x <= 6; x++) {
      for (let z = 1; z <= 6; z++) {
        const corner = (x === 1 || x === 6) && (z === 1 || z === 6);
        if (corner && y === 3) continue; // rounded lid
        put(out, x, y, z, y === 0 ? dark : white);
      }
    }
  }
  // Red cross on the lid.
  for (let x = 2; x <= 5; x++) put(out, x, 4, 3, red), put(out, x, 4, 4, red);
  for (let z = 2; z <= 5; z++) put(out, 3, 4, z, red), put(out, 4, 4, z, red);
  // Latch on the front face.
  put(out, 3, 2, 0, red);
  put(out, 4, 2, 0, red);
  return out;
}

/** A red trauma case — taller, a white cross and a blocky carry handle. */
function traumaKitVoxels() {
  const red = [188, 42, 38];
  const redDark = [148, 30, 28];
  const white = [236, 234, 226];
  const out = [];
  for (let y = 0; y <= 4; y++) {
    for (let x = 1; x <= 6; x++) {
      for (let z = 1; z <= 6; z++) {
        const corner = (x === 1 || x === 6) && (z === 1 || z === 6);
        if (corner && (y === 0 || y === 4)) continue;
        put(out, x, y, z, y === 0 ? redDark : red);
      }
    }
  }
  // White cross on the lid.
  for (let x = 2; x <= 5; x++) put(out, x, 5, 3, white), put(out, x, 5, 4, white);
  for (let z = 2; z <= 5; z++) put(out, 3, 5, z, white), put(out, 4, 5, z, white);
  // Carry handle.
  for (const [x, z] of [[3, 3], [4, 3], [3, 4], [4, 4]]) put(out, x, 6, z, white);
  return out;
}

/** A glass shard ground to a point, edge honed bright, tape-wrapped handle. */
function shivVoxels() {
  const glass = [186, 216, 230];
  const bright = [226, 242, 248];
  const tape = [148, 150, 156];
  const dark = [108, 110, 116];
  const out = [];
  // Handle: taped grip, y0..y2.
  for (let y = 0; y <= 2; y++) {
    for (const [x, z] of [[3, 3], [4, 3], [3, 4], [4, 4]]) put(out, x, y, z, y === 1 ? dark : tape);
  }
  // Guard: a wider tape band where blade meets handle.
  for (let x = 2; x <= 5; x++) put(out, x, 3, 3, tape), put(out, x, 3, 4, tape);
  // Blade: 2×2 section rising to a chiselled point.
  for (let y = 4; y <= 10; y++) {
    for (const [x, z] of [[3, 3], [4, 3], [3, 4], [4, 4]]) {
      put(out, x, y, z, x === 3 ? bright : glass); // one honed edge catches the light
    }
  }
  put(out, 3, 11, 3, bright);
  put(out, 3, 11, 4, glass);
  put(out, 4, 11, 3, glass);
  return out;
}

/** A lumber plank with nails driven through the swinging end, taped grip. */
function plankClubVoxels() {
  const wood = [150, 108, 62];
  const woodDark = [116, 82, 46];
  const tape = [148, 150, 156];
  const nail = [202, 204, 210];
  const out = [];
  // The timber: 2×2 plank running the volume's length.
  for (let z = 1; z <= 13; z++) {
    for (let x = 3; x <= 4; x++) {
      for (let y = 3; y <= 5; y++) {
        put(out, x, y, z, z % 5 === 0 && y === 3 ? woodDark : wood); // grain knots
      }
    }
  }
  // Taped grip at the holding end.
  for (let z = 1; z <= 4; z++) {
    for (let x = 3; x <= 4; x++) {
      for (let y = 3; y <= 5; y++) put(out, x, y, z, z === 2 || z === 4 ? tape : wood);
    }
  }
  // Nails punched through near the business end.
  for (const [x, z] of [[2, 7], [5, 7], [2, 10], [5, 9], [2, 12], [5, 12]]) put(out, x, 4, z, nail);
  return out;
}

/** A rebar rod with a file-ground tip and tape wraps for both hands. */
function rebarSpearVoxels() {
  const steel = [110, 112, 118];
  const rust = [140, 88, 56];
  const tape = [148, 150, 156];
  const tip = [204, 210, 218];
  const out = [];
  // Twin bars read as a thicker rod; rust patches break it up.
  for (let z = 0; z <= 22; z++) {
    put(out, 3, 4, z, z % 4 === 1 ? rust : steel);
    put(out, 4, 4, z, z % 4 === 3 ? rust : steel);
  }
  // Ground point.
  put(out, 3, 4, 23, tip);
  put(out, 4, 4, 23, tip);
  // Rear grip wrap (with a bulge for the heel of the hand).
  for (let z = 2; z <= 5; z++) {
    put(out, 3, 4, z, tape);
    put(out, 4, 4, z, tape);
    put(out, 3, 5, z, tape);
  }
  // Forward wrap for the off hand.
  for (let z = 10; z <= 11; z++) {
    put(out, 3, 4, z, tape);
    put(out, 4, 4, z, tape);
  }
  return out;
}

/** A bent chest plate hung on leather straps — patchy rust, side buckles. */
function scrapVestVoxels() {
  const steel = [126, 130, 136];
  const rust = [148, 94, 58];
  const strap = [70, 54, 38];
  const out = [];
  // Chest plate (with a belly bulge so it reads as worn, not flat).
  for (let y = 3; y <= 11; y++) {
    for (let x = 2; x <= 5; x++) {
      put(out, x, y, 5, (x + y) % 4 === 0 ? rust : steel);
      if (y >= 5 && y <= 9) put(out, x, y, 6, steel);
    }
  }
  // Shoulder straps over the top.
  for (const x of [2, 5]) {
    for (let z = 2; z <= 5; z++) put(out, x, 12, z, strap);
  }
  put(out, 2, 11, 2, strap);
  put(out, 5, 11, 2, strap);
  // Side straps.
  for (let y = 4; y <= 10; y += 2) {
    put(out, 1, y, 3, strap);
    put(out, 6, y, 3, strap);
  }
  return out;
}

/** Layered steel plates with riveted tops — the workbench version. */
function plateVestVoxels() {
  const plate = [158, 164, 172];
  const plateDark = [120, 126, 134];
  const rivet = [205, 210, 218];
  const strap = [60, 46, 34];
  const out = [];
  // Three overlapping plates, each a little shorter than the last.
  for (let row = 0; row < 3; row++) {
    const y0 = 3 + row * 3;
    const y1 = y0 + 2 - (row === 2 ? 1 : 0);
    for (let y = y0; y <= y1; y++) {
      for (let x = 2; x <= 5; x++) put(out, x, y, 5, y === y1 ? plateDark : plate);
    }
    put(out, 2, y1, 6, rivet); // rivets pin each plate's top edge
    put(out, 5, y1, 6, rivet);
  }
  // Collar + shoulder straps.
  for (let x = 2; x <= 5; x++) put(out, x, 12, 4, plateDark);
  for (const x of [2, 5]) {
    for (let z = 3; z <= 5; z++) put(out, x, 12, z, strap);
  }
  put(out, 2, 11, 2, strap);
  put(out, 5, 11, 2, strap);
  return out;
}

/** @returns {object} a registered-shape equip def for a craftable. */
function craftable({ id, name, grid = [8, 8, 8], voxels, kind = 'weapon', stats = null, weapon = null, grip = null, grip2 = null, armor = null, consumable = null }) {
  return {
    id,
    name,
    kind,
    builtin: true,
    grid: [...grid],
    microVoxels: voxels(),
    grip,
    grip2,
    yaw: 0,
    stats: stats ?? {},
    weapon: weapon ?? {},
    ammo: {},
    armor: armor ?? {},
    consumable: consumable ?? {},
  };
}

export const BUILTIN_CRAFTABLES = Object.freeze([
  craftable({
    id: 'bandage', name: 'Bandage', kind: 'consumable', voxels: bandageVoxels,
    consumable: { health: 20 },
  }),
  craftable({
    id: 'first-aid', name: 'First Aid Kit', kind: 'consumable', voxels: firstAidVoxels,
    consumable: { health: 60 },
  }),
  craftable({
    id: 'trauma-kit', name: 'Trauma Kit', kind: 'consumable', voxels: traumaKitVoxels,
    consumable: { health: 100 },
  }),
  craftable({
    id: 'shiv', name: 'Glass Shiv', kind: 'weapon', voxels: shivVoxels,
    grid: [8, 16, 8],
    stats: { damage: 12, reach: 2, cooldown: 0.25, durability: 15 },
    weapon: { kind: 'melee', hands: 'one', anim: 'stab', orientation: 'vertical' },
    grip: { x: 3, y: 1, z: 3 },
  }),
  craftable({
    id: 'plank-club', name: 'Nailed Plank', kind: 'weapon', voxels: plankClubVoxels,
    grid: [8, 8, 16],
    stats: { damage: 18, reach: 3, cooldown: 0.5, durability: 40 },
    weapon: { kind: 'melee', hands: 'one', anim: 'slash', orientation: 'horizontal' },
    grip: { x: 3, y: 4, z: 2 },
  }),
  craftable({
    id: 'rebar-spear', name: 'Rebar Spear', kind: 'weapon', voxels: rebarSpearVoxels,
    grid: [8, 8, 24],
    stats: { damage: 24, reach: 6, cooldown: 0.65, durability: 60 },
    weapon: { kind: 'melee', hands: 'two', anim: 'stab', orientation: 'horizontal' },
    grip: { x: 3, y: 4, z: 3 },
    grip2: { x: 3, y: 4, z: 10 },
  }),
  craftable({
    id: 'scrap-vest', name: 'Scrap Vest', kind: 'armor', voxels: scrapVestVoxels,
    grid: [8, 16, 8],
    armor: { amount: 40 },
  }),
  craftable({
    id: 'plate-vest', name: 'Plated Vest', kind: 'armor', voxels: plateVestVoxels,
    grid: [8, 16, 8],
    armor: { amount: 75 },
  }),
]);

/** Register every built-in craftable (idempotent). Call before loading the
 *  author's saved equip registry so authored overrides win. */
export function registerBuiltinCraftables() {
  for (const def of BUILTIN_CRAFTABLES) registerEquipItem(def);
}
