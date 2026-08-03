// mobTypes.js — shared registry of mob definitions.
//
// Used by the editor (MobTool/MobMarker) and the playable game (Mob/MobManager).
// Each mob carries the stats that drive its AI + combat, the AABB that drives
// navmesh walkability and collision, and a marker color for the editor beacon.
// Dimensions are in meters; `halfWidth` is half the x/z footprint, `height` the
// full standing height. Mobs step up 0.5 m blocks exactly like the player.

export const MOBS = Object.freeze({
  imp: Object.freeze({
    id: 'imp',
    name: 'Imp',
    health: 30,
    speed: 4.2, // m/s
    damage: 8, // per melee strike
    attackRange: 1.6, // m — arm reach
    attackCooldown: 1.1, // s between strikes
    aggroRadius: 18, // m
    halfWidth: 0.25,
    height: 1.7,
    markerColor: 0xff8833,
  }),
  brute: Object.freeze({
    id: 'brute',
    name: 'Brute',
    health: 90,
    speed: 2.6,
    damage: 22,
    attackRange: 1.9,
    attackCooldown: 1.6,
    aggroRadius: 22,
    halfWidth: 0.35,
    height: 2.0,
    markerColor: 0xbb2244,
  }),
});

/** Mob definition by id, or null. */
export function getMob(id) {
  return MOBS[id] ?? null;
}

/** Every registered mob definition. */
export function listMobs() {
  return Object.values(MOBS);
}

/** True when an id names a registered mob type. */
export function isMobId(id) {
  return id in MOBS;
}
