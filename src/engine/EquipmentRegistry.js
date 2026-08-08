// EquipmentRegistry.js — data model + registry for equippable items.
//
// An equippable item is a voxel sculpture the player can hold and fight with
// in the game. It is built in a per-item build volume (`grid`, default 8^3,
// up to 32 cells per axis at a fixed 6.25 cm cell size — long guns and axes
// just use a longer volume). In addition to the shape it carries
// gameplay-relevant editor fields:
//   - kind:  what the item is — 'weapon' (held and fought with) or 'ammo'
//            (a resource type a weapon consumes).
//   - grip:  the micro-voxel cell where the player's right hand grips the
//            item; grip2 is the left-hand cell for two-handed weapons,
//   - yaw:   the item's forward/direction angle (degrees about the vertical
//            axis; the F3 editor shows this as an arrow, default +Z).
//   - stats: damage / reach (m) / cooldown (s) used when attacking (weapons).
//   - weapon: a composable attack profile (kind / hands / muzzle / anim /
//            recoil / spread / pellets) — see normalizeWeapon (weapons).
//   - ammo:  the ammo type a pack grants + the amount per pickup (ammo kind).
//
// Separate from the placeable-object ItemRegistry: objects decorate the world,
// equipment is held. Pure module (no three.js/DOM) so it can be unit tested.

export const EQUIP_FORMAT = 'voxelequip';
export const EQUIP_VERSION = 1;

import { isAmmoId } from './AmmoTypes.js';

/** Default attack profile for a new equippable item. */
export const DEFAULT_EQUIP_STATS = Object.freeze({ damage: 10, reach: 2, cooldown: 0.35 });

/** Default ammo-pack fields for an ammo-kind item. */
export const DEFAULT_AMMO = Object.freeze({ type: '', amount: 6 });

/** Attack animations available per weapon kind. */
export const ATTACK_ANIMS = Object.freeze({
  melee: ['punch', 'slash', 'stab'],
  ranged: ['gun'],
});

/** Default composable weapon profile. */
export const DEFAULT_WEAPON = Object.freeze({
  kind: 'melee',
  hands: 'one',
  muzzle: null,
  anim: 'punch',
  recoil: 0.05,
  magazine: 0, // rounds per mag; 0 = no magazine (melee / infinite)
  ammo: '', // ammo type id the gun consumes ('' = none / melee)
  reload: 1.4, // seconds a magazine reload takes (R in the game)
  spread: 0, // radians of random aim wobble (ranged weapons get their own default)
  pellets: 1, // projectiles per shot (shotguns >1); stats.damage applies per pellet
});

/** Default aim spread (radians) for ranged weapons when the profile omits it. */
export const RANGED_SPREAD = 0.02;

// Build-volume limits. The default 8^3 volume matches the classic fixed grid
// (0.5 m at the 6.25 cm equipment cell size); long weapons extend an axis.
export const DEFAULT_EQUIP_GRID = Object.freeze([8, 8, 8]);
export const MIN_EQUIP_GRID = 4;
export const MAX_EQUIP_GRID = 32;

/** Preset build volumes offered by the F3 editor (cells; 1 cell = 6.25 cm). */
export const EQUIP_GRID_PRESETS = Object.freeze([
  { id: 'sidearm', name: 'Sidearm', dims: [8, 8, 8] },      // 0.5 m — pistol, knife
  { id: 'longgun', name: 'Long gun', dims: [8, 8, 16] },    // 1.0 m — shotgun, rifle
  { id: 'spear', name: 'Spear', dims: [8, 8, 24] },         // 1.5 m — spear, pike
  { id: 'axe', name: 'Axe', dims: [8, 16, 8] },             // 1.0 m tall — axe, club
]);

/** Normalize a build volume to integer [gx, gy, gz] within the limits. */
export function normalizeGrid(g) {
  if (!Array.isArray(g) || g.length !== 3) return [...DEFAULT_EQUIP_GRID];
  return g.map((v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(MIN_EQUIP_GRID, Math.min(MAX_EQUIP_GRID, n)) : 8;
  });
}

const REGISTRY = new Map();

/**
 * @typedef {Object} EquipDef
 * @property {string|null} id      unique id (file name / registry key)
 * @property {string} name         human readable name
 * @property {'weapon'|'ammo'} kind what the item is (held weapon or ammo type)
 * @property {{x:number,y:number,z:number,color:[number,number,number]}[]} microVoxels
 * @property {{x:number,y:number,z:number}|null} grip  right-hand grip cell
 * @property {{x:number,y:number,z:number}|null} grip2 left-hand grip cell (two-handed weapons)
 * @property {number} yaw          item forward angle in degrees (0 = +Z)
 * @property {{damage:number,reach:number,cooldown:number}} stats  (weapon)
 * @property {object} weapon       composable attack profile (see normalizeWeapon)
 * @property {{type:string,amount:number}} ammo  ammo pack: type granted + rounds per pickup
 */

/** A blank equippable item model. */
export function emptyEquipItem(name = 'New Item') {
  return {
    id: null,
    name,
    kind: 'weapon',
    grid: [...DEFAULT_EQUIP_GRID],
    microVoxels: [],
    grip: null,
    grip2: null,
    yaw: 0,
    stats: { ...DEFAULT_EQUIP_STATS },
    weapon: { ...DEFAULT_WEAPON },
    ammo: { ...DEFAULT_AMMO },
  };
}

const clampNum = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

/** Normalize the item kind: anything other than 'ammo' is a weapon. */
export function normalizeKind(kind) {
  return kind === 'ammo' ? 'ammo' : 'weapon';
}

/** Normalize an ammo pack to the canonical {type, amount} shape: the granted
 *  type must be a known ammo id, and the amount is clamped to ≥1 rounds
 *  (0 when no type is selected). */
export function normalizeAmmo(a = {}) {
  const type = isAmmoId(a.type) ? a.type : '';
  return {
    type,
    amount: type ? clampNum(a.amount, 1, 9999, DEFAULT_AMMO.amount) : 0,
  };
}

/** Normalize a stats object to the canonical {damage, reach, cooldown}.
 *  Reach is in meters and ranges from a fist's length up to sniper range. */
export function normalizeStats(stats = {}) {
  return {
    damage: clampNum(stats.damage, 1, 100, DEFAULT_EQUIP_STATS.damage),
    reach: clampNum(stats.reach, 0.5, 1000, DEFAULT_EQUIP_STATS.reach),
    cooldown: clampNum(stats.cooldown, 0.1, 3, DEFAULT_EQUIP_STATS.cooldown),
  };
}

/** Normalize a weapon profile to the canonical composable shape. */
export function normalizeWeapon(w = {}) {
  const kind = w.kind === 'ranged' ? 'ranged' : 'melee';
  const m = w.muzzle;
  return {
    kind,
    hands: w.hands === 'two' ? 'two' : 'one',
    muzzle:
      m && Number.isInteger(m.x) && Number.isInteger(m.y) && Number.isInteger(m.z)
        ? { x: m.x, y: m.y, z: m.z }
        : null,
    anim: ATTACK_ANIMS[kind]?.includes(w.anim)
      ? w.anim
      : kind === 'ranged' ? 'gun' : 'punch',
    recoil: clampNum(w.recoil, 0, 0.3, DEFAULT_WEAPON.recoil),
    magazine: clampNum(w.magazine, 0, 500, DEFAULT_WEAPON.magazine),
    ammo: isAmmoId(w.ammo) ? w.ammo : DEFAULT_WEAPON.ammo,
    reload: clampNum(w.reload, 0.2, 10, DEFAULT_WEAPON.reload),
    // Ranged weapons wobble by default; melee swings stay exact.
    spread: clampNum(w.spread, 0, 0.2, kind === 'ranged' ? RANGED_SPREAD : 0),
    pellets: Math.round(clampNum(w.pellets, 1, 20, DEFAULT_WEAPON.pellets)),
  };
}

/** Register (or overwrite) an equippable item. Stores a copy. */
export function registerEquipItem(item) {
  if (!item || !item.id) return null;
  const copy = structuredClone(item);
  copy.kind = normalizeKind(copy.kind);
  copy.grid = normalizeGrid(copy.grid);
  copy.stats = normalizeStats(copy.stats);
  copy.weapon = normalizeWeapon(copy.weapon);
  copy.yaw = clampNum(copy.yaw, 0, 360, 0);
  copy.ammo = normalizeAmmo(copy.ammo);
  REGISTRY.set(copy.id, copy);
  return copy;
}

/** @returns {EquipDef|null} the registered item or null */
export function getEquipItem(id) {
  return REGISTRY.get(id) ?? null;
}

export function isEquipId(id) {
  return REGISTRY.has(id);
}

/** Remove an item from the registry. @returns {boolean} true when removed */
export function removeEquipItem(id) {
  return REGISTRY.delete(id);
}

/** @returns {EquipDef[]} all registered items, in insertion order */
export function listEquipItems() {
  return [...REGISTRY.values()];
}

export function clearEquipItems() {
  REGISTRY.clear();
}

/** Persist the whole registry as JSON text (localStorage / files). */
export function serializeEquipRegistry() {
  return JSON.stringify(listEquipItems());
}

/** Load registry entries from JSON text (array of EquipDefs).
 *  @returns {EquipDef[]} */
export function deserializeEquipRegistry(text) {
  const out = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return out;
  }
  if (!Array.isArray(data)) return out;
  for (const entry of data) {
    const item = parseEquipDef(entry);
    if (!item) continue;
    registerEquipItem(item);
    out.push(item);
  }
  return out;
}

/** Serialize a single item to the on-disk JSON format. */
export function serializeEquipItem(item) {
  return JSON.stringify(
    {
      format: EQUIP_FORMAT,
      version: EQUIP_VERSION,
      id: item.id ?? null,
      name: item.name,
      kind: normalizeKind(item.kind),
      grid: normalizeGrid(item.grid),
      microVoxels: item.microVoxels,
      grip: item.grip ?? null,
      grip2: item.grip2 ?? null,
      yaw: item.yaw ?? 0,
      stats: normalizeStats(item.stats),
      weapon: normalizeWeapon(item.weapon),
      ammo: normalizeAmmo(item.ammo),
    },
    null,
    2,
  );
}

/** Build a normalized EquipDef from a plain object (registry/file entry). */
function parseEquipDef(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) return null;
  const grid = normalizeGrid(entry.grid);
  const microVoxels = (Array.isArray(entry.microVoxels) ? entry.microVoxels : [])
    .filter(
      (v) =>
        v && Number.isInteger(v.x) && Number.isInteger(v.y) && Number.isInteger(v.z) &&
        v.x >= 0 && v.x < grid[0] && v.y >= 0 && v.y < grid[1] && v.z >= 0 && v.z < grid[2] &&
        Array.isArray(v.color) && v.color.length >= 3,
    )
    .map((v) => ({ x: v.x, y: v.y, z: v.z, color: [v.color[0], v.color[1], v.color[2]] }));
  const clampCell = (v, axis) => Math.max(0, Math.min(grid[axis] - 1, v));
  const parseCell = (g) =>
    g && Number.isInteger(g.x) && Number.isInteger(g.y) && Number.isInteger(g.z)
      ? { x: clampCell(g.x, 0), y: clampCell(g.y, 1), z: clampCell(g.z, 2) }
      : null;
  const grip = parseCell(entry.grip);
  const grip2 = parseCell(entry.grip2);
  return {
    id: entry.id,
    name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
    kind: normalizeKind(entry.kind),
    grid,
    microVoxels,
    grip,
    grip2,
    yaw: clampNum(entry.yaw, 0, 360, 0),
    stats: normalizeStats(entry.stats),
    weapon: normalizeWeapon(entry.weapon),
    ammo: normalizeAmmo(entry.ammo),
  };
}

/** @returns {{item: EquipDef|null, errors: string[]}} */
export function deserializeEquipItem(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { item: null, errors: [`Invalid JSON: ${e.message}`] };
  }
  if (!data || data.format !== EQUIP_FORMAT) {
    return { item: null, errors: ['Not a voxelequip file'] };
  }
  const item = parseEquipDef({ ...data, id: data.id ?? '' });
  if (!item || !data.id) return { item: null, errors: ['Item has no id'] };
  return { item, errors: [] };
}
