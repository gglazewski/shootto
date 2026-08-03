// MobRenderer.js — Doom-style billboarded sprites for mobs.
//
// Each live mob is a THREE.Sprite carrying a frame-strip texture built by
// mobSprites. Sprites always face the camera (true billboards) and are scaled
// so the art fills the mob's AABB (feet at the bottom, head at the top), which
// makes them depth-test correctly against the voxel world. A hurt flash tints
// the sprite through the material color.
//
// Lighting: mobs live in the same light engine as chunks/items. Each sprite
// samples the LightField at its current cell (cached until it crosses into a
// new cell) and is tinted by the shared chunk lighting uniforms — sky/block
// intensity with the cool/warm tint mix, the ambient floor, the overall light
// scale, and the directional sun term using the camera-facing billboard
// normal. Dark caves stay dark, torches glow warm, and night dims them, so a
// mob no longer glows at full brightness in a sealed room.

import { buildMobSpriteSheet, FRAMES, FRAME_COUNT } from './mobSprites.js';
import { CELL_SIZE } from '../engine/Space.js';

/** Frame index for a (state, animTime) pair. */
export function frameFor(animName, animTime) {
  const list = FRAMES[animName] ?? FRAMES.idle;
  const n = list.length;
  if (n === 1) return list[0];
  if (animName === 'idle') return list[Math.floor(animTime * 2) % n];
  if (animName === 'walk') return list[Math.floor(animTime * 8) % n];
  if (animName === 'attack') return list[Math.floor(animTime * 10) % n];
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
    /** @type {Map<object, {sprite: THREE.Sprite, texture: THREE.Texture}>} */
    this.sprites = new Map();
    this._sheetCache = new Map(); // typeId -> sheet
    this._toCam = new THREE.Vector3();
  }

  _sheetFor(typeId) {
    let sheet = this._sheetCache.get(typeId);
    if (!sheet) {
      sheet = buildMobSpriteSheet(typeId);
      this._sheetCache.set(typeId, sheet);
    }
    return sheet;
  }

  /** Create + attach a billboard for a mob. */
  addMob(mob) {
    const T = this.THREE;
    const sheet = this._sheetFor(mob.type.id);
    const texture = new T.Texture(sheet.canvas);
    texture.needsUpdate = true;
    texture.magFilter = T.NearestFilter;
    texture.minFilter = T.NearestFilter;
    texture.repeat.set(1 / FRAME_COUNT, 1);
    texture.offset.set(0, 0);

    const material = new T.SpriteMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.4,
      depthWrite: false,
    });
    const sprite = new T.Sprite(material);
    sprite.renderOrder = 1;
    this.scene.add(sprite);
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
    const aspect = sheet.frameW / sheet.frameH;
    const h = mob.height;
    // Sprite is centered at its position, so raise it by half its height.
    sprite.scale.set(h * aspect, h, 1);
    sprite.position.set(mob.pos.x, mob.pos.y + h / 2, mob.pos.z);

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
