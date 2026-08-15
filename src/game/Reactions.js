// Reactions.js — the game's action/reaction wiring: named boolean FLAGS that
// actions raise and dynamic objects listen to.
//
// Actions (producers) are game events that set flags: today a quest tier can
// raise flags when it is accepted or completed (see the `flags` field
// normalizeQuest keeps — `{ accept: [...], complete: [...] }`, each entry a
// flag name, or '!name' to clear one). Reactions (consumers) are world
// objects bound to a flag: today a door carrying `unlockFlag` mirrors it —
// locked while the flag is false, unlocked the moment it goes true (and
// locked again if something clears it).
//
// The store is deliberately dumb — booleans, listeners, a serialized list of
// raised flags — so new producers (buttons, area triggers, kills) and new
// consumers (spawners, moving platforms) can join without touching it:
// producers call `set`, consumers subscribe in bindWorldReactions.
//
// Bound today: doors carrying `unlockFlag` (locked while the flag is down),
// lights carrying `lightFlag` (dark while the flag is down, running their
// authored on/flicker mode once raised; prefix '!' inverts), and wall
// switches — both producer (E flips their flag, see engine/Switches.js) and
// consumer (their rocker art mirrors it).
//
// Listener catch-up: `on` fires the callback immediately with the current
// value, so binding order and save/load order never matter — a door bound
// after its flag was raised still unlocks. Reactions must therefore be
// written as state mirrors (idempotent), not one-shots.
//
// Pure module (no three.js/DOM) so it unit tests in Node.

import { isDoorVoxel, setDoorLocked } from '../engine/Doors.js';
import { isLightVoxel, setLightPowered } from '../engine/Lights.js';
import { isSwitchDecal, switchFlag, setSwitchArt } from '../engine/Switches.js';

export class GameFlags {
  constructor() {
    /** @type {Set<string>} names of raised flags — unlisted means false. */
    this.raised = new Set();
    /** @type {Map<string, Set<Function>>} per-flag listeners. */
    this._listeners = new Map();
  }

  /** Current value of a flag; unknown names read as false. */
  get(name) {
    return this.raised.has(name);
  }

  /**
   * Raise or clear a flag. Listeners fire only on an actual change.
   * @returns {boolean} true when the value changed
   */
  set(name, value = true) {
    if (typeof name !== 'string' || !name) return false;
    if (this.get(name) === !!value) return false;
    if (value) this.raised.add(name);
    else this.raised.delete(name);
    for (const fn of this._listeners.get(name) ?? []) fn(!!value, name);
    return true;
  }

  /**
   * Subscribe to a flag. The callback fires immediately with the current
   * value (catch-up), then on every change.
   * @returns {() => void} unsubscribe
   */
  on(name, fn) {
    let set = this._listeners.get(name);
    if (!set) this._listeners.set(name, (set = new Set()));
    set.add(fn);
    fn(this.get(name), name);
    return () => set.delete(fn);
  }

  serialize() {
    return { raised: [...this.raised] };
  }

  /** Restore a serialized store (silent listeners — bind reactions after). */
  static deserialize(data) {
    const flags = new GameFlags();
    for (const name of data?.raised ?? []) {
      if (typeof name === 'string' && name) flags.raised.add(name);
    }
    return flags;
  }
}

/**
 * Apply a quest-style flag list: each entry raises its flag, a '!' prefix
 * clears it instead ('cellar-open' raises, '!cellar-open' clears).
 */
export function applyFlagList(flags, list) {
  for (const name of list ?? []) {
    if (typeof name !== 'string' || !name) continue;
    if (name.startsWith('!')) flags.set(name.slice(1), false);
    else flags.set(name, true);
  }
}

/** Split an authored flag reference into { name, invert }: 'power' reacts
 *  to the flag itself, '!power' to its opposite. */
function parseFlagRef(ref) {
  const invert = ref.startsWith('!');
  const name = invert ? ref.slice(1) : ref;
  return name ? { name, invert } : null;
}

/** Read an authored flag reference against a store: true when the signal is
 *  up ('!name' inverts). No reference authored means always on — consumers
 *  without a gate just work (NPC services, like lights, use this). */
export function flagRefRaised(flags, ref) {
  const parsed = typeof ref === 'string' && ref ? parseFlagRef(ref) : null;
  if (!parsed) return true;
  const value = flags?.get(parsed.name) ?? false;
  return parsed.invert ? !value : value;
}

/**
 * Scan the world for reaction carriers and subscribe each to its flag.
 * Doors with `unlockFlag` mirror it: locked while false, unlocked once true.
 * Lights with `lightFlag` mirror POWER: dark while false, their authored
 * mode once true ('!name' inverts). Switch decals mirror their flag with
 * their rocker art. `onDoorUnlock(voxel)` fires when a bound door actually
 * unlocks — feedback (a toast, a sound) belongs to the caller.
 * @returns {() => void} unbind everything (call before binding a new world)
 */
export function bindWorldReactions(world, flags, { onDoorUnlock } = {}) {
  const unsubs = [];
  world.forEachVoxel((v) => {
    if (isDoorVoxel(v) && v.unlockFlag) {
      unsubs.push(flags.on(v.unlockFlag, (value) => {
        if (setDoorLocked(v, !value) && value) onDoorUnlock?.(v);
      }));
    } else if (isLightVoxel(v) && v.lightFlag) {
      const ref = parseFlagRef(v.lightFlag);
      if (ref) {
        unsubs.push(flags.on(ref.name, (value) => {
          setLightPowered(world, v, ref.invert ? !value : value);
        }));
      }
    }
  });
  world.forEachDecal((d) => {
    if (!isSwitchDecal(d) || !switchFlag(d)) return;
    unsubs.push(flags.on(switchFlag(d), (value) => {
      setSwitchArt(world, d, value);
    }));
  });
  return () => {
    for (const u of unsubs) u();
  };
}
