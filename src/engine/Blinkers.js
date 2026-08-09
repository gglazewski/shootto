// Blinkers.js — drives blinking light blocks (defs with blink/blinkOff).
//
// Shared by the game AND the editor: each blinking voxel is toggled between
// its lit and dark phase by swapping the voxel type in place and pushing a
// light-edit record — the Renderer re-floods the light and remeshes the
// touched chunks on its normal per-frame sync, so the surroundings really
// strobe. Horror-movie cadence: calm lit stretches (with the odd single
// dip) broken by fits of rapid ~20Hz erratic chatter. Fully deterministic
// per voxel position, so the same map flickers the same way every run and
// a row of lights never strobes in lockstep.

import { getBlock } from './VoxelTypes.js';
import { cellsFor } from './VoxelShape.js';

/** Deterministic noise in [0,1). */
const hashNoise = (i, phase) => {
  const h = Math.sin(i * 127.1 + phase * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

/** Broken-bulb schedule: within each ~1.7s window the light is either calm
 *  (lit, at most a stray blink) or throws a fit — a short burst of rapid
 *  random chatter starting somewhere inside the window. */
export function flickerState(local, phase) {
  const win = Math.floor(local / 1.7);
  const inWin = local - win * 1.7;
  if (hashNoise(win, phase * 3 + 5) < 0.45) {
    return hashNoise(Math.floor(local * 4), phase) > 0.05;
  }
  const fitStart = hashNoise(win, phase + 9) * 0.9;
  const fitLen = 0.3 + hashNoise(win, phase + 17) * 0.7;
  if (inWin < fitStart || inWin > fitStart + fitLen) return true;
  return hashNoise(Math.floor(local * 21), phase) > 0.45;
}

export class Blinkers {
  /** @param {import('./World.js').World} world */
  constructor(world) {
    this.world = world;
    this.list = [];
    this.time = 0;
    this._rescanTimer = 0;
  }

  /** Re-collect blinking voxels from the world (after a load, or on a slow
   *  cadence in the editor where blocks appear and vanish while editing). */
  rescan() {
    this.list = [];
    this.world.forEachVoxel((v) => {
      const def = getBlock(v.type);
      const base = def?.blink ? def : def?.blinkOn ? getBlock(def.blinkOn) : null;
      if (!base?.blink) return;
      this.list.push({
        voxel: v,
        onType: base.id,
        offType: base.blinkOff,
        on: v.type === base.id,
        phase: hashNoise(v.anchor[0] * 31 + v.anchor[1] * 7 + v.anchor[2] * 13, 1) * 2.7,
      });
    });
  }

  /**
   * Advance the schedule and toggle any lights whose state changed.
   * @param {number} dt seconds
   * @param {number} [rescanInterval] seconds between automatic rescans
   *   (0 = never; pass ~1 in the editor so newly placed lamps start
   *   blinking without an explicit hook)
   */
  update(dt, rescanInterval = 0) {
    this.time += dt;
    if (rescanInterval > 0) {
      this._rescanTimer += dt;
      if (this._rescanTimer >= rescanInterval) {
        this._rescanTimer = 0;
        this.rescan();
      }
    }
    for (const b of this.list) {
      const on = flickerState(this.time + b.phase, b.phase);
      if (on === b.on) continue;
      b.on = on;
      const v = b.voxel;
      v.type = on ? b.onType : b.offType;
      const [ax, ay, az] = v.anchor;
      this.world.edits.push({ cells: [...cellsFor(ax, ay, az, v.size, v.rotation ?? 0)], remove: false, type: v.type });
      this.world.markDirty(ax, ay, az);
    }
  }
}
