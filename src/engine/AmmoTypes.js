// AmmoTypes.js — the ammo resource types a weapon can consume.
//
// A fixed set of ammo types, each with a max stack (the cap on how much the
// player can carry of that type). Weapons reference a type id via their weapon
// profile; the game tracks carried ammo per type on the player. A fresh player
// starts with zero of every type — ammo PACKS (ammo-kind items from the F3
// editor) are how they stock up.
//
// Pure module (no three.js/DOM) so it can be unit tested in Node.

export const AMMO_TYPES = Object.freeze({
  pistol: { id: 'pistol', name: 'Pistol Ammo', maxStack: 120 },
  rifle: { id: 'rifle', name: 'Rifle Ammo', maxStack: 120 },
  shotgun: { id: 'shotgun', name: 'Shotgun Ammo', maxStack: 40 },
});

export const AMMO_IDS = Object.freeze(Object.keys(AMMO_TYPES));

/** True when `id` names a known ammo type. */
export function isAmmoId(id) {
  return id in AMMO_TYPES;
}

/** Display name for an ammo type id. */
export function ammoName(id) {
  return AMMO_TYPES[id]?.name ?? id;
}

/** Max carried stack for an ammo type (0 for unknown). */
export function ammoMaxStack(id) {
  return AMMO_TYPES[id]?.maxStack ?? 0;
}

/** Every selectable ammo type, as {id, name} pairs (editor dropdowns). */
export function listAmmoTypes() {
  return AMMO_IDS.map((id) => ({ id, name: AMMO_TYPES[id].name }));
}

/** A fresh ammo inventory object: zero of every type. */
export function startingAmmo() {
  const out = {};
  for (const id of AMMO_IDS) out[id] = 0;
  return out;
}

/** Clamp an ammo count for a type to its [0, maxStack] range. */
export function clampAmmo(id, value) {
  const max = ammoMaxStack(id);
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
}
