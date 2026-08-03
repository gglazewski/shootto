// GameApp.js — the playable game.
//
// A standalone page (game.html) that shares the editor's localStorage: it
// reads the map (`voxelmap.save`) and the item registry (`voxelitem.items`)
// the editor writes, so saving in the editor and refreshing the game page
// picks the new map/objects up automatically. Save slots snapshot the whole
// world (map + objects) with the player position, so a load restores exactly
// what was saved.
//
// Modes: 'menu' (main menu), 'playing' (walk around), 'paused' (Esc overlay
// with save/load slots).

import * as THREE from '../../vendor/three.module.js';
import { World } from '../engine/World.js';
import { Renderer } from '../engine/Renderer.js';
import { CELL_SIZE, MAX_RAY_DISTANCE } from '../engine/Space.js';
import { createAtlasTexture } from '../textures/AtlasTexture.three.js';
import { WalkControls } from '../editor/WalkControls.js';
import { ItemRenderer } from '../editor/ItemRenderer.js';
import { collisionWorld } from '../editor/itemPick.js';
import { GameLoop } from '../GameLoop.js';
import { CONFIG } from '../config.js';
import { deserialize } from '../persistence/WorldSerializer.js';
import { serializeBundle, deserializeBundle } from '../persistence/WorldBundle.js';
import { serializeRegistry, deserializeRegistry, getItem } from '../engine/ItemRegistry.js';
import { deserializeEquipRegistry, getEquipItem } from '../engine/EquipmentRegistry.js';
import { ammoName } from '../engine/AmmoTypes.js';
import { microCellSizeFor, lightLevelForMeters, rotateMicroPoint } from '../engine/ItemTypes.js';
import { spanFor } from '../engine/VoxelShape.js';
import { BUNDLED_WORLD } from '../bundledWorld.js';
import { SLOT_COUNT, readSlot, writeSlot, makeSlot } from './SaveSlots.js';
import { PlayerStats, EQUIPMENT_SLOTS } from './PlayerStats.js';
import { weaponFor, FISTS } from './weapons.js';
import { PlayerHand } from './PlayerHand.js';
import { SmokeParticles } from './SmokeParticles.js';
import { MuzzleFX } from './MuzzleFX.js';
import { MobManager } from './MobManager.js';
import { itemAwarePick } from '../editor/itemPick.js';
import { TouchControls } from './TouchControls.js';

/** Fallback reload time (seconds) when a weapon profile has none set. */
const RELOAD_TIME = 1.4;

export class GameApp {
  /**
   * @param {object} [deps]
   * @param {Document} [deps.doc]
   * @param {HTMLElement} [deps.container]
   * @param {Storage} [deps.storage]  localStorage in the browser
   */
  constructor({ doc = document, container, storage = null } = {}) {
    this.doc = doc;
    this.container = container ?? doc.querySelector('#game');
    this.storage = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    this.mode = 'menu'; // 'menu' | 'playing' | 'paused'
    // Touch devices get the on-screen touch layer and skip pointer lock (and
    // render a bit cheaper: no MSAA, capped pixel ratio).
    this.isTouch = TouchControls.isTouch();

    // --- engine (same render pipeline as the editor) ---
    this.world = new World();
    this.webgl = new THREE.WebGLRenderer({ antialias: !this.isTouch });
    if (this.isTouch) this.webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.container.appendChild(this.webgl.domElement);
    const { texture, tileIndexFor, atlas } = createAtlasTexture(THREE);
    this.renderer = new Renderer({ THREE, webgl: this.webgl, world: this.world, atlasTexture: texture, tileIndexFor, atlas });

    this.walk = new WalkControls({
      THREE,
      camera: this.renderer.camera,
      domElement: this.webgl.domElement,
      world: collisionWorld(this.world),
      opts: { sensitivity: CONFIG.controls.sensitivity, ...CONFIG.player, touchMode: this.isTouch },
    });

    if (this.isTouch) {
      this.touch = new TouchControls({
        doc: this.doc,
        walk: this.walk,
        callbacks: {
          reload: () => this._reload(),
          pickup: () => this._pickup(),
          inject: () => this._useInjection(),
          selectSlot: (i) => this._selectSlot(i),
          pause: () => this.pauseGame(),
        },
      });
    }

    this.itemRenderer = new ItemRenderer({
      THREE,
      scene: this.renderer.scene,
      world: this.world,
      lightField: this.renderer.light,
      material: this.renderer.itemMaterial,
    });

    // --- player state ---
    this.stats = new PlayerStats();
    this._attackCooldown = 0;
    this.hand = new PlayerHand({
      THREE,
      camera: this.renderer.camera,
      scene: this.renderer.scene,
      lightField: this.renderer.light,
      material: this.renderer.itemMaterial,
      probeForward: (maxMeters) => {
        const hit = itemAwarePick(this.world, THREE, this.renderer.camera, Math.ceil(maxMeters / CELL_SIZE));
        return hit ? hit.dist * CELL_SIZE : Infinity;
      },
    });
    this.smoke = new SmokeParticles({ THREE, scene: this.renderer.scene });
    this.mobs = new MobManager({
      THREE,
      scene: this.renderer.scene,
      world: this.world,
      lightField: this.renderer.light,
      material: this.renderer.itemMaterial,
      camera: this.renderer.camera,
      onDamagePlayer: (amount, pos) => this._mobHitsPlayer(amount, pos),
    });

    // Highlight shown over a placed equippable item you're aiming at (E picks it up).
    this._pickupMarker = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this._pickupMarker.visible = false;
    this._pickupOutline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x66ccff }),
    );
    this._pickupOutline.visible = false;
    this.renderer.scene.add(this._pickupMarker, this._pickupOutline);
    this._pickupTarget = null;

    // Muzzle by-products: sparks + smoke when a ranged weapon fires. The flash
    // itself lives on the held weapon (PlayerHand.muzzleFlash) so it sticks to
    // the barrel while the player moves.
    this.muzzleFX = new MuzzleFX({ THREE, scene: this.renderer.scene });
    this._muzzlePos = new THREE.Vector3();

    // Ammo per weapon id + reload state.
    this._ammo = new Map(); // itemId -> { current, max }
    this._reloading = false;
    this._reloadTimer = 0;
    this._reloadWeapon = null;

    // --- UI ---
    this.ui = {
      menu: this.doc.querySelector('#menu'),
      pause: this.doc.querySelector('#pause'),
      hud: this.doc.querySelector('#hud'),
      toast: this.doc.querySelector('#toast'),
      pickup: this.doc.querySelector('#pickup'),
      slotsMenu: this.doc.querySelector('#slots-menu'),
      slotsPause: this.doc.querySelector('#slots-pause'),
      healthFill: this.doc.querySelector('#health-fill'),
      healthText: this.doc.querySelector('#health-text'),
      armorFill: this.doc.querySelector('#armor-fill'),
      armorText: this.doc.querySelector('#armor-text'),
      equipment: this.doc.querySelector('#equipment'),
      hand: this.doc.querySelector('#hand'),
      ammo: this.doc.querySelector('#ammo'),
      kills: this.doc.querySelector('#kills'),
      death: this.doc.querySelector('#death'),
      btnNew: this.doc.querySelector('#btn-new'),
      btnResume: this.doc.querySelector('#btn-resume'),
      btnQuit: this.doc.querySelector('#btn-quit'),
      btnRespawn: this.doc.querySelector('#btn-respawn'),
      btnDeathMenu: this.doc.querySelector('#btn-death-menu'),
    };

    this._wireUI();
    this._wireInput();
  }

  // --- lifecycle ---

  start() {
    this._onResize = () => this.renderer.resize(window.innerWidth, window.innerHeight);
    window.addEventListener('resize', this._onResize);
    this._onResize();

    this._loadBaseWorld();
    this._renderSlots();

    this.loop = new GameLoop({ onFrame: (dt) => this._frame(dt) });
    this.loop.start();
    this.walk.connect();
    this.showMenu();
    return this;
  }

  dispose() {
    this.loop?.stop();
    this.walk.disconnect();
    this.touch?.dispose();
    window.removeEventListener('resize', this._onResize);
  }

  _frame(dt) {
    if (this.mode === 'playing') {
      this.walk.update(dt);
      // Touch fire button held: attack every frame (cooldown throttles it).
      if (this.touch?.attacking) this._attack();
      this._updatePickup();
      this.mobs.update(dt, this.walk.position);
    } else {
      this._hidePickup();
    }
    if (this._attackCooldown > 0) this._attackCooldown = Math.max(0, this._attackCooldown - dt);
    if (this._reloading) {
      this._reloadTimer -= dt;
      if (this._reloadTimer <= 0) this._finishReload();
    }
    this.hand.update(dt);
    this.smoke.update(dt);
    this.muzzleFX.update(dt);
    this.itemRenderer.update();
    this.renderer.render(dt);
  }

  // --- world loading (shares the editor's localStorage) ---

  /** Load the editor's current map + objects (falling back to the bundled
   *  world), so editor saves show up after a refresh. The item registries are
   *  loaded FIRST so placed placeable/equippable items resolve when the map is
   *  deserialized (otherwise they are skipped as unregistered). */
  _loadBaseWorld() {
    this._loadItems();
    this._loadEquipItems();
    const mapText = this.storage?.getItem(CONFIG.saveKey);
    let world;
    if (mapText) {
      const { world: loaded } = deserialize(mapText);
      world = loaded;
    } else if (BUNDLED_WORLD?.map) {
      const { world: loaded } = deserialize(JSON.stringify(BUNDLED_WORLD.map));
      world = loaded;
    } else {
      world = new World();
    }
    this._applyWorld(world);
  }

  /** Load the item registry from the editor's storage, or the bundled one. */
  _loadItems() {
    const text = this.storage?.getItem(CONFIG.itemSaveKey);
    if (text) {
      deserializeRegistry(text);
    } else if (Array.isArray(BUNDLED_WORLD?.items)) {
      deserializeRegistry(JSON.stringify(BUNDLED_WORLD.items));
    }
  }

  /** Load the equippable-item registry (F3 editor) so placed equipment items
   *  (pistols, clubs, …) resolve their shape and render. Same sources as
   *  placeable objects: the editor's localStorage or the deployed bundle. */
  _loadEquipItems() {
    const text = this.storage?.getItem(CONFIG.equipSaveKey);
    if (text) {
      deserializeEquipRegistry(text);
    } else if (Array.isArray(BUNDLED_WORLD?.equip)) {
      deserializeEquipRegistry(JSON.stringify(BUNDLED_WORLD.equip));
    }
  }

  /** Replace the live world with `loaded`'s voxels/items/spawn and rebuild. */
  _applyWorld(loaded) {
    this.world.clear();
    loaded.forEachVoxel((v) => this.world.place(v.type, v.size, v.anchor[0], v.anchor[1], v.anchor[2]));
    loaded.forEachItem((it) => this.world.placeItem(it.itemId, it.size, it.anchor[0], it.anchor[1], it.anchor[2], it.rotation ?? 0));
    loaded.forEachMobSpawn((s) => this.world.addMobSpawn(s.type, s.x, s.y, s.z));
    if (loaded.spawn) {
      this.world.setSpawn(loaded.spawn[0], loaded.spawn[1], loaded.spawn[2]);
      this.world.spawnYaw = loaded.spawnYaw ?? 0;
    }
    this.renderer.clearChunks();
    this.renderer.loadWorldBounds();
    this.itemRenderer.rebuildAll();
    this.smoke.clear();
    this.mobs.rebuild();
    this._refreshItemLights();
  }

  /** Seed the light field from light-emitting placed items and re-bake. */
  _refreshItemLights() {
    const lights = [];
    this.world.forEachItem((placement) => {
      const def = getItem(placement.itemId);
      if (!def?.light) return;
      const cellSize = microCellSizeFor(placement.size);
      const l = def.light;
      const yaw = placement.rotation ?? 0;
      const [lx, lz] = rotateMicroPoint(l.x, l.z, yaw);
      lights.push({
        x: Math.floor(placement.anchor[0] + ((lx + 0.5) * cellSize) / CELL_SIZE),
        y: Math.floor(placement.anchor[1] + ((l.y + 0.5) * cellSize) / CELL_SIZE),
        z: Math.floor(placement.anchor[2] + ((lz + 0.5) * cellSize) / CELL_SIZE),
        level: lightLevelForMeters(l.strength),
      });
    });
    this.renderer.light.setItemLights(lights);
    this.renderer.light.recompute();
    this.renderer.rebakeChunkLight();
  }

  // --- player HUD / combat ---

  /** Update the health/armor bars + equipment slots from this.stats. */
  _updateHud() {
    const s = this.stats;
    if (this.ui.healthFill) {
      this.ui.healthFill.style.width = `${s.health}%`;
      this.ui.healthFill.classList.toggle('low', s.health <= 30);
      this.ui.healthText.textContent = String(Math.round(s.health));
    }
    if (this.ui.armorFill) {
      this.ui.armorFill.style.width = `${s.armor}%`;
      this.ui.armorText.textContent = String(Math.round(s.armor));
    }
    if (this.ui.kills) this.ui.kills.textContent = String(this.mobs.kills);
    this.touch?.setActiveSlot(this.stats.activeSlot);
    this._updateHeldItem();
    this._renderEquipment();
    this._updateAmmoHud();
  }

  /** Show magazine ammo for ranged weapons as `in-mag / carried` (hidden for
   *  melee/fists and for guns without a magazine). */
  _updateAmmoHud() {
    const el = this.ui.ammo;
    if (!el) return;
    const weapon = this.stats.activeItemId ? weaponFor(this.stats.activeItemId) : FISTS;
    const max = weapon.magazine ?? 0;
    if (weapon.kind !== 'ranged' || max <= 0) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    const ammo = this._ammoFor(weapon);
    const carried = this._carriedAmmo(ammo);
    el.classList.remove('hidden');
    el.textContent = `${ammo.current} / ${carried}`;
  }

  /** Show the equipped item in the hand (empty slot = fists). Called whenever
   *  the HUD refreshes, i.e. on equip, slot switch, pickup, load, new game. */
  _updateHeldItem() {
    const id = this.stats.activeItemId;
    const def = id ? (getItem(id) ?? getEquipItem(id)) : null;
    this.hand.setHeldItem(def);
  }

  /** Render the four equipment slots and the current "hand". */
  _renderEquipment() {
    const el = this.ui.equipment;
    if (!el) return;
    el.innerHTML = '';
    EQUIPMENT_SLOTS.forEach((slot, i) => {
      const id = this.stats.equipment[slot];
      const item = id ? getItem(id) : null;
      const div = document.createElement('div');
      div.className = `eq-slot${i === this.stats.activeSlot ? ' active' : ''}`;
      div.title = slot;
      const name = document.createElement('span');
      name.className = 'eq-slot-name';
      name.textContent = item?.name ?? '—';
      const slotLabel = document.createElement('span');
      slotLabel.className = 'eq-slot-label';
      slotLabel.textContent = String(i + 1);
      div.appendChild(name);
      div.appendChild(slotLabel);
      div.addEventListener('click', () => this._selectSlot(i));
      el.appendChild(div);
    });
    if (this.ui.hand) {
      const weapon = this.stats.activeItemId ? weaponFor(this.stats.activeItemId) : FISTS;
      this.ui.hand.textContent = weapon.name;
    }
  }

  /** Select an equipment slot by index (1-4). */
  _selectSlot(i) {
    if (this.stats.setActiveSlot(i)) this._updateHud();
  }

  /** Attack with the item in hand (fists when the slot is empty). Melee weapons
   *  play their swing animation and smoke where they connect within reach;
   *  ranged weapons recoil, flash at the barrel and smoke at the range-limited
   *  impact point. A ranged weapon with an empty magazine reloads instead. */
  _attack() {
    if (this.mode !== 'playing' || this._attackCooldown > 0 || this._reloading) return;
    const weapon = this.stats.activeItemId ? weaponFor(this.stats.activeItemId) : FISTS;
    if (weapon.kind === 'ranged' && this._ammoFor(weapon).max > 0 && this._ammoFor(weapon).current <= 0) {
      this._startReload(weapon);
      return;
    }
    this._attackCooldown = weapon.cooldown;
    if (weapon.kind === 'ranged') {
      this._shoot(weapon);
      return;
    }
    this.hand.attack(weapon.anim);
    const impact = this._attackImpact(weapon);
    if (impact) this._resolveImpact(impact, weapon.damage);
  }

  /**
   * First thing the aim ray hits within the weapon's reach: a mob, the world,
   * or nothing. A mob is hit only when it lies before any voxel (bullets and
   * swings are blocked by walls, Doom-style).
   * @returns {{mob: object}|{pos:[number,number,number]}|null}
   */
  _attackImpact(weapon) {
    const voxelHit = this._aim(weapon.range);
    const cam = this.renderer.camera;
    const voxelDist = voxelHit
      ? Math.hypot(voxelHit[0] - cam.position.x, voxelHit[1] - cam.position.y, voxelHit[2] - cam.position.z)
      : Infinity;
    const mobHit = this.mobs.aimHit(cam);
    const maxMeters = weapon.range * CELL_SIZE;
    if (mobHit && mobHit.dist < voxelDist && mobHit.dist <= maxMeters) return { mob: mobHit.mob };
    return voxelHit ? { pos: voxelHit } : null;
  }

  /** Apply an attack impact: damage a mob (with kill credit) or puff smoke. */
  _resolveImpact(impact, damage) {
    if (impact.mob) {
      this._damageMob(impact.mob, damage);
      return;
    }
    this.smoke.puff(impact.pos);
  }

  /** Damage a mob; count and puff smoke when it dies. */
  _damageMob(mob, damage) {
    const died = mob.takeDamage(damage);
    this.smoke.puff([mob.pos.x, mob.pos.y + mob.height * 0.5, mob.pos.z]);
    if (died) this.mobs.kills++;
    this._updateHud();
  }

  /** A mob landed a strike on the player. */
  _mobHitsPlayer(amount, pos) {
    this.smoke.puff([pos.x, pos.y, pos.z]);
    this.stats.damage(amount);
    this._updateHud();
    if (this.stats.isDead) this.gameOver();
  }

  /** Transition to the death screen (mobs finally can kill you). */
  gameOver() {
    if (this.mode === 'dead') return;
    this.mode = 'dead';
    this.touch?.setEnabled(false);
    this.walk.enabled = false;
    this.walk.keys.clear();
    this.walk.velocity.set(0, 0, 0);
    if (document.pointerLockElement) document.exitPointerLock();
    this.ui.menu.classList.add('hidden');
    this.ui.pause.classList.add('hidden');
    this.ui.hud.classList.add('hidden');
    this.ui.death.classList.remove('hidden');
    this._hidePickup();
  }

  /** Ammo counter for a weapon's magazine, seeded full on first use — a found
   *  gun comes with one full mag. `current` is rounds in the gun; carried ammo
   *  lives on stats.ammo keyed by the weapon's ammo type. */
  _ammoFor(weapon) {
    let entry = this._ammo.get(weapon.id);
    if (!entry) {
      const max = weapon.magazine ?? 0;
      entry = { current: max, max, type: weapon.ammo ?? '' };
      this._ammo.set(weapon.id, entry);
    }
    return entry;
  }

  /** Fire a ranged weapon: consume a round, recoil animation, attached muzzle
   *  flash at the barrel, sparks + smoke, and a smoke puff at the first surface
   *  the shot hits within the weapon's range. Auto-reloads on the last round
   *  when the player still carries ammo of the gun's type. */
  _shoot(weapon) {
    const ammo = this._ammoFor(weapon);
    if (ammo.max > 0) ammo.current = Math.max(0, ammo.current - 1);
    this.hand.attack('gun', { recoil: weapon.recoil });
    this.hand.muzzleFlash();
    const muzzle = this.hand.heldMuzzleWorld(this._muzzlePos);
    if (muzzle) {
      const dir = this.renderer.camera.getWorldDirection(new THREE.Vector3());
      this.muzzleFX.burst(muzzle, dir);
    }
    const impact = this._attackImpact(weapon);
    if (impact) this._resolveImpact(impact, weapon.damage);
    if (ammo.max > 0 && ammo.current <= 0 && this._carriedAmmo(ammo) > 0) this._startReload(weapon);
    this._updateHud();
  }

  /** Carried rounds for a weapon's ammo type (0 when it has no ammo type). */
  _carriedAmmo(ammo) {
    if (!ammo.type) return 0;
    return this.stats.ammo[ammo.type] ?? 0;
  }

  /** Start a reload: hands dip down for the weapon's reload time, then rounds
   *  move from the carried ammo inventory into the mag and the hands come back
   *  up. No-op with nothing to load. */
  _startReload(weapon) {
    if (this._reloading) return;
    const ammo = this._ammoFor(weapon);
    if (this._carriedAmmo(ammo) <= 0) {
      this._toast('No ammo');
      return;
    }
    const time = Math.max(0.2, weapon.reload ?? RELOAD_TIME);
    this._reloading = true;
    this._reloadTimer = time;
    this._reloadWeapon = weapon;
    this.hand.reload(time);
    this._toast('Reloading…');
    this._updateHud();
  }

  /** Manual reload of the weapon in hand (R). No-op unless it has a magazine
   *  with something missing from it. */
  _reload() {
    if (this.mode !== 'playing' || this._reloading) return;
    const weapon = this.stats.activeItemId ? weaponFor(this.stats.activeItemId) : FISTS;
    if (weapon.magazine <= 0) return;
    const ammo = this._ammoFor(weapon);
    if (ammo.current >= ammo.max) {
      this._toast('Already loaded');
      return;
    }
    this._startReload(weapon);
  }

  _finishReload() {
    this._reloading = false;
    if (this._reloadWeapon) {
      const ammo = this._ammoFor(this._reloadWeapon);
      if (ammo.type) {
        // Move up to a full mag's worth of carried rounds into the gun.
        const needed = ammo.max - ammo.current;
        const loaded = this.stats.takeAmmo(ammo.type, needed);
        ammo.current += loaded;
      }
    }
    this._reloadWeapon = null;
    this._updateHud();
  }

  /** Exact world position the current aim hits within `maxCells` (in cells), or
   *  null when nothing is aimed at or it is out of reach. The walk length is
   *  capped by maxCells (defaults to the raycaster maximum), so a weapon's
   *  range directly controls how far a shot can land. */
  _aim(maxCells = MAX_RAY_DISTANCE) {
    const { camera } = this.renderer;
    const hit = itemAwarePick(this.world, THREE, this.renderer.camera, maxCells);
    if (!hit || hit.dist > maxCells) return null;
    // The raycaster's `dist` is the cell distance along the ray to the surface
    // it entered — the exact impact point, not the middle of the voxel.
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const d = hit.dist * CELL_SIZE; // cell units -> world units
    return [
      camera.position.x + dir.x * d,
      camera.position.y + dir.y * d,
      camera.position.z + dir.z * d,
    ];
  }

  // --- item pickup (aim at a placed equippable item, press E) ---

  /** The placed equippable item under the crosshair, or null. Only items from
   *  the equipment registry (F3 editor) are pickable — placeable objects are
   *  world decoration and stay put. Pickups are short-range (5 m), so the
   *  per-frame aim ray stays cheap. */
  _pickTarget() {
    const hit = itemAwarePick(this.world, THREE, this.renderer.camera, 10);
    if (!hit) return null;
    const item = this.world.itemAt(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!item || !getEquipItem(item.itemId)) return null;
    return { cell: hit.cell, item };
  }

  /** Track what the crosshair is aiming at: show the highlight + prompt on a
   *  pickable item, clear both otherwise. Called every frame while playing. */
  _updatePickup() {
    const target = this._pickTarget();
    this._pickupTarget = target;
    if (!target) {
      this._hidePickup();
      return;
    }
    const def = getEquipItem(target.item.itemId);
    const s = spanFor(target.item.size) * CELL_SIZE;
    const ax = target.item.anchor[0] * CELL_SIZE;
    const ay = target.item.anchor[1] * CELL_SIZE;
    const az = target.item.anchor[2] * CELL_SIZE;
    for (const g of [this._pickupMarker, this._pickupOutline]) {
      g.visible = true;
      g.scale.set(s, s, s);
      g.position.set(ax + s / 2, ay + s / 2, az + s / 2);
    }
    if (this.ui.pickup) {
      this.ui.pickup.innerHTML = `Press <kbd>E</kbd> to pick up ${def?.name ?? target.item.itemId}`;
      this.ui.pickup.classList.remove('hidden');
    }
  }

  _hidePickup() {
    this._pickupTarget = null;
    this._pickupMarker.visible = false;
    this._pickupOutline.visible = false;
    if (this.ui.pickup) this.ui.pickup.classList.add('hidden');
  }

  /** Pick up the aimed equippable item. Ammo packs grant their ammo type
   *  (capped by max stack) rather than being equipped; everything else goes
   *  into an equipment slot. */
  _pickup() {
    const target = this._pickupTarget;
    if (!target) return;
    const def = getEquipItem(target.item.itemId);
    if (!def) return;
    this.world.removeItemAt(target.item.anchor[0], target.item.anchor[1], target.item.anchor[2]);
    if (def.kind === 'ammo') {
      const a = def.ammo ?? {};
      const type = a.type ?? '';
      const amount = a.amount ?? 0;
      if (type && amount > 0) {
        this.stats.addAmmo(type, amount);
        this._toast(`Picked up ${amount}× ${ammoName(type)}`);
      } else {
        this._toast(`Picked up ${def.name}`);
      }
      this._updateHud();
      return;
    }
    const slot = this._pickupSlot(def);
    this.stats.equip(slot, def.id);
    this._updateHud();
    this._toast(`Picked up ${def.name}`);
  }

  /** Slot a picked-up item lands in: weapons avoid the injection slot, while
   *  consumables (no damage) prefer it. Fills the active slot first when empty,
   *  then the first empty slot, then replaces the active slot. */
  _pickupSlot(def) {
    const active = this.stats.activeSlotName;
    const isConsumable = !def?.stats || def.stats.damage <= 0;
    const preferred = isConsumable
      ? ['injection', 'primary', 'secondary', 'extra']
      : ['primary', 'secondary', 'extra'];
    if (preferred.includes(active) && !this.stats.equipment[active]) return active;
    for (const slot of preferred) {
      if (!this.stats.equipment[slot]) return slot;
    }
    return isConsumable ? 'injection' : active;
  }

  /** Use the equipped injection (heals, consumes it). */
  _useInjection() {
    if (!this.stats.equipment.injection) {
      this._toast('No injection equipped');
      return;
    }
    if (this.stats.useInjection()) {
      this._toast('Injection used');
      this._updateHud();
    }
  }

  // --- spawning ---

  /** Cell to spawn the player at: world spawn, else the world-center column
   *  top, bumped up until the standing AABB fits. */
  _spawnCell() {
    const cell = this.world.spawn ? [...this.world.spawn] : this._fallbackCell();
    let feet = this.walk.feetAt(cell[0], cell[1], cell[2]);
    while (!this.walk.canStand(feet[0], feet[1], feet[2])) {
      cell[1]++;
      feet = this.walk.feetAt(cell[0], cell[1], cell[2]);
    }
    return cell;
  }

  _fallbackCell() {
    const b = this.world.bounds();
    if (!b) return [0, 4, 0];
    const cx = Math.floor((b.min[0] + b.max[0]) / 2);
    const cz = Math.floor((b.min[2] + b.max[2]) / 2);
    let top = b.min[1] - 1;
    for (let y = b.max[1]; y >= b.min[1]; y--) {
      if (this.world.get(cx, y, cz)) { top = y; break; }
    }
    return [cx, top + 2, cz];
  }

  // --- modes ---

  showMenu() {
    this.mode = 'menu';
    this.touch?.setEnabled(false);
    this.ui.menu.classList.remove('hidden');
    this.ui.pause.classList.add('hidden');
    this.ui.death.classList.add('hidden');
    this.ui.hud.classList.add('hidden');
    this.walk.enabled = false;
    this.walk.keys.clear();
    if (document.pointerLockElement) document.exitPointerLock();
    this._renderSlots();
  }

  startPlaying() {
    this.mode = 'playing';
    this.touch?.setEnabled(true);
    this.ui.menu.classList.add('hidden');
    this.ui.pause.classList.add('hidden');
    this.ui.death.classList.add('hidden');
    this.ui.hud.classList.remove('hidden');
    this.walk.enabled = true;
    this._updateHud();
    if (!this.isTouch && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
  }

  pauseGame() {
    if (this.mode !== 'playing') return;
    this.mode = 'paused';
    this.touch?.setEnabled(false);
    this.walk.enabled = false;
    this.walk.keys.clear();
    this.walk.velocity.set(0, 0, 0);
    if (document.pointerLockElement) document.exitPointerLock();
    this.ui.pause.classList.remove('hidden');
    this._renderSlots();
  }

  resumeGame() {
    this.mode = 'playing';
    this.touch?.setEnabled(true);
    this.ui.pause.classList.add('hidden');
    this.walk.enabled = true;
    if (!this.isTouch && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
  }

  /** Start a fresh game from the current editor world. */
  newGame() {
    this._loadBaseWorld();
    this.stats = new PlayerStats();
    this._ammo = new Map();
    this._reloading = false;
    const [cx, cy, cz] = this._spawnCell();
    this.walk.spawnAt(cx, cy, cz, ((this.world.spawnYaw ?? 0) * Math.PI) / 180);
    this.startPlaying();
  }

  // --- save slots ---

  saveSlot(i) {
    const player = {
      x: this.walk.position.x,
      y: this.walk.position.y,
      z: this.walk.position.z,
      yaw: this.walk.yaw,
      pitch: this.walk.pitch,
    };
    const bundle = serializeBundle(this.world);
    writeSlot(i, makeSlot({ bundle, player, stats: this.stats.serialize() }), this.storage);
    this._toast(`Saved to slot ${i + 1}`);
    this._renderSlots();
  }

  loadSlot(i) {
    const slot = readSlot(i, this.storage);
    if (!slot) {
      this._toast(`Slot ${i + 1} is empty`);
      return;
    }
    const { world } = deserializeBundle(slot.bundle);
    this._applyWorld(world);
    this.stats = PlayerStats.deserialize(slot.stats);
    this._ammo = new Map();
    this._reloading = false;
    if (slot.player) {
      this.walk.position.set(slot.player.x, slot.player.y, slot.player.z);
      this.walk.yaw = slot.player.yaw ?? 0;
      this.walk.pitch = slot.player.pitch ?? 0;
      this.walk.velocity.set(0, 0, 0);
      this.walk.grounded = false;
      const eye = this.walk.crouching ? this.walk.crouchEye : this.walk.eyeHeight;
      this.walk.camera.position.set(slot.player.x, slot.player.y + eye, slot.player.z);
      this.walk.camera.rotation.set(this.walk.pitch, this.walk.yaw, 0, 'YXZ');
    } else {
      const [cx, cy, cz] = this._spawnCell();
      this.walk.spawnAt(cx, cy, cz, ((this.world.spawnYaw ?? 0) * Math.PI) / 180);
    }
    this._toast(`Loaded slot ${i + 1}`);
    this.startPlaying();
  }

  /** Slot metadata for the menu lists. */
  _slotMeta(i) {
    const slot = readSlot(i, this.storage);
    if (!slot) return { empty: true, label: 'Empty' };
    const d = new Date(slot.savedAt);
    const time = d.toLocaleTimeString?.() ?? `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    return { empty: false, label: `Slot ${i + 1} — ${time}` };
  }

  _renderSlots() {
    for (const el of [this.ui.slotsMenu, this.ui.slotsPause]) {
      if (!el) continue;
      el.innerHTML = '';
      for (let i = 0; i < SLOT_COUNT; i++) {
        const meta = this._slotMeta(i);
        const row = document.createElement('div');
        row.className = 'slot-row';
        const label = document.createElement('span');
        label.textContent = meta.label;
        row.appendChild(label);
        const loadBtn = document.createElement('button');
        loadBtn.textContent = 'Load';
        loadBtn.disabled = meta.empty;
        loadBtn.addEventListener('click', () => this.loadSlot(i));
        row.appendChild(loadBtn);
        if (el === this.ui.slotsPause) {
          const saveBtn = document.createElement('button');
          saveBtn.textContent = 'Save';
          saveBtn.addEventListener('click', () => this.saveSlot(i));
          row.appendChild(saveBtn);
        }
        el.appendChild(row);
      }
    }
  }

  // --- UI wiring ---

  _wireUI() {
    this.ui.btnNew?.addEventListener('click', () => this.newGame());
    this.ui.btnResume?.addEventListener('click', () => this.resumeGame());
    this.ui.btnQuit?.addEventListener('click', () => this.showMenu());
    this.ui.btnRespawn?.addEventListener('click', () => this.newGame());
    this.ui.btnDeathMenu?.addEventListener('click', () => this.showMenu());
  }

  _wireInput() {
    this._unsubs = [];
    const on = (target, type, fn) => {
      target.addEventListener(type, fn);
      this._unsubs.push(() => target.removeEventListener(type, fn));
    };

    on(this.doc, 'keydown', (e) => {
      if (e.code === 'Escape') {
        if (this.mode === 'playing') this.pauseGame();
        else if (this.mode === 'paused') this.resumeGame();
        else if (this.mode === 'dead') this.showMenu();
        return;
      }
      if (this.mode !== 'playing') return;
      // 1-4 select equipment slot
      const digit = parseInt(e.code.slice(-1), 10);
      if (e.code.startsWith('Digit') && digit >= 1 && digit <= EQUIPMENT_SLOTS.length) {
        this._selectSlot(digit - 1);
        return;
      }
      if (e.code === 'KeyF') {
        this._useInjection();
        return;
      }
      if (e.code === 'KeyE') {
        this._pickup();
        return;
      }
      if (e.code === 'KeyR') {
        this._reload();
        return;
      }
      this.walk.onKeyDown(e.code);
    });
    on(this.doc, 'keyup', (e) => {
      if (this.mode === 'playing') this.walk.onKeyUp(e.code);
    });
    on(this.doc, 'mousemove', (e) => {
      if (this.mode === 'playing') this.walk.onMouseMove(e.movementX, e.movementY);
    });
    on(this.doc, 'mousedown', (e) => {
      if (this.mode !== 'playing' || e.button !== 0) return;
      if (!document.pointerLockElement) return;
      this._attack();
    });
    // Losing pointer lock while playing (e.g. browser-requested exit) opens
    // the pause menu instead of leaving the player stuck. Touch devices never
    // enter pointer lock, so they pause on backgrounding instead (below).
    on(this.doc, 'pointerlockchange', () => {
      const locked = document.pointerLockElement === this.webgl.domElement;
      if (!this.isTouch && this.mode === 'playing' && !locked) this.pauseGame();
    });
    // Mobile: when the app is backgrounded, auto-pause (there's no Esc and
    // pointer-lock loss never fires) so the player isn't killed while away.
    on(this.doc, 'visibilitychange', () => {
      if (this.isTouch && document.hidden && this.mode === 'playing') this.pauseGame();
    });
  }

  _toast(text) {
    if (!this.ui.toast) return;
    this.ui.toast.textContent = text;
    this.ui.toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.ui.toast.classList.remove('show'), 1600);
  }
}
