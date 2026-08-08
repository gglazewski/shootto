// SpawnTool.js — place/move/remove the player spawn point.
//
// LMB sets the spawn to the cell adjacent to the hovered face (so it sits in
// open space, not inside a block); RMB clears it. There is exactly one spawn
// point per world.

import { Tool } from '../Tool.js';
import { Notice } from '../Notice.js';
import { setSpawnCommand, clearSpawnCommand } from '../commands.js';

export class SpawnTool extends Tool {
  constructor(ctx) {
    super({ id: 'spawn', name: 'Spawn', ctx });
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
    const blocked = !!this.ctx.world.get(cell[0], cell[1], cell[2]);
    this.ctx.ghost.showSpawn(cell, blocked);
  }

  onMouseDown(button) {
    if (button === 2) {
      const cmd = clearSpawnCommand(this.ctx.world);
      if (cmd.do()) {
        this.ctx.history.push(cmd);
        this.lastAction = 'Spawn point removed';
        Notice.info('Player spawn removed');
      }
      return;
    }
    if (button !== 0) return;
    const hit = this.pick();
    if (!hit) return;
    const cell = this.targetCell(hit);
    if (this.ctx.world.get(cell[0], cell[1], cell[2])) {
      Notice.warn('Cannot place the spawn inside a block');
      return;
    }
    const cmd = setSpawnCommand(this.ctx.world, cell);
    cmd.do();
    this.ctx.history.push(cmd);
    this.lastAction = `Spawn at ${cell.join(',')}`;
    Notice.info(`Player spawn set at (${cell.join(', ')})`);
  }

  onDeactivate() {
    this.hide();
  }

  hide() {
    this.ctx.ghost.hide();
  }
}
