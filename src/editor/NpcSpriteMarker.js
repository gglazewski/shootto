// NpcSpriteMarker.js — in-world sprite billboards for NPC spawn points.
//
// The editor twin of the game's MobRenderer: every NPC spawn shows the
// character actually standing there — idle-pose billboard, feet on the
// spawn cell's floor, sized exactly like the game will size them — instead
// of an anonymous beacon. A green floor ring underneath keeps the spawn
// reading as an editor marker (and findable when the sprite faces away
// into a wall). Drop-in replacement for the MobMarker instance App used
// for NPCs: update() no-ops until the spawn set — or a spawn's skin or
// height, edited in F4 — changes; setVisible() overrides for test runs.

import { CELL_SIZE } from '../engine/Space.js';
import { getNpc } from '../engine/NpcRegistry.js';
import {
  buildMobSpriteSheet, FRAME_COUNT, SHEET_STAND_ROWS, SHEET_GROUND_ROW,
} from '../game/mobSprites.js';
import { NPC_MARKER_COLOR } from './tools/NpcTool.js';

export class NpcSpriteMarker {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Scene} deps.scene
   * @param {object} deps.world
   */
  constructor({ THREE, scene, world }) {
    this.THREE = THREE;
    this.scene = scene;
    this.world = world;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this._sheets = new Map(); // skin -> { sheet, texture } (shared per skin)
    this._ringGeo = null;
    this._ringMat = null;
    this._lastSignature = null;
  }

  _sheetFor(skin) {
    let entry = this._sheets.get(skin);
    if (entry) return entry;
    const T = this.THREE;
    const sheet = buildMobSpriteSheet(skin);
    const texture = new T.Texture(sheet.canvas);
    texture.magFilter = T.NearestFilter;
    texture.minFilter = T.NearestFilter;
    texture.repeat.set(1 / FRAME_COUNT, 1); // idle frame 0
    texture.needsUpdate = true;
    // The sheet canvas is blank until its art decodes; re-upload then.
    sheet.ready?.then(() => { texture.needsUpdate = true; }).catch(() => {});
    entry = { sheet, texture };
    this._sheets.set(skin, entry);
    return entry;
  }

  /** Sync sprites to the spawn set; no-op unless it changed. */
  update() {
    const sig = [];
    this.world.forEachNpcSpawn((s) => {
      const def = getNpc(s.type);
      sig.push(`${s.type}@${s.x},${s.y},${s.z}:${def?.skin ?? '?'}:${def?.height ?? 0}`);
    });
    sig.sort();
    const key = sig.join('|');
    if (key === this._lastSignature) {
      this.group.visible = true;
      return;
    }
    this._lastSignature = key;
    this._rebuild();
  }

  _rebuild() {
    this._clear();
    const T = this.THREE;
    this._ringGeo ??= new T.TorusGeometry(CELL_SIZE * 0.6, 0.015, 6, 24);
    this._ringMat ??= new T.MeshBasicMaterial({
      color: NPC_MARKER_COLOR, transparent: true, opacity: 0.7,
    });
    this.world.forEachNpcSpawn((s) => {
      const def = getNpc(s.type);
      const { sheet, texture } = this._sheetFor(def?.skin ?? 'granny');
      const sprite = new T.Sprite(new T.SpriteMaterial({
        map: texture, transparent: true, alphaTest: 0.4, depthWrite: true,
      }));
      // Same sizing as MobRenderer: the drawn character stands def.height
      // tall with its feet on the spawn cell's floor.
      const height = def?.height ?? 1.65;
      const quadH = height * (sheet.frameH / SHEET_STAND_ROWS);
      const quadW = quadH * (sheet.frameW / sheet.frameH);
      const underfoot = (sheet.frameH - SHEET_GROUND_ROW) / sheet.frameH * quadH;
      const x = s.x * CELL_SIZE + CELL_SIZE / 2;
      const feetY = s.y * CELL_SIZE;
      const z = s.z * CELL_SIZE + CELL_SIZE / 2;
      sprite.scale.set(quadW, quadH, 1);
      sprite.position.set(x, feetY + quadH / 2 - underfoot, z);
      const ring = new T.Mesh(this._ringGeo, this._ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(x, feetY + 0.02, z);
      this.group.add(sprite, ring);
    });
    this.group.visible = true;
  }

  _clear() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child.isSprite) child.material.dispose();
    }
  }

  /** Override visibility (e.g. hide during test run / editors). */
  setVisible(visible) {
    this.group.visible = visible;
    this._lastSignature = null;
  }

  dispose() {
    this._clear();
    this.scene?.remove(this.group);
    for (const { texture } of this._sheets.values()) texture.dispose();
    this._ringGeo?.dispose();
    this._ringMat?.dispose();
  }
}
