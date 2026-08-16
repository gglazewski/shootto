// MobTool.js — place/remove mob spawn points in the world editor.
//
// LMB places a spawn of the currently selected mob type in the open cell
// adjacent to the hovered face (so it sits in air, like the player spawn); RMB
// removes the spawn adjacent to the hovered face. Press G (mob.cycle) while the
// tool is active to cycle the mob type. The game reads these spawns when it
// starts a new game.

import { Tool } from '../Tool.js';
import { Notice } from '../Notice.js';
import { addMobSpawnCommand, removeMobSpawnCommand } from '../commands.js';
import { getMob, listMobs } from '../../engine/mobTypes.js';

export class MobTool extends Tool {
  constructor(ctx) {
    super({ id: 'mob', name: 'Mobs', ctx });
    this.typeId = listMobs()[0]?.id ?? 'imp';
    /** Settings new spawns are placed with (see World.addMobSpawn). Filled by
     *  middle-clicking an existing spawner beacon ("copy spawner"), cleared
     *  when cycling to a different mob type. */
    this.settings = { loot: null, delay: null };
    this.lastAction = '';
  }

  /** Copy a spawner: aim the tool at this type + settings (middle-click). */
  copyFrom(spawn) {
    this.typeId = spawn.type;
    this.settings = {
      loot: spawn.loot ? [...spawn.loot] : null,
      delay: spawn.delay ? [...spawn.delay] : null,
    };
  }

  /** Cell where the spawn would go (adjacent to the hovered face). */
  targetCell(hit) {
    return [hit.cell[0] + hit.normal[0], hit.cell[1] + hit.normal[1], hit.cell[2] + hit.normal[2]];
  }

  update(dt) {
    const hit = this.pick();
    if (!hit) {
      this.ctx.ghost.hide();
      return;
    }
    const cell = this.targetCell(hit);
    const blocked =
      !!this.ctx.world.get(cell[0], cell[1], cell[2]) ||
      !!this.ctx.world.mobSpawnAt(cell[0], cell[1], cell[2]);
    const def = getMob(this.typeId);
    this.ctx.ghost.showMob(cell, blocked, def?.markerColor ?? 0xff5544);
  }

  onMouseDown(button) {
    if (button === 2) {
      const hit = this.pick();
      if (hit) {
        const cell = this.targetCell(hit);
        const spawn = this.ctx.world.mobSpawnAt(cell[0], cell[1], cell[2]);
        if (spawn) {
          const cmd = removeMobSpawnCommand(this.ctx.world, spawn);
          if (cmd.do()) {
            this.ctx.history.push(cmd);
            this.lastAction = `Mob removed at ${cell.join(',')}`;
            Notice.info('Mob spawn removed');
          }
        }
      }
      return;
    }
    if (button !== 0) return;
    const hit = this.pick();
    if (!hit) return;
    const cell = this.targetCell(hit);
    if (this.ctx.world.get(cell[0], cell[1], cell[2])) {
      Notice.warn('Cannot place a mob inside a block');
      return;
    }
    const cmd = addMobSpawnCommand(this.ctx.world, { type: this.typeId, cell, settings: this.settings });
    if (!cmd.do()) {
      Notice.warn('A mob spawn is already here');
      return;
    }
    this.ctx.history.push(cmd);
    this.lastAction = `Mob ${this.typeId} at ${cell.join(',')}`;
    Notice.info(`Spawned ${getMob(this.typeId)?.name ?? this.typeId}`);
  }

  /** Cycle to the next mob type (bound to G while this tool is active). */
  cycleType() {
    const mobs = listMobs();
    if (!mobs.length) return;
    const i = mobs.findIndex((m) => m.id === this.typeId);
    this.typeId = mobs[(i + 1) % mobs.length].id;
    this.settings = { loot: null, delay: null }; // copied settings don't outlive their type
    Notice.info(`Mob: ${getMob(this.typeId).name}`);
  }

  onDeactivate() {
    this.hide();
  }

  hide() {
    this.ctx.ghost.hide();
  }
}
