// NPC.js — friendly characters the player can talk to.
//
// NPCs reuse the mob billboard pipeline (MobRenderer + the drawn character
// sheets) but carry none of the AI: they stand on their spot, idle-animate,
// and offer a dialog when the player walks up and presses E. GameApp owns the
// dialog UI and the E key; this module owns who the NPCs are, where they
// stand, and which one is close enough to talk to.

import { CELL_SIZE } from '../engine/Space.js';
import { MobRenderer } from './MobRenderer.js';
import { collisionWorld } from '../editor/itemPick.js';
import { getNpc, BUILTIN_NPCS } from '../engine/NpcRegistry.js';

/** Meters within which the "press E to talk" prompt shows. */
export const TALK_RANGE = 2.4;
/** Meters past which an open dialog closes (walked away mid-chat). */
export const TALK_BREAK_RANGE = TALK_RANGE + 1.2;
/** Minimum dot product between the player's view direction and the vector to
 *  the NPC for a talk prompt to show — roughly a 145° forward cone, generous
 *  enough for a casual approach but excludes an NPC behind the player. */
export const TALK_FACING_DOT = 0.3;

/** Headroom cells an NPC needs above its feet (tallest NPC, 2 m / CELL_SIZE). */
const HEADROOM_CELLS = 4;

/** The built-in NPC set (see NpcRegistry, where custom NPCs register too). */
export const NPC_TYPES = BUILTIN_NPCS;

/** NPC definition by id — built-in or editor-authored — or null. */
export function getNpcType(id) {
  return getNpc(id);
}

/** One placed, talkable character. Carries exactly the fields MobRenderer
 *  reads from a mob (pos, skin, height, animName/animTime, hurtTimer). */
export class NPC {
  /** @param {{type: object, feet: {x:number,y:number,z:number}}} deps */
  constructor({ type, feet }) {
    this.type = type;
    this.name = type.name;
    this.skin = type.skin;
    this.height = type.height;
    this.dialog = type.dialog;
    this.greeting = type.greeting;
    this.topics = type.topics ?? [];
    this.chat = type.chat ?? null;
    this.services = type.services ?? [];
    this.pos = { x: feet.x, y: feet.y, z: feet.z };
    this.animName = 'idle';
    this.animTime = Math.random() * 2; // desync idle sway between NPCs
    this.hurtTimer = 0;
  }

  update(dt) {
    this.animTime += dt;
  }
}

export class NPCManager {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Scene} deps.scene  ignored when `renderer` is given
   * @param {import('../engine/World.js').World} deps.world
   * @param {object} [deps.lightField]
   * @param {object} [deps.material]
   * @param {import('three').Camera} [deps.camera]
   * @param {object} [deps.renderer]  billboard renderer (injectable for tests)
   */
  constructor({ THREE, scene, world, lightField = null, material = null, camera = null, renderer }) {
    this.world = world;
    this.solid = collisionWorld(world);
    this.renderer = renderer ?? new MobRenderer({ THREE, scene, lightField, material, camera });
    this.npcs = [];
  }

  /**
   * Drop all NPCs and place the given spawns. Each spawn names an NPC type
   * and a candidate feet cell; the NPC snaps to the nearest standable floor
   * within `radius` cells of it (spawns with no floor anywhere near are
   * skipped — better no granny than a granny in a wall).
   * @param {Array<{type: string, cell: [number,number,number], radius?: number}>} spawns
   */
  rebuild(spawns = []) {
    this.clear();
    for (const s of spawns) {
      const type = getNpcType(s.type);
      if (!type) continue;
      const feet = this._findFeet(s.cell[0], s.cell[1], s.cell[2], s.radius ?? 6);
      if (!feet) continue;
      const npc = new NPC({ type, feet });
      this.npcs.push(npc);
      this.renderer.addMob(npc);
    }
  }

  /** Advance idle animations + billboards. */
  update(dt) {
    for (const npc of this.npcs) npc.update(dt);
    this.renderer.update(dt);
  }

  /** The closest NPC the player is near enough — and facing — to talk to, or
   *  null. Horizontal distance with a same-floor check, matching how mobs
   *  measure reach — an NPC one story up shouldn't offer a chat through the
   *  ceiling. `facing` ({x,z} unit vector, optional) additionally requires
   *  the NPC be roughly in front of the player, so an NPC behind their back
   *  doesn't offer a chat either; omitted (e.g. looking straight up/down)
   *  skips that check. */
  nearest(player, facing = null, range = TALK_RANGE) {
    let best = null;
    let bestD = range;
    for (const npc of this.npcs) {
      if (Math.abs(player.y - npc.pos.y) > 2) continue;
      const dx = npc.pos.x - player.x;
      const dz = npc.pos.z - player.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD) continue;
      if (facing && d > 1e-3 && (dx / d) * facing.x + (dz / d) * facing.z < TALK_FACING_DOT) continue;
      best = npc;
      bestD = d;
    }
    return best;
  }

  clear() {
    this.renderer.clear();
    this.npcs = [];
  }

  /** Feet position (meters, cell-centered) of the nearest standable spot to
   *  the candidate cell: solid floor below, HEADROOM_CELLS of clearance above.
   *  Searches columns outward in rings, and within a column tries feet levels
   *  nearest the candidate y first. @returns {{x,y,z}|null} */
  _findFeet(cx, cy, cz, radius) {
    for (let ring = 0; ring <= radius; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const y = this._feetYAt(cx + dx, cy, cz + dz);
          if (y === null) continue;
          return {
            x: (cx + dx) * CELL_SIZE + CELL_SIZE / 2,
            y: y * CELL_SIZE,
            z: (cz + dz) * CELL_SIZE + CELL_SIZE / 2,
          };
        }
      }
    }
    return null;
  }

  /** Standable feet cell-y in a column, nearest to `cy` (±HEADROOM_CELLS·2),
   *  or null. */
  _feetYAt(x, cy, z) {
    for (let i = 0; i <= HEADROOM_CELLS * 2; i++) {
      for (const y of i === 0 ? [cy] : [cy + i, cy - i]) {
        if (!this.solid.get(x, y - 1, z)) continue;
        let clear = true;
        for (let h = 0; h < HEADROOM_CELLS; h++) {
          if (this.solid.get(x, y + h, z)) { clear = false; break; }
        }
        if (clear) return y;
      }
    }
    return null;
  }
}
