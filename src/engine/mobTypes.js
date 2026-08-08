// mobTypes.js — shared registry of mob definitions.
//
// Used by the editor (MobTool/MobMarker) and the playable game (Mob/MobManager).
// Each mob carries the stats that drive its AI + combat, the AABB that drives
// navmesh walkability and collision, and a marker color for the editor beacon.
// Dimensions are in meters; `halfWidth` is half the x/z footprint, `height` the
// full standing height. Mobs step up 0.5 m blocks exactly like the player.

/**
 * Standing height range a spawned mob is rolled into, in meters. Real people
 * are not one size, and a crowd of identical silhouettes reads as clones, so
 * each mob draws its own height at spawn. A type's `height` is the clearance
 * its navmesh is built for (the tallest it may come out), not the height every
 * one of them gets.
 */
export const MOB_HEIGHT_MIN = 1.6;
export const MOB_HEIGHT_MAX = 1.9;

/** A standing height for a freshly spawned mob. @param {() => number} [rng] */
export function randomMobHeight(rng = Math.random) {
  return MOB_HEIGHT_MIN + rng() * (MOB_HEIGHT_MAX - MOB_HEIGHT_MIN);
}

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
    alertRadius: 12, // m — how far this mob HEARS a packmate's alarm cry
    halfWidth: 0.25,
    height: 1.7,
    markerColor: 0xff8833,
    mass: 1, // knockback resistance — a heavier mob barely budges when shot
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
    alertRadius: 14,
    halfWidth: 0.35,
    height: 2.0,
    markerColor: 0xbb2244,
    mass: 2.5,
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
