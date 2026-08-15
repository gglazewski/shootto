// Lights.js — dynamic state for light blocks.
//
// One placeable block per light (lamp, neon, ...) with THREE states instead
// of a palette entry per state: 'on' (default), 'off' and 'flicker'. The
// same trick as doors: defs come in lit/dark pairs linked by lightOff/
// lightOn, the CURRENT phase is the block id itself (so the light field and
// mesher need no new concepts), and the authored state rides on the voxel:
//   lightMode — 'off' | 'flicker' ('on' is implied by absence, so untouched
//               maps stay byte-identical).
//   lightFlag — name of a game flag driving POWER: while the flag is down
//               the light is dark, once raised it runs its authored mode
//               (see game/Reactions.js). Prefix '!' to invert.
// The game-runtime power state (`lightPowered`) is never persisted with the
// map — it is derived from the flag store on every bind, like door locks.
//
// engine/Blinkers.js walks all light voxels per frame and settles each one
// onto the phase its effective mode asks for (with the flicker schedule
// driving the 'flicker' mode), so mode changes need no extra plumbing.

import { getBlock } from './VoxelTypes.js';
import { cellsFor } from './VoxelShape.js';

/** The three authored states. */
export const LIGHT_MODES = Object.freeze(['on', 'off', 'flicker']);

/** The lit-phase def of a light block (either phase given), or null. */
export function lightBaseDef(type) {
  const def = getBlock(type);
  if (def?.lightOff) return def;
  if (def?.lightOn) return getBlock(def.lightOn) ?? null;
  return null;
}

/** True for any light voxel, either phase. */
export function isLightVoxel(voxel) {
  return !!voxel && lightBaseDef(voxel.type) != null;
}

/** Authored mode of a light voxel: 'on' | 'off' | 'flicker'. */
export function lightMode(voxel) {
  return LIGHT_MODES.includes(voxel?.lightMode) ? voxel.lightMode : 'on';
}

/** Mode the light should actually show: the authored mode, unless the game
 *  has cut its power (a bound flag being down) — then 'off'. */
export function effectiveLightMode(voxel) {
  if (voxel?.lightPowered === false) return 'off';
  return lightMode(voxel);
}

/** Swap a light voxel to the given phase in place, pushing the same kind of
 *  soft light-edit record as a blink toggle (prevType lets the light field
 *  take its emission-only fast path). No-op when already there. */
function setPhase(world, voxel, lit) {
  const base = lightBaseDef(voxel.type);
  if (!base) return false;
  const next = lit ? base.id : base.lightOff;
  if (voxel.type === next) return false;
  const prevType = voxel.type;
  voxel.type = next;
  const [ax, ay, az] = voxel.anchor;
  world.edits.push({ cells: [...cellsFor(ax, ay, az, voxel.size, voxel.rotation ?? 0)], remove: false, type: next, prevType, soft: true });
  world.markDirty(ax, ay, az);
  return true;
}

/** Settle the voxel's block id onto its effective mode ('flicker' counts as
 *  lit — the schedule takes over from there). Returns true when it changed. */
export function syncLightType(world, voxel) {
  return setPhase(world, voxel, effectiveLightMode(voxel) !== 'off');
}

/**
 * Author a light's state: 'on' | 'off' | 'flicker'. The phase updates
 * immediately so the editor shows the choice without waiting a frame.
 * @returns {boolean} true when the mode changed
 */
export function setLightMode(world, voxel, mode) {
  if (!isLightVoxel(voxel) || !LIGHT_MODES.includes(mode)) return false;
  if (lightMode(voxel) === mode) return false;
  if (mode === 'on') delete voxel.lightMode;
  else voxel.lightMode = mode;
  syncLightType(world, voxel);
  return true;
}

/** Game runtime: cut or restore a light's power (its flag reaction). */
export function setLightPowered(world, voxel, powered) {
  if (!isLightVoxel(voxel)) return false;
  if (powered) delete voxel.lightPowered;
  else voxel.lightPowered = false;
  return syncLightType(world, voxel);
}

/**
 * Copy authored light settings from a saved/stamped entry onto a freshly
 * placed voxel, settling the phase in place (loaders run before any
 * renderer, so a direct type swap needs no edit record). Non-lights and
 * default values are no-ops — safe for every block a loader places.
 * @returns {object|null} the voxel, for chaining
 */
export function applyLightSettings(voxel, entry) {
  if (!entry || !isLightVoxel(voxel)) return voxel;
  if (entry.lightMode === 'off' || entry.lightMode === 'flicker') voxel.lightMode = entry.lightMode;
  if (typeof entry.lightFlag === 'string' && entry.lightFlag) voxel.lightFlag = entry.lightFlag;
  if (lightMode(voxel) === 'off') {
    const base = lightBaseDef(voxel.type);
    if (base) voxel.type = base.lightOff;
  }
  return voxel;
}

/** Legacy block ids from the era of one-block-per-state, mapped to the
 *  unified block + its authored mode. Old maps load; saves write the new
 *  form. */
const LEGACY_LIGHTS = new Map([
  ['lamp_blink', { type: 'lamp', lightMode: 'flicker' }],
  ['lamp_blink_off', { type: 'lamp', lightMode: 'flicker' }],
  ['neon_blink', { type: 'neon', lightMode: 'flicker' }],
  ['neon_blink_off', { type: 'neon', lightMode: 'flicker' }],
  ['neon_white_blink', { type: 'neon_white', lightMode: 'flicker' }],
  ['neon_white_blink_off', { type: 'neon_white', lightMode: 'flicker' }],
]);

/** Resolve a legacy blinking-light id to { type, lightMode }, or null. */
export function legacyLightSettings(type) {
  return LEGACY_LIGHTS.get(type) ?? null;
}
