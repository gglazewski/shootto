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
import { CELL_SIZE } from '../../engine/Space.js';
import {
  buildMobSpriteSheet, FRAME_COUNT, SHEET_STAND_ROWS, SHEET_GROUND_ROW,
} from '../../game/mobSprites.js';

/** Friendly-green beacon/ghost tint, distinct from every mob marker color. */
export const NPC_MARKER_COLOR = 0x55dd99;

export class NpcTool extends Tool {
  constructor(ctx) {
    super({ id: 'npc', name: 'NPCs', ctx });
    this.typeId = listNpcs()[0]?.id ?? 'granny';
    this.lastAction = '';
    this._ghostSprite = null;
    this._ghostSkin = null;
    this._ghostSheets = new Map(); // skin -> { sheet, texture }
  }

  /** Cell where the spawn would go (adjacent to the hovered face). */
  targetCell(hit) {
    return [hit.cell[0] + hit.normal[0], hit.cell[1] + hit.normal[1], hit.cell[2] + hit.normal[2]];
  }

  update(dt) {
    const hit = this.pick();
    if (!hit) {
      this.hide();
      return;
    }
    const cell = this.targetCell(hit);
    const blocked =
      !!this.ctx.world.get(cell[0], cell[1], cell[2]) ||
      !!this.ctx.world.npcSpawnAt(cell[0], cell[1], cell[2]);
    if (!this._showSpriteGhost(cell, blocked)) {
      this.ctx.ghost.showMob(cell, blocked, NPC_MARKER_COLOR);
    }
  }

  /** Billboard preview of the selected NPC standing in `cell`. Returns false
   *  when a sprite ghost cannot be built (headless tests, unknown type) so
   *  the caller can fall back to the plain marker ghost. */
  _showSpriteGhost(cell, blocked) {
    const { THREE, scene } = this.ctx;
    if (!scene || typeof document === 'undefined') return false;
    const def = getNpc(this.typeId);
    if (!def) return false;
    let entry = this._ghostSheets.get(def.skin);
    if (!entry) {
      const sheet = buildMobSpriteSheet(def.skin);
      const texture = new THREE.Texture(sheet.canvas);
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.repeat.set(1 / FRAME_COUNT, 1); // idle frame 0
      texture.needsUpdate = true;
      sheet.ready?.then(() => { texture.needsUpdate = true; }).catch(() => {});
      entry = { sheet, texture };
      this._ghostSheets.set(def.skin, entry);
    }
    if (!this._ghostSprite) {
      this._ghostSprite = new THREE.Sprite(new THREE.SpriteMaterial({
        transparent: true, opacity: 0.8, alphaTest: 0.1, depthWrite: false,
      }));
      scene.add(this._ghostSprite);
    }
    const sprite = this._ghostSprite;
    if (this._ghostSkin !== def.skin) {
      this._ghostSkin = def.skin;
      sprite.material.map = entry.texture;
      sprite.material.needsUpdate = true;
    }
    // Same sizing as MobRenderer: the character stands def.height tall with
    // its feet on the target cell's floor.
    const { sheet } = entry;
    const quadH = def.height * (sheet.frameH / SHEET_STAND_ROWS);
    const quadW = quadH * (sheet.frameW / sheet.frameH);
    const underfoot = (sheet.frameH - SHEET_GROUND_ROW) / sheet.frameH * quadH;
    sprite.scale.set(quadW, quadH, 1);
    sprite.position.set(
      cell[0] * CELL_SIZE + CELL_SIZE / 2,
      cell[1] * CELL_SIZE + quadH / 2 - underfoot,
      cell[2] * CELL_SIZE + CELL_SIZE / 2,
    );
    // A blocked cell tints the ghost red, matching every other tool.
    sprite.material.color.setHex(blocked ? 0xff5544 : 0xffffff);
    sprite.visible = true;
    this.ctx.ghost.hide();
    return true;
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
    this.ctx.npcPalette?.setSelected(this.typeId);
    Notice.info(`NPC: ${getNpc(this.typeId).name}`);
  }

  /** Select a type directly (a palette card was clicked). */
  setType(id) {
    if (!getNpc(id)) return;
    this.typeId = id;
    this.ctx.npcPalette?.setSelected(id);
    Notice.info(`NPC: ${getNpc(id).name}`);
  }

  onActivate() {
    // The selected type can vanish between activations (deleted in F4).
    if (!getNpc(this.typeId)) this.typeId = listNpcs()[0]?.id ?? this.typeId;
    this.ctx.npcPalette?.show(this.typeId);
  }

  onDeactivate() {
    this.ctx.npcPalette?.hide();
    this.hide();
  }

  /** Mode switches and pointer unlocks cancel the gesture — drop the ghost
   *  (it is the tool's own sprite, not the shared SelectionGhost App hides). */
  cancel() {
    this.hide();
  }

  hide() {
    this.ctx.ghost.hide();
    if (this._ghostSprite) this._ghostSprite.visible = false;
  }
}
