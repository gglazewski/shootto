// NpcTool.js — place/remove NPC spawn points in the world editor.
//
// Mirrors MobTool: LMB places a spawn of the currently selected NPC type in
// the open cell adjacent to the hovered face, RMB removes the spawn there,
// and G (mob.cycle) cycles through the registered NPC types (built-ins plus
// whatever the F4 NPC editor authored). The game reads these spawns when a
// world loads and stands a talkable character on each one.

import { Tool } from '../Tool.js';
import { Notice } from '../Notice.js';
import { addNpcSpawnCommand, removeNpcSpawnCommand } from '../commands.js';
import { getNpc, listNpcs } from '../../engine/NpcRegistry.js';

/** Friendly-green beacon/ghost tint, distinct from every mob marker color. */
export const NPC_MARKER_COLOR = 0x55dd99;

export class NpcTool extends Tool {
  constructor(ctx) {
    super({ id: 'npc', name: 'NPCs', ctx });
    this.typeId = listNpcs()[0]?.id ?? 'granny';
    this.lastAction = '';
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
      !!this.ctx.world.npcSpawnAt(cell[0], cell[1], cell[2]);
    this.ctx.ghost.showMob(cell, blocked, NPC_MARKER_COLOR);
  }

  onMouseDown(button) {
    if (button === 2) {
      const hit = this.pick();
      if (hit) {
        const cell = this.targetCell(hit);
        const spawn = this.ctx.world.npcSpawnAt(cell[0], cell[1], cell[2]);
        if (spawn) {
          const cmd = removeNpcSpawnCommand(this.ctx.world, spawn);
          if (cmd.do()) {
            this.ctx.history.push(cmd);
            this.lastAction = `NPC removed at ${cell.join(',')}`;
            Notice.info('NPC spawn removed');
          }
        }
      }
      return;
    }
    if (button !== 0) return;
    // The selected type can vanish under the tool (deleted in the F4 editor).
    if (!getNpc(this.typeId)) {
      this.typeId = listNpcs()[0]?.id ?? this.typeId;
      if (!getNpc(this.typeId)) {
        Notice.warn('No NPC types defined — create one in the NPC editor (F4)');
        return;
      }
    }
    const hit = this.pick();
    if (!hit) return;
    const cell = this.targetCell(hit);
    if (this.ctx.world.get(cell[0], cell[1], cell[2])) {
      Notice.warn('Cannot place an NPC inside a block');
      return;
    }
    const cmd = addNpcSpawnCommand(this.ctx.world, { type: this.typeId, cell });
    if (!cmd.do()) {
      Notice.warn('An NPC spawn is already here');
      return;
    }
    this.ctx.history.push(cmd);
    this.lastAction = `NPC ${this.typeId} at ${cell.join(',')}`;
    Notice.info(`Placed ${getNpc(this.typeId)?.name ?? this.typeId}`);
  }

  /** Cycle to the next NPC type (bound to G while this tool is active). */
  cycleType() {
    const npcs = listNpcs();
    if (!npcs.length) return;
    const i = npcs.findIndex((n) => n.id === this.typeId);
    this.typeId = npcs[(i + 1) % npcs.length].id;
    Notice.info(`NPC: ${getNpc(this.typeId).name}`);
  }

  onDeactivate() {
    this.hide();
  }

  hide() {
    this.ctx.ghost.hide();
  }
}
