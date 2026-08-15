// MobRenderer.js — Doom-style billboarded sprites for mobs.
//
// Each live mob is a textured quad carrying a frame-strip texture built by
// mobSprites. Quads yaw toward the camera around the world Y axis only
// (cylindrical billboards): a mob always shows its face horizontally, but
// stays upright when the player looks up or down — a full screen-aligned
// billboard would tip back and read as lying on the ground. They are scaled
// so the drawn character stands exactly mob.height tall with its feet on the
// mob's position, which makes them depth-test correctly against the voxel
// world. A hurt flash tints the sprite through the material color.
//
// Lighting: mobs live in the same light engine as chunks/items. Each sprite
// samples the LightField at its current cell (cached until it crosses into a
// new cell) and is tinted by the shared chunk lighting uniforms — sky/block
// intensity with the cool/warm tint mix, the ambient floor, the overall light
// scale, and the directional sun term using the camera-facing billboard
// normal. Dark caves stay dark, torches glow warm, and night dims them, so a
// mob no longer glows at full brightness in a sealed room.

import {
  buildMobSpriteSheet, randomMobSkin, FRAMES, FRAME_COUNT,
  SHEET_STAND_ROWS, SHEET_GROUND_ROW,
} from './mobSprites.js';
import { CELL_SIZE } from '../engine/Space.js';

/** Frame index for a (state, animTime) pair. */
export function frameFor(animName, animTime) {
  const list = FRAMES[animName] ?? FRAMES.idle;
  const n = list.length;
  if (n === 1) return list[0];
  if (animName === 'idle') return list[Math.floor(animTime * 2) % n];
  if (animName === 'walk') return list[Math.floor(animTime * 8) % n];
  if (animName === 'attack') return list[Math.floor(animTime * 10) % n];
  if (animName === 'hurt') return list[Math.floor(animTime * 14) % n];
  // Death plays once and holds on the corpse: Mob.takeDamage zeroes animTime
  // when it kills, so the mob collapses, hits the floor, and stays there.
  if (animName === 'dead') return list[Math.min(n - 1, Math.floor(animTime * 7))];
  return list[0];
}

export class MobRenderer {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Scene} deps.scene
   * @param {object} [deps.lightField]  LightField to shade the sprites with
   * @param {import('three').Material} [deps.material]  map-less lit ShaderMaterial
   *   (Renderer.itemMaterial). Its live uniforms drive the sprite tint, so mobs
   *   follow the same light model as chunks and pick up the day/night cycle.
   * @param {import('three').Camera} [deps.camera]  used for the directional sun
   *   term (a billboard's visible surface faces the camera)
   */
  constructor({ THREE, scene, lightField = null, material = null, camera = null }) {
    this.THREE = THREE;
    this.scene = scene;
    this.lightField = lightField;
    this.material = material;
    this.camera = camera;
    /** @type {Map<object, {sprite: THREE.Mesh, texture: THREE.Texture}>} */
    this.sprites = new Map();
    this._sheetCache = new Map(); // skin -> sheet (shared by every mob wearing it)
    this._toCam = new THREE.Vector3();
    this._quadGeo = new THREE.PlaneGeometry(1, 1); // unit quad shared by all mobs
  }

  _sheetFor(skin) {
    let sheet = this._sheetCache.get(skin);
    if (!sheet) {
      sheet = buildMobSpriteSheet(skin);
      this._sheetCache.set(skin, sheet);
    }
    return sheet;
  }

  /** Create + attach a billboard for a mob. */
  addMob(mob) {
    const T = this.THREE;
    // Which character a mob looks like is picked once, at spawn (MobManager),
    // and only affects its art — stats and size come from its type.
    const sheet = this._sheetFor(mob.skin ?? randomMobSkin());
    const texture = new T.Texture(sheet.canvas);
    texture.needsUpdate = true;
    texture.magFilter = T.NearestFilter;
    texture.minFilter = T.NearestFilter;
    texture.repeat.set(1 / FRAME_COUNT, 1);
    texture.offset.set(0, 0);

    // Alpha-tested cutout, so writing depth is safe. Mobs render before the
    // glass pass (ChunkMesh gives transparent chunk meshes renderOrder 1):
    // glass in front of a zombie tints it, a zombie in front of glass
    // depth-rejects the pane behind — no more sprites glowing through glass.
    const material = new T.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.4,
      depthWrite: true,
      side: T.DoubleSide, // never cull, even if the yaw lags a frame
    });
    const sprite = new T.Mesh(this._quadGeo, material);
    this.scene.add(sprite);
    // The sheet canvas is blank until its art decodes (see mobSprites), so
    // re-upload it once that lands — otherwise the first mobs stay invisible.
    sheet.ready?.then(() => { texture.needsUpdate = true; }).catch(() => {});
    const entry = { sprite, texture, sheet };
    this.sprites.set(mob, entry);
    this._applyPose(mob, 0, entry);
  }

  removeMob(mob) {
    const entry = this.sprites.get(mob);
    if (!entry) return;
    this.scene.remove(entry.sprite);
    entry.sprite.material.dispose();
    entry.texture.dispose();
    this.sprites.delete(mob);
  }

  /** Advance animations + sync each sprite to its mob. */
  update(dt) {
    for (const [mob, entry] of this.sprites) {
      this._applyPose(mob, dt, entry);
    }
  }

  _applyPose(mob, dt, entry) {
    const { sprite, texture, sheet } = entry;
    // The quad is the whole frame, but a mob's height describes the character
    // standing in it — and the frame is taller than that, since it also has to
    // hold outflung arms and a corpse lying down. Scale so the art's standing
    // height equals mob.height (shorter characters stay shorter), then drop the
    // quad so the frame's ground row lands on the mob's feet.
    const quadH = mob.height * (sheet.frameH / SHEET_STAND_ROWS);
    const quadW = quadH * (sheet.frameW / sheet.frameH);
    const underfoot = (sheet.frameH - SHEET_GROUND_ROW) / sheet.frameH * quadH;
    sprite.scale.set(quadW, quadH, 1);
    sprite.position.set(mob.pos.x, mob.pos.y + quadH / 2 - underfoot, mob.pos.z);

    // Cylindrical billboard: yaw the quad's +Z normal toward the camera, but
    // keep it plumb — no pitch/roll, so it stays upright under any view angle.
    if (this.camera) {
      const cp = this.camera.position;
      sprite.rotation.y = Math.atan2(cp.x - sprite.position.x, cp.z - sprite.position.z);
    }

    // Pick the frame for the current anim.
    const idx = frameFor(mob.animName, mob.animTime);
    texture.offset.x = idx / FRAME_COUNT;

    // Lighting: multiply the frame by the light at the mob's cell. A hurt
    // flash tints red on top of that, so a wounded mob in a dark room is a
    // dark red silhouette rather than a full-brightness beacon.
    const flash = sprite.material;
    const lit = this._lightColor(mob, entry);
    if (mob.hurtTimer > 0) flash.color.setRGB(lit.r * 1.7, lit.g * 0.35, lit.b * 0.35);
    else flash.color.setRGB(lit.r, lit.g, lit.b);
  }

  /**
   * Lighting multiplier for a mob's sprite, mirroring the chunk shader:
   *   sky = skyAt/15 * skyIntensity (day/night), block = blockAt/15,
   *   base = max(sky, block), tint = mix(skyTint, blockTint, block/base),
   *   lit  = ambientMin + tint * base * lightScale
   *         + sunColor * vSun * sky * sunStrength
   * where the billboard's surface normal points from the mob toward the
   * camera (its always-visible face). Falls back to full brightness (1,1,1)
   * when no light field or lighting material is wired up.
   */
  _lightColor(mob, entry) {
    if (!this.lightField || !this.material) return { r: 1, g: 1, b: 1 };

    const cx = Math.floor(mob.pos.x / CELL_SIZE);
    const cy = Math.floor((mob.pos.y + mob.height * 0.5) / CELL_SIZE);
    const cz = Math.floor(mob.pos.z / CELL_SIZE);
    const cell = entry.lightCell;
    if (!cell || cell[0] !== cx || cell[1] !== cy || cell[2] !== cz) {
      entry.lightCell = [cx, cy, cz];
      entry.sky = this.lightField.skyAt(cx, cy, cz) / 15;
      entry.block = this.lightField.blockAt(cx, cy, cz) / 15;
    }

    const U = this.material.uniforms;
    const sky = entry.sky * U.uSkyIntensity.value;
    const block = entry.block;
    const base = Math.max(sky, block);
    const t = block / Math.max(base, 1e-4);
    const st = U.uSkyTint.value;
    const bt = U.uBlockTint.value;
    const amb = U.uAmbientMin.value;
    const scale = U.uLightScale.value;
    const r = amb + (st.r + (bt.r - st.r) * t) * base * scale;
    const g = amb + (st.g + (bt.g - st.g) * t) * base * scale;
    const b = amb + (st.b + (bt.b - st.b) * t) * base * scale;

    if (!this.camera) return { r, g, b };
    this._toCam.subVectors(this.camera.position, entry.sprite.position).normalize();
    const vSun = Math.max(0, this._toCam.dot(U.uSunDir.value)) * sky * U.uSunStrength.value;
    const sun = U.uSunColor.value;
    return { r: r + sun.r * vSun, g: g + sun.g * vSun, b: b + sun.b * vSun };
  }

  /** Drop every sprite (world reset). */
  clear() {
    for (const mob of [...this.sprites.keys()]) this.removeMob(mob);
  }
}
