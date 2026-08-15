// Blinkers.js — settles every light voxel onto the phase its state asks for.
//
// Shared by the game AND the editor: each light voxel (defs paired by
// lightOff/lightOn — see engine/Lights.js) is kept on the block id its
// effective mode wants. 'on' and 'off' are steady. 'flicker' keeps its
// horror-movie cadence — calm lit stretches (with the odd sagging dip)
// broken by fits of rapid erratic chatter — but is split into two layers so
// a guttering lamp doesn't strobe the baked light field:
//   - a CONTINUOUS 0..1 brightness signal (flickerSignal), pushed per frame
//     into the chunk shader as a dynamic point light on top of the lamp's
//     dimmed baked base (see lampLights + Renderer.setLampLights) — smooth
//     analog flicker with zero chunk rebuilds;
//   - rare BLACKOUT stretches (signal < 0) where the bulb really goes dark:
//     only these swap the block id, so the re-flood + remesh cost is paid a
//     couple of times per blackout instead of at ~10 Hz.
// Fully deterministic per voxel position, so the same map flickers the same
// way every run and a row of lights never strobes in lockstep.
//
// Phase swaps push a light-edit record — the Renderer re-floods the light
// and remeshes the touched chunks on its normal per-frame sync.

import { lightBaseDef, effectiveLightMode } from './Lights.js';
import { cellsFor, spanFor } from './VoxelShape.js';
import { lightFor } from './VoxelTypes.js';
import { CELL_SIZE } from './Space.js';

/** Deterministic noise in [0,1). */
const hashNoise = (i, phase) => {
  const h = Math.sin(i * 127.1 + phase * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

/** hashNoise sampled on integer t with smoothstep interpolation — cheap
 *  continuous value noise, so flicker dips ramp instead of square-waving. */
const smoothNoise = (t, phase) => {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  return hashNoise(i, phase) * (1 - u) + hashNoise(i + 1, phase) * u;
};

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Broken-bulb schedule as a continuous brightness signal. Within each ~1.7s
 * window the light is calm (near full, the odd sagging dip), throws a fit
 * (rapid erratic chatter over most of the range) or — rarely — blacks out
 * for a stretch: then the return is -1 and the caller swaps the block to
 * its dark phase, the only case that still touches the baked light field.
 * @returns {number} 0..1 brightness, or -1 during a blackout stretch
 */
export function flickerSignal(local, phase) {
  const win = Math.floor(local / 1.7);
  const inWin = local - win * 1.7;
  const r = hashNoise(win, phase * 3 + 5);
  const fitStart = hashNoise(win, phase + 9) * 0.9;
  const fitLen = 0.3 + hashNoise(win, phase + 17) * 0.7;
  const inFit = r >= 0.45 && inWin >= fitStart && inWin <= fitStart + fitLen;
  if (!inFit) {
    // calm: a gentle gutter around full brightness, sagging on rare dips
    const g = 0.88 + 0.12 * smoothNoise(local * 3, phase);
    const dip = smoothstep(0.02, 0.09, smoothNoise(local * 4, phase + 3));
    return g * (0.25 + 0.75 * dip);
  }
  if (r > 0.8) return -1; // dead stretch: the bulb really cuts out
  const c = smoothNoise(local * 16, phase + 41);
  return Math.min(1, Math.max(0.05, 1.55 * c - 0.25));
}

/** Min seconds between two phase swaps of the same light. Chatter no longer
 *  swaps blocks at all (it rides on the dynamic shader light), so this only
 *  debounces the edges of blackout stretches — each swap costs a chunk
 *  rebuild + light re-flood. */
const MIN_TOGGLE_INTERVAL = 0.1;

export class Blinkers {
  /** @param {import('./World.js').World} world */
  constructor(world) {
    this.world = world;
    this.list = [];
    this.time = 0;
    this._rescanTimer = 0;
    /** Dynamic light list for the renderer, rebuilt every update(): one
     *  entry per LIT flickering lamp — world-space center, range in meters,
     *  and the current 0..1 gutter signal. */
    this.lampLights = [];
  }

  /** Re-collect light voxels from the world (after a load, or on a slow
   *  cadence in the editor where blocks appear and vanish while editing). */
  rescan() {
    this.list = [];
    this.world.forEachVoxel((v) => {
      const base = lightBaseDef(v.type);
      if (!base) return;
      const span = spanFor(v.size);
      this.list.push({
        voxel: v,
        onType: base.id,
        offType: base.lightOff,
        phase: hashNoise(v.anchor[0] * 31 + v.anchor[1] * 7 + v.anchor[2] * 13, 1) * 2.7,
        // world-space center + reach of the dynamic gutter light
        x: (v.anchor[0] + span / 2) * CELL_SIZE,
        y: (v.anchor[1] + span / 2) * CELL_SIZE,
        z: (v.anchor[2] + span / 2) * CELL_SIZE,
        range: Math.max(1, lightFor(base.id)) * CELL_SIZE,
      });
    });
  }

  /**
   * Advance the flicker schedule and settle any lights whose phase differs
   * from what their mode wants (a flicker tick, a mode change from the
   * editor modal, a flag cutting the power).
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
    this.lampLights.length = 0;
    for (const b of this.list) {
      const mode = effectiveLightMode(b.voxel);
      const flickering = mode === 'flicker';
      const signal = flickering ? flickerSignal(this.time + b.phase, b.phase) : 0;
      const on = flickering ? signal >= 0 : mode === 'on';
      const v = b.voxel;
      if ((v.type === b.onType) !== on) {
        // Rate-cap only the blackout edges — a deliberate mode/power change
        // lands now.
        if (!flickering || b.lastToggle === undefined || this.time - b.lastToggle >= MIN_TOGGLE_INTERVAL) {
          b.lastToggle = this.time;
          const prevType = v.type;
          v.type = on ? b.onType : b.offType;
          const [ax, ay, az] = v.anchor;
          // soft: the renderer rebuilds the touched chunk on its deferred
          // budget instead of immediately — a blackout tolerates a frame of
          // latency, the frame time doesn't. prevType lets the light field
          // take its emission-only fast path (a lit<->dark swap never
          // changes opacity).
          this.world.edits.push({ cells: [...cellsFor(ax, ay, az, v.size, v.rotation ?? 0)], remove: false, type: v.type, prevType, soft: true });
          this.world.markDirty(ax, ay, az);
        }
      }
      // Lit flickering lamps drive the dynamic shader light with the smooth
      // signal — the guttering the baked field can't show without remeshes.
      if (flickering && v.type === b.onType) {
        this.lampLights.push({ x: b.x, y: b.y, z: b.z, range: b.range, intensity: Math.max(0, signal) });
      }
    }
  }
}
