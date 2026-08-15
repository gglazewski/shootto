// Switches.js — flip-switch decals that drive game flags.
//
// A switch is a DECAL (defs paired by switchOn/switchOff in VoxelTypes.js):
// the 90s Polish wall switch pinned to a voxel face. The placed decal entry
// carries `flag` — the name of the game flag it drives. In the game, E on
// the switch flips the flag; the flag store is the single source of truth
// and the decal's art (rocker up/down) MIRRORS it via bindWorldReactions,
// so saves never store switch state — only the raised flags.
//
// Same trick as doors and lights: the current art is the decal id itself,
// swapped in place (the entry object is shared by every footprint cell, so
// all of them update at once) and the touched cells re-mesh.

import { getDecal } from './VoxelTypes.js';

/** Face name of the voxel side a pick ray entered through (its hit normal
 *  points back out along one axis), or null for a degenerate normal. Both
 *  apps use it to find the switch decal under the crosshair. */
export function faceFromNormal(normal) {
  const [x, y, z] = normal ?? [];
  if (x) return x > 0 ? 'px' : 'nx';
  if (y) return y > 0 ? 'py' : 'ny';
  if (z) return z > 0 ? 'pz' : 'nz';
  return null;
}

/** The OFF-art def of a switch decal (either art given), or null. */
export function switchBaseDef(decalId) {
  const def = getDecal(decalId);
  if (def?.switchOn) return def;
  if (def?.switchOff) return getDecal(def.switchOff) ?? null;
  return null;
}

/** True for a placed switch decal entry, either art. */
export function isSwitchDecal(decal) {
  return !!decal && switchBaseDef(decal.decalId) != null;
}

/** The flag a placed switch drives, or null when none was authored. */
export function switchFlag(decal) {
  return typeof decal?.flag === 'string' && decal.flag ? decal.flag : null;
}

/** True when the switch shows its ON art. */
export function isSwitchOn(decal) {
  return !!getDecal(decal?.decalId)?.switchOff;
}

/** Decal id a switch placement is normalized to in map files (state lives
 *  in the flag store, not the map). Non-switches pass through. */
export function canonicalDecalId(decalId) {
  return getDecal(decalId)?.switchOff ?? decalId;
}

/**
 * Show a switch's ON or OFF art, re-meshing the touched cell. Purely
 * cosmetic — the flag store is what actually changed. No-op when the art
 * already matches.
 * @returns {boolean} true when the art changed
 */
export function setSwitchArt(world, decal, on) {
  const base = switchBaseDef(decal?.decalId);
  if (!base) return false;
  const next = on ? base.switchOn : base.id;
  if (decal.decalId === next) return false;
  decal.decalId = next;
  const [x, y, z] = decal.cell;
  world.markDirty(x, y, z);
  return true;
}

/**
 * Flip the flag a switch drives. Art is NOT touched here — it mirrors the
 * flag through the reaction binding, so a second switch on the same flag
 * flips with this one.
 * @param {import('../game/Reactions.js').GameFlags} flags
 * @returns {boolean} true when the switch had a flag to flip
 */
export function toggleSwitch(flags, decal) {
  const flag = switchFlag(decal);
  if (!flag) return false;
  flags.set(flag, !flags.get(flag));
  return true;
}

/**
 * Raise the flags of switches authored to start ON (`startOn` on the placed
 * decal entry). Runs once against a FRESH flag store (new game, playtest
 * start) — never on a loaded game, whose store already holds the player's
 * switch history. Seed before or after bindWorldReactions; listeners are
 * state mirrors, so order never matters.
 */
export function seedSwitchFlags(world, flags) {
  world.forEachDecal((d) => {
    if (d.startOn && isSwitchDecal(d) && switchFlag(d)) flags.set(switchFlag(d), true);
  });
}

/**
 * E on a switch: flip its flag (the bound art and reactions follow), or —
 * for a switch nobody wired — just flip the rocker art in place, so every
 * switch clicks even when it drives nothing.
 * @returns {boolean} true when anything changed
 */
export function flipSwitch(world, flags, decal) {
  if (switchFlag(decal)) return toggleSwitch(flags, decal);
  return setSwitchArt(world, decal, !isSwitchOn(decal));
}
