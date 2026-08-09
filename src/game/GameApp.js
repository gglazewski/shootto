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
import { Blinkers } from '../engine/Blinkers.js';
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
import { registerBuiltinQuestItems } from '../engine/QuestItems.js';
import { ammoName } from '../engine/AmmoTypes.js';
import { MICRO_SIZE, gridOf, lightLevelForMeters, rotateMicroPoint } from '../engine/ItemTypes.js';
import { isPassable, isGlass } from '../engine/VoxelTypes.js';
import { isDoorVoxel, isOpenDoor, toggleDoor } from '../engine/Doors.js';
import { BUNDLED_WORLD } from '../bundledWorld.js';
import { SLOT_COUNT, readSlot, writeSlot, makeSlot } from './SaveSlots.js';
import { PlayerStats, MAX_HEALTH, EQUIPMENT_SLOTS } from './PlayerStats.js';
import { weaponFor, FISTS } from './weapons.js';
import { PlayerHand } from './PlayerHand.js';
import { SmokeParticles } from './SmokeParticles.js';
import { GlassParticles } from './GlassParticles.js';
import { BloodFX } from './BloodFX.js';
import { BloodDecals } from './BloodDecals.js';
import { MuzzleFX } from './MuzzleFX.js';
import { MobManager } from './MobManager.js';
import { NPCManager, getNpcType, TALK_BREAK_RANGE } from './NPC.js';
import { listMobs } from '../engine/mobTypes.js';
import { QuestLog } from './quests.js';
import { Dialogue } from './Dialogue.js';
import { deserializeNpcRegistry } from '../engine/NpcRegistry.js';
import { deserializeQuestRegistry } from '../engine/QuestRegistry.js';
import { itemAwarePick, bulletWorld } from '../editor/itemPick.js';
import { buildItemSwatch } from '../editor/items/itemSwatch.js';
import { TouchControls } from './TouchControls.js';
import { PickupFX } from './PickupFX.js';
import { MenuFlyover } from './MenuFlyover.js';
import { loadSplashEntries } from './SplashScreens.js';
import { BUNDLED_SPLASH } from './splashPack.js';

/** Fallback reload time (seconds) when a weapon profile has none set. */
const RELOAD_TIME = 1.4;

/** How close the crosshair has to be to a placed item before E picks it up,
 *  in cells (2 cells = 1 m). Doors keep the longer interact ray. */
const PICKUP_RANGE = 2;

/** How far the door interact ray reaches, in cells (2 cells = 1 m). Longer
 *  than arm's reach so you can open a door while walking at it, but short
 *  enough that you have to be at the doorway, not across the room. */
const DOOR_RANGE = 5;

// Aim bloom: each shot widens the current spread by BLOOM_KICK (radians), and
// it recovers toward the weapon's base spread at BLOOM_DECAY per second. Fire
// faster than it recovers and the crosshair opens up; wait for a full recovery
// and the next shot starts tight again.
const BLOOM_KICK = 0.01;   // radians added to the shot cone per shot fired
const BLOOM_DECAY = 0.014; // radians of bloom recovered per second
// Crosshair pixels of offset per radian of (base + bloom) spread. 0.02 rad
// (the default pistol) opens the reticle a few pixels; heavy bloom reads wide.
const SPREAD_PX_PER_RAD = 300;

// Stopping power: seconds a gun hit stops a mob (it can't move or attack).
// The physical shove itself scales with the weapon's knockback (see weapons).
const STAGGER_TIME = 0.3;

/** Seconds each menu splash screen plays before the next one is picked. */
const SPLASH_SECONDS = 3;

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
    this.blinkers = new Blinkers(this.world);
    this.webgl = new THREE.WebGLRenderer({ antialias: !this.isTouch });
    if (this.isTouch) this.webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.container.appendChild(this.webgl.domElement);
    const { texture, tileIndexFor, atlas, rebuild } = createAtlasTexture(THREE);
    this.rebuildAtlas = rebuild;
    // The game starts shortly after nightfall (the editor keeps its day start),
    // so a fresh run faces most of the night before the first dawn.
    this.renderer = new Renderer({
      THREE, webgl: this.webgl, world: this.world, atlasTexture: texture, tileIndexFor, atlas,
      config: { lighting: { dayNightStart: 0.4 } },
    });

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
          pickup: () => this._interact(),
          selectSlot: (i) => this._selectSlot(i),
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

    // Cinematic main-menu background: a slow camera lap over the loaded map
    // (rebuilt in _applyWorld, driven from _frame while in the menu).
    this.menuFly = new MenuFlyover({ THREE, world: this.world, camera: this.renderer.camera });
    // Authored splash screens (editor-captured camera shots in library
    // worlds). Loaded async in start(); each menu visit shows the next one
    // from a shuffle bag. Empty list -> the procedural flyover above.
    this._splashEntries = [];
    this._splashBag = [];
    this._splashTimer = 0;
    this._lastSplash = null; // entry currently on screen (repeat/reload guard)
    // The splash list loads async; until it resolves the menu hides the scene
    // behind an opaque backdrop, so the procedural flyover is never the first
    // thing seen when authored shots exist.
    this._splashesReady = false;
    this._defaultFov = this.renderer.camera.fov;

    // --- player state ---
    this.stats = new PlayerStats();
    this._attackCooldown = 0;
    this._firing = false; // LMB held — autofire (see _frame)
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
    this.smoke = new SmokeParticles({
      THREE,
      scene: this.renderer.scene,
      lightField: this.renderer.light,
      material: this.renderer.itemMaterial,
    });
    // Glass shards when a shot crosses a glass pane (see _burstGlass).
    this.glassFX = new GlassParticles({
      THREE,
      scene: this.renderer.scene,
      lightField: this.renderer.light,
      material: this.renderer.itemMaterial,
    });
    // Blood splatter when a mob is hit (spawned in front of its billboard).
    this.blood = new BloodFX({ THREE, scene: this.renderer.scene });
    // Blood stains stamped onto walls/floors through the decal system.
    this.bloodDecals = new BloodDecals({ world: this.world });
    this.mobs = new MobManager({
      THREE,
      scene: this.renderer.scene,
      world: this.world,
      lightField: this.renderer.light,
      material: this.renderer.itemMaterial,
      camera: this.renderer.camera,
      onDamagePlayer: (amount, pos) => this._mobHitsPlayer(amount, pos),
    });

    // Friendly, talkable characters (see NPC.js). Rendered through the same
    // billboard pipeline as mobs, but with no AI and no combat.
    this.npcs = new NPCManager({
      THREE,
      scene: this.renderer.scene,
      world: this.world,
      lightField: this.renderer.light,
      material: this.renderer.itemMaterial,
      camera: this.renderer.camera,
    });
    this._talkNpc = null; // NPC in talk range this frame (E starts the chat)
    this._dialog = null; // open conversation: { npc, convo: Dialogue }
    // Quest state: NPCs are the quest givers (see quests.js). Reset on new
    // game, serialized into save slots.
    this.quests = new QuestLog();

    // Highlight shown over a placed equippable item you're aiming at (E picks
    // it up): an outline traced around the item's own shape, not a box over
    // the cells it sits in. The geometry is swapped in per aimed item
    // (_showItemOutline); it draws over the item so it reads as a highlight.
    this._pickupOutline = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x66ccff, depthTest: false, depthWrite: false }),
    );
    this._pickupOutline.visible = false;
    this._pickupOutline.frustumCulled = false;
    this._pickupOutline.renderOrder = 999;
    this.renderer.scene.add(this._pickupOutline);
    this._pickupOutlineKey = null; // placement the outline geometry was built for
    this._pickupTarget = null;

    // Flying copy of a picked-up item: it arcs up and floats to the player
    // before the item is actually granted (see _pickup / _grantPickup).
    this.pickupFX = new PickupFX({
      THREE,
      scene: this.renderer.scene,
      camera: this.renderer.camera,
      lightField: this.renderer.light,
      material: this.renderer.itemMaterial,
    });

    // Muzzle by-products: sparks + smoke when a ranged weapon fires. The flash
    // itself lives on the held weapon (PlayerHand.muzzleFlash) so it sticks to
    // the barrel while the player moves.
    this.muzzleFX = new MuzzleFX({
      THREE,
      scene: this.renderer.scene,
      lightField: this.renderer.light,
      material: this.renderer.itemMaterial,
    });
    this._muzzlePos = new THREE.Vector3();
    this._flashLightVec = new THREE.Vector3();

    // Ammo per weapon id + reload state.
    this._ammo = new Map(); // itemId -> { current, max }
    this._reloading = false;
    this._reloadTimer = 0;
    this._reloadWeapon = null;

    // Aim bloom: transient spread added per shot, decaying back toward the
    // weapon's base spread (see _aimDir / _shoot / _updateCrosshair).
    this._bloom = 0;
    this._bloomWeapon = null; // id of the weapon the bloom belongs to

    // Pickups waiting to float to the player: rapid E presses queue items up
    // so each one is granted in turn as its flight lands (see _pickup /
    // _pumpPickupQueue).
    this._pickupQueue = [];

    // --- UI ---
    this.ui = {
      menu: this.doc.querySelector('#menu'),
      pause: this.doc.querySelector('#pause'),
      hud: this.doc.querySelector('#hud'),
      toast: this.doc.querySelector('#toast'),
      pickup: this.doc.querySelector('#pickup'),
      dialog: this.doc.querySelector('#dialog'),
      dialogName: this.doc.querySelector('#dialog-name'),
      dialogText: this.doc.querySelector('#dialog-text'),
      dialogChoices: this.doc.querySelector('#dialog-choices'),
      dialogHint: this.doc.querySelector('#dialog-hint'),
      quest: this.doc.querySelector('#quest'),
      questList: this.doc.querySelector('#quest-list'),
      crosshair: this.doc.querySelector('#crosshair'),
      slotsMenu: this.doc.querySelector('#slots-menu'),
      slotsPause: this.doc.querySelector('#slots-pause'),
      healthFill: this.doc.querySelector('#health-fill'),
      healthText: this.doc.querySelector('#health-text'),
      armorFill: this.doc.querySelector('#armor-fill'),
      armorText: this.doc.querySelector('#armor-text'),
      equipment: this.doc.querySelector('#equipment'),
      hand: this.doc.querySelector('#hand'),
      ammo: this.doc.querySelector('#ammo'),
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
    this._initSplashes();
    return this;
  }

  /** Fetch the splash list (server or embedded pack) and, if the menu is
   *  still up, swap the procedural flyover for the first authored shot. */
  async _initSplashes() {
    try {
      this._splashEntries = await loadSplashEntries(undefined, BUNDLED_SPLASH);
    } catch {
      this._splashEntries = [];
    }
    if (this._splashEntries.length && this.mode === 'menu') this._showNextSplash();
    // Reveal the scene only now: either an authored shot is framed, or there
    // are none and the procedural flyover is the intended background.
    this._splashesReady = true;
    this.ui.menu?.classList.remove('cover');
  }

  /** Show the next authored splash behind the menu: load its world into the
   *  scene and pin the camera to the captured pose. Draws from a shuffle bag
   *  (pseudo-random: every shot appears before any repeats, and the same
   *  shot never plays twice in a row). */
  _showNextSplash() {
    this._splashTimer = 0;
    // A lone shot just keeps playing — restarting it would stutter.
    if (this._splashEntries.length === 1 && this._lastSplash === this._splashEntries[0]) return;
    while (this._splashEntries.length) {
      if (!this._splashBag.length) {
        this._splashBag = this._splashEntries.map((_, i) => i);
        for (let i = this._splashBag.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [this._splashBag[i], this._splashBag[j]] = [this._splashBag[j], this._splashBag[i]];
        }
      }
      let idx = this._splashBag.pop();
      // A refilled bag may lead with the shot already on screen — swap it
      // deeper into the bag so it comes back later instead of repeating.
      if (this._splashEntries[idx] === this._lastSplash && this._splashBag.length) {
        const next = this._splashBag.pop();
        this._splashBag.push(idx);
        idx = next;
      }
      const entry = this._splashEntries[idx];
      const { world, fatal } = deserializeBundle(entry.worldText);
      const cam = fatal ? null : world.splashCams.find((c) => c.id === entry.camId);
      if (!cam) {
        // Stale manifest entry (world or cam deleted) — drop it and try the next.
        this._splashEntries = this._splashEntries.filter((e) => e !== entry);
        this._splashBag = [];
        continue;
      }
      // Cuts between cams of the same world skip the full scene rebuild.
      if (entry.worldText !== this._lastSplash?.worldText) this._applyWorld(world);
      this._lastSplash = entry;
      this.menuFly.setSplash(cam);
      this.renderer.camera.fov = cam.fov ?? this._defaultFov;
      this.renderer.camera.updateProjectionMatrix();
      return;
    }
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
      // Held fire (mouse button or touch button): attack every frame — the
      // weapon's cooldown throttles it to its fire rate.
      if (this._firing || this.touch?.attacking) this._attack();
      this._updatePickup();
      this.mobs.update(dt, this.walk.position, this._viewFacing());
      this.npcs.update(dt);
      // Walking away mid-chat ends the conversation.
      if (this._dialog) {
        const npc = this._dialog.npc;
        const p = this.walk.position;
        if (Math.hypot(p.x - npc.pos.x, p.z - npc.pos.z) > TALK_BREAK_RANGE) this._closeDialog();
      }
    } else {
      // The menu hovers over a slow flyover of the map instead of a frozen
      // first-person view.
      if (this.mode === 'menu') {
        // Hold the flyover still while the backdrop covers it — it would just
        // fly a lap nobody sees, and the fallback should start from its start.
        if (this._splashesReady || this.menuFly.splash) this.menuFly.update(dt);
        // Authored shots rotate every few seconds — only with 2+ shots, so a
        // lone shot (or the procedural flyover) just keeps playing.
        if (this._splashEntries.length > 1) {
          this._splashTimer += dt;
          if (this._splashTimer >= SPLASH_SECONDS) this._showNextSplash();
        }
      }
      this._hidePickup();
      this._closeDialog();
    }
    if (this._attackCooldown > 0) this._attackCooldown = Math.max(0, this._attackCooldown - dt);
    if (this._bloom > 0) this._bloom = Math.max(0, this._bloom - BLOOM_DECAY * dt);
    this._updateCrosshair();
    if (this._reloading) {
      this._reloadTimer -= dt;
      if (this._reloadTimer <= 0) this._finishReload();
    }
    this.hand.update(dt);
    this.smoke.update(dt);
    this.glassFX.update(dt);
    this.blood.update(dt);
    this.muzzleFX.update(dt);
    this.pickupFX.update(dt);
    this.itemRenderer.update();
    this._updateFlashLight();
    this.blinkers.update(dt);
    // Day/night time only advances while actually playing (frozen in menu/pause).
    this.renderer.render(this.mode === 'playing' ? dt : 0);
  }

  /** Player view direction on the ground plane ({x,z} unit vector), used by
   *  mob flankers to approach from outside the view cone. Null when looking
   *  straight up/down (no meaningful ground direction). */
  _viewFacing() {
    const dir = this.renderer.camera.getWorldDirection(this._facingScratch ??= new THREE.Vector3());
    const len = Math.hypot(dir.x, dir.z);
    if (len < 1e-3) return null;
    this._facingOut ??= { x: 0, z: 0 };
    this._facingOut.x = dir.x / len;
    this._facingOut.z = dir.z / len;
    return this._facingOut;
  }

  /** Push the muzzle flash (if any) into the light engine so the world around
   *  the barrel lights up while a gun fires, then fades as the flash dies. */
  _updateFlashLight() {
    const state = this.hand.flashWorld(this._flashLightVec);
    this.renderer.setFlashLight(state ? state.pos : this._flashLightVec, state ? state.intensity : 0);
  }

  // --- world loading (shares the editor's localStorage) ---

  /** Load the editor's current map + objects (falling back to the bundled
   *  world), so editor saves show up after a refresh. The item registries are
   *  loaded FIRST so placed placeable/equippable items resolve when the map is
   *  deserialized (otherwise they are skipped as unregistered). */
  _loadBaseWorld() {
    this._loadItems();
    this._loadEquipItems();
    this._loadNpcData();
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
    // Built-in quest items first — an authored def under the same id wins.
    registerBuiltinQuestItems();
    const text = this.storage?.getItem(CONFIG.equipSaveKey);
    if (text) {
      deserializeEquipRegistry(text);
    } else if (Array.isArray(BUNDLED_WORLD?.equip)) {
      deserializeEquipRegistry(JSON.stringify(BUNDLED_WORLD.equip));
    }
  }

  /** Load the NPC + quest registries (F4 editor) so placed NPC spawns resolve
   *  and questlines are the authored ones. Same sources as the other
   *  registries: the editor's localStorage or the deployed bundle. Must run
   *  BEFORE the map deserializes — unregistered NPC spawns are skipped. */
  _loadNpcData() {
    const npcText = this.storage?.getItem(CONFIG.npcSaveKey);
    if (npcText) {
      deserializeNpcRegistry(npcText);
    } else if (Array.isArray(BUNDLED_WORLD?.npcs)) {
      deserializeNpcRegistry(JSON.stringify(BUNDLED_WORLD.npcs));
    }
    const questText = this.storage?.getItem(CONFIG.questSaveKey);
    if (questText) {
      deserializeQuestRegistry(questText);
    } else if (BUNDLED_WORLD?.quests && typeof BUNDLED_WORLD.quests === 'object') {
      deserializeQuestRegistry(JSON.stringify(BUNDLED_WORLD.quests));
    }
  }

  /** Replace the live world with `loaded` and rebuild. Uses the one shared
   *  copy path (World.copyFrom), so block rotation, decals, items and spawns
   *  all survive into the game exactly as the editor placed them. */
  _applyWorld(loaded) {
    this.world.copyFrom(loaded);
    // Maps can carry text sign decals registered during deserialization —
    // fold their runtime tiles into the atlas before chunks are meshed.
    this.rebuildAtlas();
    this.blinkers.rescan();
    this.renderer.clearChunks();
    this.renderer.loadWorldBounds();
    this.itemRenderer.rebuildAll();
    this.smoke.clear();
    this.glassFX.clear();
    this.blood.clear();
    this.bloodDecals.reset();
    this.mobs.rebuild();
    this.npcs.rebuild(this._npcSpawns());
    this._refreshItemLights();
    this.menuFly.rebuild();
  }

  /** Seed the light field from light-emitting placed items and re-bake. */
  _refreshItemLights() {
    const lights = [];
    this.world.forEachItem((placement) => {
      const def = getItem(placement.itemId);
      if (!def?.light) return;
      const cellSize = MICRO_SIZE;
      const grid = gridOf(def);
      const l = def.light;
      const yaw = placement.rotation ?? 0;
      const [lx, lz] = rotateMicroPoint(l.x, l.z, yaw, grid[0], grid[2]);
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
    // Kill count is still tracked (this.mobs.kills) but not displayed.
    this.touch?.setActiveSlot(this.stats.activeSlot);
    this._renderMobileSlots();
    this._updateHeldItem();
    this._renderEquipment();
    this._updateAmmoHud();
  }

  /** Show magazine ammo for ranged weapons as `in-mag / carried`. Weapons
   *  without a magazine (fists/melee) show infinite ammo (`∞/∞`) so the
   *  counter is always present. */
  _updateAmmoHud() {
    const el = this.ui.ammo;
    if (!el) return;
    const weapon = this.stats.activeItemId ? weaponFor(this.stats.activeItemId) : FISTS;
    const max = weapon.magazine ?? 0;
    if (weapon.kind !== 'ranged' || max <= 0) {
      el.classList.remove('hidden');
      el.textContent = '∞/∞';
      return;
    }
    const ammo = this._ammoFor(weapon);
    const carried = this._carriedAmmo(ammo);
    el.classList.remove('hidden');
    el.textContent = `${ammo.current}/${carried}`;
  }

  /** Show the equipped item in the hand (empty slot = fists). Called whenever
   *  the HUD refreshes, i.e. on equip, slot switch, pickup, load, new game.
   *  Switching weapons also resets the aim bloom, so a fresh weapon starts
   *  tight. */
  _updateHeldItem() {
    const id = this.stats.activeItemId;
    if (id !== this._bloomWeapon) {
      this._bloomWeapon = id ?? null;
      this._bloom = 0;
    }
    const def = id ? (getItem(id) ?? getEquipItem(id)) : null;
    this.hand.setHeldItem(def);
  }

  /** Reflect the current aim spread in the crosshair: the four segments open
   *  up as the weapon's base spread grows and as firing adds bloom, and close
   *  back down as the bloom recovers (see BLOOM_* / SPREAD_PX_PER_RAD).
   *  Fists/melee and perfectly accurate weapons stay tight. */
  _updateCrosshair() {
    const el = this.ui.crosshair;
    if (!el) return;
    const weapon = this.stats.activeItemId ? weaponFor(this.stats.activeItemId) : FISTS;
    const spread = (weapon.spread ?? 0) + this._bloom;
    const px = Math.round(spread * SPREAD_PX_PER_RAD);
    el.style.setProperty('--spread', `${px}px`);
  }

  /** Render the four equipment slots (bottom hotbar) with item icons like the
   *  editor's inventory, and the current "hand". */
  _renderEquipment() {
    const el = this.ui.equipment;
    if (!el) return;
    el.innerHTML = '';
    EQUIPMENT_SLOTS.forEach((slot, i) => {
      const id = this.stats.equipment[slot];
      const item = id ? getItem(id) ?? getEquipItem(id) : null;
      const div = document.createElement('div');
      div.className = `eq-slot${i === this.stats.activeSlot ? ' active' : ''}`;
      div.title = item ? `${item.name} (${i + 1})` : `Empty slot (${i + 1})`;
      const slotLabel = document.createElement('span');
      slotLabel.className = 'eq-slot-label';
      slotLabel.textContent = String(i + 1);
      div.appendChild(slotLabel);
      if (item) {
        div.appendChild(buildItemSwatch(item, 48));
      } else {
        const name = document.createElement('span');
        name.className = 'eq-slot-name';
        name.textContent = '—';
        div.appendChild(name);
      }
      div.addEventListener('click', () => this._selectSlot(i));
      el.appendChild(div);
    });
    if (this.ui.hand) {
      const weapon = this.stats.activeItemId ? weaponFor(this.stats.activeItemId) : FISTS;
      this.ui.hand.textContent = weapon.name;
    }
  }

  /** Mirror the equipment icons into the mobile hotbar slots (they show the
   *  slot number while empty, the item icon once something is equipped). */
  _renderMobileSlots() {
    if (!this.isTouch) return;
    const wrap = this.doc.querySelector('#slots-mobile');
    if (!wrap) return;
    wrap.querySelectorAll('.slot-btn').forEach((btn, i) => {
      const id = this.stats.equipment[EQUIPMENT_SLOTS[i]];
      const item = id ? getItem(id) ?? getEquipItem(id) : null;
      const old = btn.querySelector('canvas');
      if (old) btn.removeChild(old);
      if (item) {
        btn.textContent = '';
        btn.appendChild(buildItemSwatch(item, 36));
      } else if (!btn.textContent.trim()) {
        btn.textContent = String(i + 1);
      }
    });
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
    const dir = this._aimDir(weapon);
    this._burstGlass(dir, weapon.range);
    const impact = this._attackImpact(weapon, dir);
    if (impact) this._resolveImpact(impact, weapon, dir);
  }

  /** Shot/swing feedback on glass: attacks pass through glass panes (they
   *  are shoot-through), but the first pane the ray crosses bursts a spray
   *  of shards at the impact point — shattering feedback without stopping
   *  the bullet. The probe ray sees the full world, so glass hiding behind
   *  a solid wall never sparks. */
  _burstGlass(dir, rangeCells) {
    const hit = itemAwarePick(this.world, THREE, this.renderer.camera, rangeCells, dir);
    if (!hit || hit.item) return;
    const voxel = this.world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!voxel || !isGlass(voxel.type)) return;
    const cam = this.renderer.camera;
    const d = hit.dist * CELL_SIZE;
    this.glassFX.burst(
      [cam.position.x + dir.x * d, cam.position.y + dir.y * d, cam.position.z + dir.z * d],
      dir,
    );
  }

  /**
   * Aim direction for a weapon's shot: the camera's forward vector nudged by a
   * random angle within the weapon's current spread (base + aim bloom, see
   * _shoot / _updateCrosshair), so shots land in a cone around the crosshair
   * instead of dead-center every time — a cone that grows as you fire. The
   * zero base-spread of fists/melee stays exact. The same direction feeds the
   * voxel raycast, the mob raycast and the muzzle flash, so they all agree.
   */
  _aimDir(weapon) {
    const dir = this.renderer.camera.getWorldDirection(new THREE.Vector3());
    const spread = (weapon.spread ?? 0) + this._bloom;
    if (spread <= 0) return dir;
    // Uniform over the disc (sqrt for area-uniform scatter).
    const angle = Math.random() * Math.PI * 2;
    const r = spread * Math.sqrt(Math.random());
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(dir, up);
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0); // looking straight up/down
    else side.normalize();
    const perp = new THREE.Vector3().crossVectors(side, dir).normalize();
    return dir
      .addScaledVector(side, Math.cos(angle) * r)
      .addScaledVector(perp, Math.sin(angle) * r)
      .normalize();
  }

  /**
   * First thing the aim ray hits within the weapon's reach: a mob, the world,
   * or nothing. A mob is hit only when it lies before any voxel (bullets and
   * swings are blocked by walls, Doom-style). `dir` is the shot direction
   * (spread-nudged for ranged weapons).
   * @returns {{mob: object}|{pos:[number,number,number]}|null}
   */
  _attackImpact(weapon, dir = this._aimDir(weapon)) {
    const voxelHit = this._aim(weapon.range, dir);
    const cam = this.renderer.camera;
    const voxelDist = voxelHit
      ? Math.hypot(voxelHit[0] - cam.position.x, voxelHit[1] - cam.position.y, voxelHit[2] - cam.position.z)
      : Infinity;
    const mobHit = this.mobs.aimHit(cam, dir);
    const maxMeters = weapon.range * CELL_SIZE;
    if (mobHit && mobHit.dist < voxelDist && mobHit.dist <= maxMeters) return { mob: mobHit.mob, dist: mobHit.dist };
    return voxelHit ? { pos: voxelHit } : null;
  }

  /** Apply an attack impact: damage a mob (with kill credit) or puff smoke.
   *  `dir` is the shot/attack direction — gun hits carry their stopping power
   *  along it (see _hitImpact). */
  _resolveImpact(impact, weapon, dir) {
    if (impact.mob) {
      this._damageMob(impact.mob, weapon.damage, weapon, dir, impact.dist);
      return;
    }
    this.smoke.puff(impact.pos);
  }

  /** Damage a mob; count and puff smoke when it dies. */
  _damageMob(mob, damage, weapon, dir, dist) {
    // The victim learns where the shot came from (its packmates hear about it
    // through the alarm), so mobs hunt the shooter's position, not a ghost.
    const impact = this._hitImpact(weapon, dir, mob);
    const died = mob.takeDamage(damage, this.walk.position, impact);
    this._spawnBlood(mob, dir, dist);
    this.bloodDecals.splatter(mob, dir, died);
    if (died) {
      this.mobs.kills++;
      this._questEvents(this.quests.onKill(mob.type.id));
    }
    this._updateHud();
  }

  /** Blood splatter at the point the shot struck — feedback for WHERE you hit
   *  (head, side, legs), not a generic mid-body puff. `dist` is the ray
   *  distance from the camera to the mob's box; without it (no aim ray to
   *  reconstruct) the blood falls back to the mob's near side at chest height.
   *  Droplets spray toward the viewer. */
  _spawnBlood(mob, dir, dist) {
    const cam = this.renderer.camera;
    // Toward the camera on the ground plane (the sprite faces the camera).
    let bx = cam.position.x - mob.pos.x;
    let bz = cam.position.z - mob.pos.z;
    const h = Math.hypot(bx, bz) || 1;
    bx /= h;
    bz /= h;
    let pos;
    if (dist != null) {
      // Where the aim ray entered the mob's box, pulled a touch back along
      // the ray so the burst sits just off the surface.
      const d = Math.max(0, dist - 0.08);
      pos = new THREE.Vector3(
        cam.position.x + dir.x * d,
        cam.position.y + dir.y * d,
        cam.position.z + dir.z * d,
      );
    } else {
      const off = mob.halfWidth + 0.15;
      pos = new THREE.Vector3(
        mob.pos.x + bx * off,
        mob.pos.y + mob.height * 0.45,
        mob.pos.z + bz * off,
      );
    }
    // Splatter mostly toward the viewer, nudge the spray a touch along the
    // shot so a side hit reads as blood flying across.
    this.blood.burst(pos, { x: bx + dir.x * 0.3, y: 0.4, z: bz + dir.z * 0.3 }, mob);
  }

  /** Stopping power of a hit on a mob: gun hits stagger it (stop its movement
   *  and cancel any attack wind-up); powerful shots also knock it back along
   *  the bullet path. Melee swings only flinch — no impact. */
  _hitImpact(weapon, dir, mob) {
    if (weapon.kind !== 'ranged') return null;
    const kb = weapon.knockback ?? 0;
    if (kb <= 0) return { stagger: STAGGER_TIME };
    // Shove along the shot on the ground plane. Looking straight down/up has
    // no horizontal direction to speak of — knock the mob away from the
    // player instead.
    let kx = dir.x;
    let kz = dir.z;
    const h = Math.hypot(kx, kz);
    if (h < 1e-3) {
      kx = mob.pos.x - this.walk.position.x;
      kz = mob.pos.z - this.walk.position.z;
      const h2 = Math.hypot(kx, kz) || 1;
      kx /= h2;
      kz /= h2;
    } else {
      kx /= h;
      kz /= h;
    }
    return { stagger: STAGGER_TIME, knockX: kx * kb, knockZ: kz * kb };
  }

  /** A mob landed a strike on the player. */
  _mobHitsPlayer(amount, pos) {
    this.smoke.puff([pos.x, pos.y, pos.z]);
    this.stats.damage(amount);
    this._updateHud();
    this._hitFlash();
    if (this.stats.isDead) this.gameOver();
  }

  /** Flash the hit feedback (red vignette + slight blur) by toggling body.hurt.
   *  The flash scales with missing health: the lower your HP, the brighter and
   *  wider the red vignette and the stronger the blur. Restarting the class
   *  with a reflow lets rapid successive hits keep the full-intensity flash
   *  instead of skipping mid-animation; the hurt class is dropped when the
   *  vignette animation ends (see _wireUI). */
  _hitFlash() {
    const body = this.doc.body;
    if (!body) return;
    // 0 at full health -> 1 at zero health; scales the flash intensity.
    const low = 1 - Math.max(0, Math.min(1, this.stats.health / MAX_HEALTH));
    body.style.setProperty('--hit-int', (0.7 + 0.3 * low).toFixed(2)); // 0.7..1.0 peak opacity
    body.style.setProperty('--hit-blur', `${(2 + 4 * low).toFixed(2)}px`); // 2..6 px blur
    body.style.setProperty('--hit-stop', `${(55 - 15 * low).toFixed(1)}%`); // 55%..40% vignette edge
    body.classList.remove('hurt');
    void body.offsetWidth;
    body.classList.add('hurt');
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
    // Aim with the PRE-shot bloom (what earlier shots accumulated) so a fresh
    // gun fires exactly at the crosshair; the kick below widens the cone for
    // the NEXT shot. It recovers back to the weapon's base spread while you're
    // not firing (_frame decays _bloom).
    const dir = this._aimDir(weapon);
    this._burstGlass(dir, weapon.range);
    this._bloom += BLOOM_KICK;
    const muzzle = this.hand.heldMuzzleWorld(this._muzzlePos);
    if (muzzle) {
      this.muzzleFX.burst(muzzle, dir);
    }
    // One trigger pull = one round, one recoil/flash — but every pellet
    // scatters on its own within the spread cone (shotguns fire several,
    // each dealing the weapon's damage independently).
    const pellets = Math.max(1, weapon.pellets ?? 1);
    for (let i = 0; i < pellets; i++) {
      const pdir = i === 0 ? dir : this._aimDir(weapon);
      const impact = this._attackImpact(weapon, pdir);
      if (impact) this._resolveImpact(impact, weapon, pdir);
    }
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
   *  range directly controls how far a shot can land. `dir` overrides the aim
   *  direction (weapon spread). Shoot-through blocks (chain-link fence, bars,
   *  barricades) are invisible to this ray — attacks pass through them. */
  _aim(maxCells = MAX_RAY_DISTANCE, dir) {
    const { camera } = this.renderer;
    const hit = itemAwarePick(bulletWorld(this.world), THREE, this.renderer.camera, maxCells, dir);
    if (!hit || hit.dist > maxCells) return null;
    // The raycaster's `dist` is the cell distance along the ray to the surface
    // it entered — the exact impact point, not the middle of the voxel.
    const dvec = dir ?? camera.getWorldDirection(new THREE.Vector3());
    const d = hit.dist * CELL_SIZE; // cell units -> world units
    return [
      camera.position.x + dvec.x * d,
      camera.position.y + dvec.y * d,
      camera.position.z + dvec.z * d,
    ];
  }

  // --- interact: item pickup + doors (aim, press E) ---

  /** What the E key would act on under the crosshair: a placed equippable
   *  item ({cell, item}), a door voxel ({cell, door}), or null. Pickable
   *  items only come from the equipment registry (F3 editor) — placeable
   *  objects are world decoration and stay put. Short-range, so the
   *  per-frame aim ray stays cheap; items need arm's reach (PICKUP_RANGE),
   *  doors open from DOOR_RANGE.
   *
   *  The primary ray treats OPEN doors as air: their footprint fills the
   *  whole doorway, and it must not eat pickups sitting just beyond it. A
   *  second ray (only when the first found nothing) hits those open cells so
   *  the door can be closed again. */
  _pickTarget() {
    const doorTransparent = {
      get: (x, y, z) => {
        const v = this.world.get(x, y, z);
        return v && isPassable(v.type) ? null : v;
      },
      itemAt: (x, y, z) => this.world.itemAt(x, y, z),
    };
    const hit = itemAwarePick(doorTransparent, THREE, this.renderer.camera, DOOR_RANGE);
    if (hit) {
      const voxel = this.world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
      if (isDoorVoxel(voxel)) return { cell: hit.cell, door: voxel };
      const item = this.world.itemAt(hit.cell[0], hit.cell[1], hit.cell[2]);
      if (item && hit.dist <= PICKUP_RANGE) {
        const def = getEquipItem(item.itemId);
        if (def && this._pickable(def)) return { cell: hit.cell, item };
      }
      return null;
    }
    const openHit = itemAwarePick(this.world, THREE, this.renderer.camera, DOOR_RANGE);
    if (!openHit) return null;
    const voxel = this.world.get(openHit.cell[0], openHit.cell[1], openHit.cell[2]);
    if (isDoorVoxel(voxel)) return { cell: openHit.cell, door: voxel };
    return null;
  }

  /** Whether the E key acknowledges this equip item at all. Quest items are
   *  invisible to interaction until a quest actively wants them — before the
   *  quest they're scenery, after the objective they're scenery again. */
  _pickable(def) {
    return def.kind !== 'quest' || this.quests.wantsItem(def);
  }

  /** Track what the crosshair is aiming at: show the highlight + prompt on a
   *  pickable item or door, clear both otherwise. Called every frame while
   *  playing. */
  _updatePickup() {
    // While a conversation is open there is nothing else to prompt for.
    if (this._dialog) {
      this._hidePickup();
      return;
    }
    const target = this._pickTarget();
    this._pickupTarget = target;
    // NPCs are proximity-based (no aiming needed) but the crosshair target
    // wins: aiming straight at a pickup next to the granny still picks it up.
    this._talkNpc = target ? null : this.npcs.nearest(this.walk.position, this._viewFacing());
    if (!target) {
      if (this._talkNpc) {
        this._hideOutline();
        if (this.ui.pickup) {
          this.ui.pickup.innerHTML = `Press <kbd>E</kbd> to talk to ${this._talkNpc.name}`;
          this.ui.pickup.classList.remove('hidden');
        }
      } else {
        this._hidePickup();
      }
      return;
    }
    if (target.door) {
      // Doors get the prompt only — no highlight over the whole leaf.
      this._hideOutline();
      if (this.ui.pickup) {
        this.ui.pickup.innerHTML = `Press <kbd>E</kbd> to ${isOpenDoor(target.door) ? 'close' : 'open'} the door`;
        this.ui.pickup.classList.remove('hidden');
      }
      return;
    }
    const def = getEquipItem(target.item.itemId);
    this._showItemOutline(target.item);
    if (this.ui.pickup) {
      this.ui.pickup.innerHTML = `Press <kbd>E</kbd> to pick up ${def?.name ?? target.item.itemId}`;
      this.ui.pickup.classList.remove('hidden');
    }
  }

  /** Trace the highlight around the aimed item's own silhouette. The edge
   *  geometry is rebuilt only when the aimed placement changes — while you
   *  keep looking at the same item the outline just stays put. */
  _showItemOutline(placement) {
    const key = placement.anchor.join(',');
    if (key !== this._pickupOutlineKey) {
      // Null while the item's mesh is still pending (ItemRenderer builds it
      // later in the same frame) — the next frame picks it up.
      const outline = this.itemRenderer.outlineFor(placement);
      if (!outline) {
        this._hideOutline();
        return;
      }
      this._pickupOutline.geometry.dispose();
      this._pickupOutline.geometry = outline.geometry;
      this._pickupOutline.scale.setScalar(outline.scale);
      this._pickupOutline.position.set(outline.position[0], outline.position[1], outline.position[2]);
      this._pickupOutlineKey = key;
    }
    this._pickupOutline.visible = true;
  }

  _hideOutline() {
    this._pickupOutline.visible = false;
    this._pickupOutlineKey = null;
  }

  _hidePickup() {
    this._pickupTarget = null;
    this._talkNpc = null;
    this._hideOutline();
    if (this.ui.pickup) this.ui.pickup.classList.add('hidden');
  }

  // --- NPC dialog (proximity, press E; replies pick with 1-9 or tap) ---

  /** The E key / touch PICK button: advance an open dialog, start one with a
   *  nearby NPC, or fall through to the aimed pickup/door. While replies are
   *  on screen E does nothing — picking is deliberate (digits or tap). */
  _interact() {
    if (this._dialog) {
      if (!this._dialog.convo.choices()) {
        this._dialog.convo.advance();
        this._renderDialog();
      }
      return;
    }
    if (this._talkNpc) {
      this._startDialog(this._talkNpc);
      return;
    }
    this._pickup();
  }

  /** Open a conversation — a Dialogue state machine over the quest log: the
   *  NPC speaks, then the player picks replies (quest offer/turn-in, lore
   *  topics, bye). See Dialogue.js. */
  _startDialog(npc) {
    this._dialog = { npc, convo: new Dialogue({ npc, quests: this.quests }) };
    if (this.isTouch && this.ui.dialogHint) this.ui.dialogHint.textContent = 'Tap PICK to continue';
    this._hidePickup();
    this._renderDialog();
  }

  _renderDialog() {
    const { npc, convo } = this._dialog;
    if (this.ui.dialogName) this.ui.dialogName.textContent = npc.name;
    if (this.ui.dialogText) this.ui.dialogText.textContent = convo.line() ?? '';
    const choices = convo.choices();
    const box = this.ui.dialogChoices;
    if (box) {
      box.replaceChildren();
      for (const [i, choice] of (choices ?? []).entries()) {
        const btn = this.doc.createElement('button');
        const key = this.doc.createElement('kbd');
        key.textContent = String(i + 1);
        btn.append(key, this.doc.createTextNode(choice.label));
        btn.addEventListener('click', () => this._chooseDialog(i));
        box.appendChild(btn);
      }
      box.classList.toggle('hidden', !choices);
    }
    this.ui.dialogHint?.classList.toggle('hidden', !!choices);
    this.ui.dialog?.classList.remove('hidden');
  }

  /** The player picked reply `i` (digit key or tap). Quest effects commit
   *  here — accepting an offer, completing a turn-in. */
  _chooseDialog(i) {
    if (!this._dialog) return;
    const { npc, convo } = this._dialog;
    const choice = convo.choices()?.[i];
    if (!choice) return;
    const result = convo.choose(choice.id);
    if (result?.accepted) {
      this._toast(`New quest: ${result.accepted.title}`);
      // A slay quest with a spawn point materializes its pack the moment the
      // player signs up — picking "I'll do it" was them agreeing to the fight.
      this._spawnQuestMobs(result.accepted.objective, result.accepted.objective.count);
    }
    if (result?.completed) {
      this._toast(`Quest complete: ${result.completed.title}`);
      if (result.reward) this._grantReward(result.reward, npc);
    }
    if (result) this._updateQuestHud();
    if (convo.done) this._closeDialog();
    else this._renderDialog();
  }

  /** Close without applying anything — walking away or pausing mid-chat
   *  leaves unpicked offers and turn-ins for next time. */
  _closeDialog() {
    if (!this._dialog) return;
    this._dialog = null;
    this.ui.dialog?.classList.add('hidden');
  }

  /** Quest reward: flat boosts through the usual PlayerStats paths. Item
   *  rewards ride the pickup queue — each flies from the giver's hands to the
   *  player (same flight as a floor pickup) and is granted on arrival. */
  _grantReward(reward, npc = null) {
    if (reward.health) this.stats.heal(reward.health);
    if (reward.armor) this.stats.repair(reward.armor);
    if (reward.ammo?.type) this.stats.addAmmo(reward.ammo.type, reward.ammo.amount ?? 0);
    for (const id of reward.items ?? []) {
      const def = getEquipItem(id);
      if (!def) continue;
      if (npc) {
        // Chest height on the giver, so the item leaves their hands.
        const start = new THREE.Vector3(npc.pos.x, npc.pos.y + npc.height * 0.6, npc.pos.z);
        this._pickupQueue.push({ def, start, yaw: 0 });
      } else {
        this._grantPickup(def); // no giver in sight — grant instantly
      }
    }
    this._pumpPickupQueue();
    this._updateHud();
  }

  /** React to quest progress events (kills, pickups): toast when an objective
   *  is fulfilled, keep the tracker current. */
  _questEvents(events) {
    for (const ev of events) {
      if (!ev.ready) continue;
      const giver = getNpcType(ev.quest.giver)?.name ?? ev.quest.giver;
      this._toast(`Objective complete — return to ${giver}`);
    }
    if (events.length) this._updateQuestHud();
  }

  /** WoW-style objective tracker top-right: every in-flight quest as a gold
   *  title over an indented objective line. Hidden when nothing is running. */
  _updateQuestHud() {
    if (!this.ui.quest || !this.ui.questList) return;
    const entries = this.quests.trackerEntries();
    if (!entries.length) {
      this.ui.quest.classList.add('hidden');
      return;
    }
    this.ui.questList.textContent = '';
    for (const e of entries) {
      const entry = this.doc.createElement('div');
      entry.className = e.ready ? 'quest-entry ready' : 'quest-entry';
      const title = this.doc.createElement('div');
      title.className = 'q-title';
      title.textContent = e.title;
      const obj = this.doc.createElement('div');
      obj.className = 'q-obj';
      obj.textContent = e.text;
      entry.append(title, obj);
      this.ui.questList.appendChild(entry);
    }
    this.ui.quest.classList.remove('hidden');
  }

  /** Materialize a slay quest's pack: `n` mobs of the objective's target type
   *  around its author-placed spawn point. No-op for objectives without one
   *  (plain kill counts) or non-kill objectives. 'any' spawns the default
   *  zombie type. */
  _spawnQuestMobs(objective, n) {
    if (objective?.type !== 'kill' || !objective.spawnCell || n <= 0) return;
    const typeId = objective.target !== 'any' ? objective.target : listMobs()[0]?.id;
    if (!typeId) return;
    this.mobs.spawnAt(typeId, objective.spawnCell, n);
  }

  /** Re-materialize outstanding slay packs after a load: dynamically spawned
   *  quest mobs aren't part of the world's spawn points, so a save made
   *  mid-quest would otherwise come back with an unfinishable objective.
   *  Spawns only what's still owed (count minus kills already made). */
  _restoreQuestMobs() {
    for (const { quest, progress } of this.quests.activeQuests()) {
      const o = quest.objective;
      this._spawnQuestMobs(o, (o?.count ?? 0) - progress);
    }
  }

  /** Pick up the aimed equippable item. Ammo packs grant their ammo type
   *  (capped by max stack) rather than being equipped; everything else goes
   *  into an equipment slot. The item detaches from the world immediately and
   *  floats to the player first; the actual grant happens in _grantPickup once
   *  it arrives, so it doesn't just vanish into the inventory. Rapid pickups
   *  queue up — each item flies and is granted one at a time. */
  _pickup() {
    const target = this._pickupTarget;
    if (!target) return;
    if (target.door) {
      this._toggleDoor(target.door);
      return;
    }
    const def = getEquipItem(target.item.itemId);
    if (!def) return;
    this._hidePickup();
    const [ax, ay, az] = target.item.anchor;
    this.world.removeItemAt(ax, ay, az);
    const [hx, hy, hz] = gridOf(def).map((g) => (g * MICRO_SIZE) / 2);
    const start = new THREE.Vector3(ax * CELL_SIZE + hx, ay * CELL_SIZE + hy, az * CELL_SIZE + hz);
    this._pickupQueue.push({ def, start, yaw: target.item.rotation ?? 0 });
    this._pumpPickupQueue();
  }

  /** Toggle a door voxel and refresh the mob navmeshes: a closed door seals
   *  the doorway (mobs can't open doors — they re-route or give up), an
   *  opened one lets them path through. */
  _toggleDoor(voxel) {
    if (!toggleDoor(this.world, voxel)) return;
    this.mobs.refreshNav();
  }

  /** Start the next queued pickup's flight if one isn't already airborne.
   *  Each flight grants its item on arrival, then pumps the next one. */
  _pumpPickupQueue() {
    if (this.pickupFX.active || this._pickupQueue.length === 0) return;
    const next = this._pickupQueue.shift();
    this.pickupFX.fly(next.def, next.start, next.yaw, () => {
      this._grantPickup(next.def);
      // Quest hook AFTER the grant, so an "objective complete" toast isn't
      // immediately overwritten by the pickup's own toast.
      this._questEvents(this.quests.onCollect(next.def));
      this._pumpPickupQueue();
    });
  }

  /** Grant a picked-up item that has floated to the player: quest items grant
   *  nothing visible (the quest hook counts them), ammo packs give their
   *  ammo, armor vests add armor points, everything else is equipped into a
   *  slot. */
  _grantPickup(def) {
    if (def.kind === 'quest') {
      // Deliberately invisible: no hotbar slot, no stat change — the item
      // only exists for its quest (counted by onCollect in _pumpPickupQueue).
      this._toast(`Picked up ${def.name}`);
      return;
    }
    if (def.kind === 'armor') {
      const amount = def.armor?.amount ?? 25;
      const before = this.stats.armor;
      this.stats.repair(amount);
      const gained = Math.round(this.stats.armor - before);
      this._toast(gained > 0 ? `Armor +${gained}` : 'Armor already full');
      this._updateHud();
      return;
    }
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

  /** NPC placements for the loaded world: every editor-placed NPC spawn
   *  (NPC tool in the world editor). NPCManager snaps each to the nearest
   *  standable floor and skips spawns whose type is no longer registered. */
  _npcSpawns() {
    const spawns = [];
    this.world.forEachNpcSpawn((s) => spawns.push({ type: s.type, cell: [s.x, s.y, s.z], radius: 4 }));
    return spawns;
  }

  // --- modes ---

  showMenu() {
    this.mode = 'menu';
    this.touch?.setEnabled(false);
    this.ui.menu.classList.remove('hidden');
    this.ui.pause.classList.add('hidden');
    this.ui.death.classList.add('hidden');
    this.ui.hud.classList.add('hidden');
    this.ui.quest?.classList.add('hidden');
    this.walk.enabled = false;
    this.walk.keys.clear();
    // The flyover camera is a drone, not the player — no floating fists.
    this.hand.group.visible = false;
    if (document.pointerLockElement) document.exitPointerLock();
    this._renderSlots();
    this.ui.menu.classList.toggle('cover', !this._splashesReady);
    // Every menu visit rotates to the next authored splash shot (if any).
    this._showNextSplash();
  }

  startPlaying() {
    this.mode = 'playing';
    // Leave splash-shot framing behind: the player's camera, the player's fov.
    // Playing mutates the scene world, so the next menu visit must re-apply
    // its splash world even if it is the same file (_lastSplash = null).
    this.menuFly.setSplash(null);
    this._lastSplash = null;
    if (this.renderer.camera.fov !== this._defaultFov) {
      this.renderer.camera.fov = this._defaultFov;
      this.renderer.camera.updateProjectionMatrix();
    }
    this.touch?.setEnabled(true);
    this.ui.menu.classList.add('hidden');
    this.ui.pause.classList.add('hidden');
    this.ui.death.classList.add('hidden');
    this.ui.hud.classList.remove('hidden');
    this.walk.enabled = true;
    this.hand.group.visible = true;
    this._updateHud();
    this._updateQuestHud();
    if (!this.isTouch && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
  }

  pauseGame() {
    if (this.mode !== 'playing') return;
    this.mode = 'paused';
    this._firing = false;
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
    this.quests = new QuestLog();
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
    writeSlot(i, makeSlot({ bundle, player, stats: this.stats.serialize(), quests: this.quests.serialize() }), this.storage);
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
    this.quests = QuestLog.deserialize(slot.quests);
    this._restoreQuestMobs();
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
    // Clear the hit-flash when its vignette animation completes (event-driven,
    // so it stays in sync even if the page's timers are throttled).
    const hitFeedback = this.doc.querySelector('#hit-feedback');
    hitFeedback?.addEventListener('animationend', () => this.doc.body.classList.remove('hurt'));
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
      const digit = parseInt(e.code.slice(-1), 10);
      // With dialogue replies on screen, digits pick a reply, not a weapon.
      if (this._dialog?.convo.choices() && e.code.startsWith('Digit')) {
        this._chooseDialog(digit - 1);
        return;
      }
      // 1-4 select equipment slot
      if (e.code.startsWith('Digit') && digit >= 1 && digit <= EQUIPMENT_SLOTS.length) {
        this._selectSlot(digit - 1);
        return;
      }
      if (e.code === 'KeyF') {
        this._useInjection();
        return;
      }
      if (e.code === 'KeyE') {
        this._interact();
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
      // Hold to autofire: _frame keeps attacking while the button is down
      // (the weapon's cooldown sets the fire rate).
      this._firing = true;
      this._attack();
    });
    on(this.doc, 'mouseup', (e) => {
      if (e.button === 0) this._firing = false;
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
