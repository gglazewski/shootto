// GameApp.js — the playable game.
//
// A standalone page (game.html). The world it plays is file driven: when
// served by server.mjs it reads the live world file (map/voxelbundle.json),
// so saving in the editor and refreshing the game page picks the new
// map/objects up; a static deployment (GitHub Pages) has no server, so the
// world baked into the build at bundle time is used instead. Save slots
// snapshot the whole world (map + objects) with the player position, so a
// load restores exactly what was saved.
//
// Modes: 'menu' (main menu), 'playing' (walk around), 'paused' (Esc overlay
// with save/load slots).

import * as THREE from '../../vendor/three.module.js';
import { World } from '../engine/World.js';
import { Blinkers } from '../engine/Blinkers.js';
import { Renderer } from '../engine/Renderer.js';
import { PerfStats } from '../engine/PerfStats.js';
import { CELL_SIZE, MAX_RAY_DISTANCE } from '../engine/Space.js';
import { createAtlasTexture } from '../textures/AtlasTexture.three.js';
import { WalkControls } from '../editor/WalkControls.js';
import { ItemRenderer } from '../editor/ItemRenderer.js';
import { collisionWorld } from '../editor/itemPick.js';
import { GameLoop } from '../GameLoop.js';
import { CONFIG } from '../config.js';
import { deserialize } from '../persistence/WorldSerializer.js';
import { serializeBundle, deserializeBundle, BUNDLE_FORMAT } from '../persistence/WorldBundle.js';
import { getItem } from '../engine/ItemRegistry.js';
import { getEquipItem } from '../engine/EquipmentRegistry.js';
import { registerBuiltinQuestItems } from '../engine/QuestItems.js';
import { deserializeNpcRegistry } from '../engine/NpcRegistry.js';
import { deserializeQuestRegistry } from '../engine/QuestRegistry.js';
import { ammoName } from '../engine/AmmoTypes.js';
import { MICRO_SIZE, gridOf, lightLevelForMeters, rotateMicroPoint } from '../engine/ItemTypes.js';
import { isPassable, isGlass } from '../engine/VoxelTypes.js';
import { isDoorVoxel, isOpenDoor, toggleDoor, canToggle, isDoorLocked } from '../engine/Doors.js';
import { isSwitchDecal, isSwitchOn, flipSwitch, seedSwitchFlags, faceFromNormal } from '../engine/Switches.js';
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
import { QuestLog, objectivesOf } from './quests.js';
import { GameFlags, applyFlagList, bindWorldReactions } from './Reactions.js';
import { Dialogue } from './Dialogue.js';
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

/** Seconds of the fade-to-black between menu splash screens — the cut happens
 *  behind full black, then the same time fades the next shot back in. Must
 *  match the #splash-fade CSS transition duration in game.html. */
const SPLASH_FADE_SECONDS = 0.35;

/** Seconds of guaranteed full black around the cut: padding after the CSS
 *  fade-out (which can start a paint late and peek the old shot through) and
 *  the hold after the switch, giving a rebuilt world a few rendered frames
 *  behind the cover before the fade-in reveals it. */
const SPLASH_BLACK_SECONDS = 0.25;

export class GameApp {
  /**
   * @param {object} [deps]
   * @param {Document} [deps.doc]
   * @param {HTMLElement} [deps.container]
   * @param {Storage} [deps.storage]  localStorage in the browser (save slots)
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
    this.webgl = new THREE.WebGLRenderer({
      antialias: !this.isTouch,
      // Ask for the discrete GPU on hybrid machines; without it some drivers
      // silently render on the integrated chip.
      powerPreference: 'high-performance',
    });
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

    // Performance overlay (F9): FPS, frame ms, draw calls, buffer size.
    this.perf = new PerfStats({ doc: this.doc, webgl: this.webgl, renderer: this.renderer });

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
    // Open NPC repair screen: { npc, slot } — slot is the picked equipment
    // slot name (null until the player clicks a weapon). See _openRepair.
    this._repair = null;
    // Quest state: NPCs are the quest givers (see quests.js). Reset on new
    // game, serialized into save slots.
    this.quests = new QuestLog();
    // Action/reaction flags (see Reactions.js): quests raise them, world
    // objects (flag-gated doors) mirror them. Reset with the quest log,
    // serialized alongside it; _bindReactions subscribes the world's
    // listeners on every play start.
    this.flags = new GameFlags();
    this._unbindReactions = null;

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
      repair: this.doc.querySelector('#repair'),
      repairSub: this.doc.querySelector('#repair-sub'),
      repairList: this.doc.querySelector('#repair-list'),
      btnRepairFix: this.doc.querySelector('#btn-repair-fix'),
      btnRepairClose: this.doc.querySelector('#btn-repair-close'),
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
      loading: this.doc.querySelector('#loading'),
      loadingFill: this.doc.querySelector('#loading-fill'),
      loadingStatus: this.doc.querySelector('#loading-status'),
      splashFade: this.doc.querySelector('#splash-fade'),
    };

    this._wireUI();
    this._wireInput();
  }

  // --- lifecycle ---

  async start() {
    this._onResize = () => this.renderer.resize(window.innerWidth, window.innerHeight);
    window.addEventListener('resize', this._onResize);
    this._onResize();

    this._setLoadProgress(0.1, 'Fetching world…');
    await this._loadBaseWorld();
    this._setLoadProgress(0.85, 'Preparing menu…');
    this._renderSlots();

    this.loop = new GameLoop({ onFrame: (dt) => this._frame(dt) });
    this.loop.start();
    this.walk.connect();
    this._setLoadProgress(1, 'Ready');
    this.showMenu();
    this._initSplashes();
    return this;
  }

  /** Drive the boot loading screen (bar width + status line). No-ops once the
   *  screen is hidden — showMenu dismisses it when startup completes. */
  _setLoadProgress(frac, label) {
    if (this.ui.loadingFill) this.ui.loadingFill.style.width = `${Math.round(frac * 100)}%`;
    if (this.ui.loadingStatus && label) this.ui.loadingStatus.textContent = label;
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
  /** Drop the black splash cover (fades out via CSS) and reset fade state. */
  _clearSplashFade() {
    this._splashFade = null;
    this.ui.splashFade?.classList.remove('show');
  }

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
      this._updateVisit();
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
          if (!this._splashFade && this._splashTimer >= SPLASH_SECONDS) {
            // Fade to black first; the actual cut happens behind full cover.
            this._splashFade = 'out';
            this.ui.splashFade?.classList.add('show');
          } else if (this._splashFade === 'out'
              && this._splashTimer >= SPLASH_SECONDS + SPLASH_FADE_SECONDS + SPLASH_BLACK_SECONDS) {
            // Cut under full black, but keep the cover on: the new shot (and a
            // possible world rebuild) gets rendered behind it first, so no
            // half-built frame ever flashes through.
            this._showNextSplash(); // resets the timer
            this._splashFade = 'hold';
          } else if (this._splashFade === 'hold' && this._splashTimer >= SPLASH_BLACK_SECONDS) {
            this._clearSplashFade();
          }
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
    this.renderer.setLampLights(this.blinkers.lampLights);
    // Day/night time only advances while actually playing (frozen in menu/pause).
    this.renderer.render(this.mode === 'playing' ? dt : 0);
    this.perf.frame();
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

  // --- world loading (file driven) ---

  /** Load the world to play. When a server is present (editor dev server) the
   *  live world file wins so editor saves show up after a refresh; otherwise
   *  the world baked into this build is used (static deploy). Registries ride
   *  inside the bundle and are registered BEFORE the map deserializes, so
   *  placed items/NPC spawns resolve. */
  async _loadBaseWorld() {
    // Built-in quest items first — an authored def under the same id wins.
    registerBuiltinQuestItems();
    const text = await this._fetchWorldFile();
    this._setLoadProgress(0.4, 'Reading map…');
    let world = null;
    if (text) world = this._parseWorld(text);
    if (!world && BUNDLED_WORLD?.map) {
      world = deserializeBundle(JSON.stringify(BUNDLED_WORLD)).world;
    }
    this._setLoadProgress(0.6, 'Building world…');
    this._applyWorld(world ?? new World());
  }

  /** @returns {Promise<string|null>} the world file text from the server, or
   *  null when there is no server (static deploy) or nothing saved yet. */
  async _fetchWorldFile() {
    if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return null;
    try {
      const res = await fetch('/api/world');
      if (!res.ok) return null;
      const text = await res.text();
      return text === 'null' ? null : text;
    } catch {
      return null;
    }
  }

  /** Re-register the authored NPC + quest registries from the current world
   *  source (the live file behind /api/world, or the baked-in bundle on a
   *  static deploy) WITHOUT touching the world in play. Saves snapshot the
   *  registries as they were; content keeps evolving — this puts the current
   *  content back on top after a save's bundle loaded. Item/equipment
   *  registries stay with the save: its placed items reference them. */
  async _refreshAuthoredContent() {
    let data = null;
    const text = await this._fetchWorldFile();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (data?.format !== BUNDLE_FORMAT) data = BUNDLED_WORLD?.map ? BUNDLED_WORLD : null;
    if (!data) return;
    if (Array.isArray(data.npcs)) deserializeNpcRegistry(JSON.stringify(data.npcs));
    if (data.quests && typeof data.quests === 'object') deserializeQuestRegistry(JSON.stringify(data.quests));
  }

  /** Deserialize a world file (bundle or plain map). @returns {World|null} */
  _parseWorld(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }
    if (data && data.format === BUNDLE_FORMAT) {
      const { world, fatal } = deserializeBundle(text);
      return fatal ? null : world;
    }
    const { world, fatal } = deserialize(text);
    return fatal ? null : world;
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

  /** Show magazine ammo for ranged weapons as `in-mag / carried`. Breakable
   *  melee weapons show durability as `left / max` instead; fists and
   *  unbreakable weapons show infinite ammo (`∞/∞`) so the counter is always
   *  present. */
  _updateAmmoHud() {
    const el = this.ui.ammo;
    if (!el) return;
    const weapon = this.stats.activeItemId ? weaponFor(this.stats.activeItemId) : FISTS;
    const max = weapon.magazine ?? 0;
    if (weapon.kind === 'melee' && weapon.durability > 0 && this.stats.activeItemId) {
      const left = Math.max(0, weapon.durability - (this.stats.wear[this.stats.activeSlotName] ?? 0));
      el.classList.remove('hidden');
      el.textContent = `${left}/${weapon.durability}`;
      return;
    }
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
      this._degradeMeleeWeapon(weapon);
      return;
    }
    this.smoke.puff(impact.pos);
  }

  /** Melee weapons wear out on flesh, not on walls: each hit that lands on a
   *  mob costs one point of durability, and at zero the weapon snaps and the
   *  slot empties (the breaking blow still deals its damage). Missed swings
   *  and hits on the world cost nothing. Fists and guns (durability 0) never
   *  wear. */
  _degradeMeleeWeapon(weapon) {
    if (weapon.kind !== 'melee' || !(weapon.durability > 0)) return;
    const slot = this.stats.activeSlotName;
    if (!this.stats.equipment[slot]) return; // bare fists in an empty slot
    const wear = this.stats.addWear(slot);
    if (wear < weapon.durability) {
      this._updateAmmoHud();
      return;
    }
    this.stats.unequip(slot);
    this._toast(`Your ${weapon.name} broke!`);
    this._updateHud();
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
    this._closeRepair();
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

  // --- interact: item pickup + doors + wall switches (aim, press E) ---

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
      // A wall switch is a decal on the face the ray came in through.
      const face = faceFromNormal(hit.normal);
      const decal = face ? this.world.decalAt(hit.cell[0], hit.cell[1], hit.cell[2], face) : null;
      if (isSwitchDecal(decal)) return { cell: hit.cell, switch: decal };
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
        this.ui.pickup.innerHTML = isDoorLocked(target.door)
          ? 'The door is locked'
          : `Press <kbd>E</kbd> to ${isOpenDoor(target.door) ? 'close' : 'open'} the door`;
        this.ui.pickup.classList.remove('hidden');
      }
      return;
    }
    if (target.switch) {
      this._hideOutline();
      if (this.ui.pickup) {
        this.ui.pickup.innerHTML = `Press <kbd>E</kbd> to flip the switch ${isSwitchOn(target.switch) ? 'off' : 'on'}`;
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
    this._dialog = { npc, convo: new Dialogue({ npc, quests: this.quests, flags: this.flags }) };
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
      applyFlagList(this.flags, result.accepted.flags?.accept);
      // Starting gear changes hands the moment the player signs up — the
      // giver equips them for the job (items fly over like a turn-in reward).
      if (result.accepted.startReward) this._grantReward(result.accepted.startReward, npc);
      // A slay quest with a spawn point materializes its pack the moment the
      // player signs up — picking "I'll do it" was them agreeing to the fight.
      this._spawnQuestPacks(result.accepted);
    }
    if (result?.completed) {
      this._toast(`Quest complete: ${result.completed.title}`);
      applyFlagList(this.flags, result.completed.flags?.complete);
      if (result.reward) this._grantReward(result.reward, npc);
      // A turn-in may unlock a chained (auto-starting) next tier.
      this._questEvents(this.quests.autoAcceptAvailable());
    }
    // A picked service reply: the conversation drops back to its hub and the
    // matching screen opens on top of the chat.
    if (result?.service?.type === 'repair') this._openRepair();
    if (result) this._updateQuestHud();
    // The flags above landed after choose() ran — if the conversation is
    // already back on its hub, rebuild it so a service gated on a flag this
    // very reply raised shows up without leaving the chat.
    if (result) convo.refreshHub();
    if (convo.done) this._closeDialog();
    else this._renderDialog();
  }

  /** Close without applying anything — walking away or pausing mid-chat
   *  leaves unpicked offers and turn-ins for next time. */
  _closeDialog() {
    if (!this._dialog) return;
    this._dialog = null;
    this.ui.dialog?.classList.add('hidden');
    this._closeRepair();
  }

  // --- NPC repair service (see NpcRegistry `services`) ---

  /** Open the repair screen over the chat: the player's breakable weapons,
   *  pick one, hit Repair. Pointer lock is released so the rows are clickable
   *  (the auto-pause on lock loss skips this screen); Done re-locks and drops
   *  back into the conversation. */
  _openRepair() {
    this._repair = { slot: null };
    this._firing = false;
    if (document.pointerLockElement) document.exitPointerLock();
    this._renderRepair();
    this.ui.repair?.classList.remove('hidden');
  }

  /** Equipment slots holding a weapon that wears (melee with durability). */
  _repairableSlots() {
    return EQUIPMENT_SLOTS.filter((slot) => {
      const id = this.stats.equipment[slot];
      if (!id) return false;
      const w = weaponFor(id);
      return w.kind === 'melee' && w.durability > 0;
    });
  }

  _renderRepair() {
    const list = this.ui.repairList;
    if (!list || !this._repair) return;
    list.replaceChildren();
    const slots = this._repairableSlots();
    if (this.ui.repairSub) {
      this.ui.repairSub.textContent = slots.length
        ? 'Pick a weapon to fix up'
        : 'Nothing on you that could be fixed.';
    }
    for (const slot of slots) {
      const id = this.stats.equipment[slot];
      const item = getItem(id) ?? getEquipItem(id);
      const weapon = weaponFor(id);
      const left = Math.max(0, weapon.durability - (this.stats.wear[slot] ?? 0));
      const row = this.doc.createElement('button');
      row.className = `repair-row${slot === this._repair.slot ? ' selected' : ''}`;
      if (item) row.appendChild(buildItemSwatch(item, 36));
      const name = this.doc.createElement('span');
      name.className = 'r-name';
      name.textContent = weapon.name;
      const cond = this.doc.createElement('span');
      cond.className = `r-cond${left < weapon.durability ? ' worn' : ''}`;
      cond.textContent = `${left}/${weapon.durability}`;
      row.append(name, cond);
      row.addEventListener('click', () => {
        this._repair.slot = slot;
        this._renderRepair();
      });
      list.appendChild(row);
    }
    // Repair only lights up for a weapon that has actually taken wear.
    const picked = this._repair.slot;
    if (this.ui.btnRepairFix) this.ui.btnRepairFix.disabled = !picked || !(this.stats.wear[picked] > 0);
  }

  /** Repair the picked weapon: its wear drops to zero, good as new. */
  _repairFix() {
    const slot = this._repair?.slot;
    if (!slot || !(this.stats.wear[slot] > 0)) return;
    this.stats.repairWear(slot);
    this._toast(`${weaponFor(this.stats.equipment[slot]).name} repaired — good as new.`);
    this._renderRepair();
    this._updateAmmoHud();
  }

  /** Close the repair screen back into the conversation. */
  _closeRepair() {
    if (!this._repair) return;
    this._repair = null;
    this.ui.repair?.classList.add('hidden');
    if (!this.isTouch && this.mode === 'playing' && this.webgl.domElement.requestPointerLock) {
      this.webgl.domElement.requestPointerLock();
    }
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

  /** React to quest events (kills, pickups, area visits, and the chain
   *  events _advance appends): toast progress, grant field-completion
   *  rewards, and materialize auto-started quests' packs. */
  _questEvents(events) {
    for (const ev of events) {
      if (ev.accepted) {
        // A chained quest started by itself — same ceremony as picking
        // "I'll do it", minus the dialog (starting gear included).
        this._toast(`New quest: ${ev.quest.title}`);
        applyFlagList(this.flags, ev.quest.flags?.accept);
        if (ev.quest.startReward) this._grantReward(ev.quest.startReward);
        this._spawnQuestPacks(ev.quest);
        // The player may already be standing in the new quest's visit area —
        // forget the last checked cell so the next frame re-tests it.
        this._visitCell = null;
      } else if (ev.completed) {
        this._toast(`Quest complete: ${ev.quest.title}`);
        applyFlagList(this.flags, ev.quest.flags?.complete);
        if (ev.reward) this._grantReward(ev.reward);
      } else if (ev.ready) {
        const giver = getNpcType(ev.quest.giver)?.name ?? ev.quest.giver;
        this._toast(`Objective complete — return to ${giver}`);
      }
    }
    if (events.length) this._updateQuestHud();
  }

  /** Feed the quest log the player's feet cell whenever it changes — visit
   *  objectives (marked areas) are met by walking onto them. */
  _updateVisit() {
    const p = this.walk.position;
    const cx = Math.floor(p.x / CELL_SIZE);
    const cy = Math.floor(p.y / CELL_SIZE);
    const cz = Math.floor(p.z / CELL_SIZE);
    const last = this._visitCell;
    if (last && last[0] === cx && last[1] === cy && last[2] === cz) return;
    this._visitCell = [cx, cy, cz];
    this._questEvents(this.quests.onVisit(cx, cy, cz));
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
      entry.appendChild(title);
      // One line per objective; met ones stay listed but dimmed, so a
      // multi-goal quest reads as a checklist.
      for (const line of e.lines ?? [{ text: e.text, done: false }]) {
        const obj = this.doc.createElement('div');
        obj.className = line.done ? 'q-obj done' : 'q-obj';
        obj.textContent = line.text;
        entry.appendChild(obj);
      }
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

  /** Materialize every slay pack a freshly started quest calls for (one per
   *  kill objective with an authored spawn point). */
  _spawnQuestPacks(quest) {
    for (const o of objectivesOf(quest)) this._spawnQuestMobs(o, o.count);
  }

  /** Re-materialize outstanding slay packs after a load: dynamically spawned
   *  quest mobs aren't part of the world's spawn points, so a save made
   *  mid-quest would otherwise come back with an unfinishable objective.
   *  Spawns only what's still owed (count minus kills already made). */
  _restoreQuestMobs() {
    for (const { quest, progress } of this.quests.activeQuests()) {
      objectivesOf(quest).forEach((o, i) => {
        this._spawnQuestMobs(o, o.count - (progress[i] ?? 0));
      });
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
    if (target.switch) {
      // The flag store is the source of truth — the rocker art (and any
      // lights or door locks bound to the flag) mirrors it via reactions.
      // An unwired switch still clicks its rocker; it just drives nothing.
      flipSwitch(this.world, this.flags, target.switch);
      this._updatePickup();
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
    // A locked door doesn't budge — the prompt already says so.
    if (!canToggle(voxel)) return;
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
    this.ui.loading?.classList.add('hidden');
    this.ui.menu.classList.toggle('cover', !this._splashesReady);
    // Every menu visit rotates to the next authored splash shot (if any),
    // shown straight away — no leftover black cover.
    this._clearSplashFade();
    this._showNextSplash();
  }

  startPlaying() {
    this.mode = 'playing';
    // Leave splash-shot framing behind: the player's camera, the player's fov.
    // Playing mutates the scene world, so the next menu visit must re-apply
    // its splash world even if it is the same file (_lastSplash = null).
    this.menuFly.setSplash(null);
    this._lastSplash = null;
    // Starting mid-fade must not leave the black cover over the game.
    this._clearSplashFade();
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
    // Quest lifecycle signals are derived state, not one-shots: replay them
    // from quest history on every play start, so a flag authored onto an
    // already-finished quest (or missing from an old save) still fires.
    applyFlagList(this.flags, this.quests.lifecycleFlags());
    // Reactions first, quest chain openers second: flags an auto-accepted
    // opener raises must land on already-listening doors.
    this._bindReactions();
    // Chain openers: quests flagged autoAccept start by themselves — on a new
    // game and equally on a load (already-active ones are simply not
    // 'available' anymore, so this is idempotent).
    this._visitCell = null;
    this._questEvents(this.quests.autoAcceptAvailable());
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

  /** Start a fresh game from the current authored world. */
  async newGame() {
    await this._loadBaseWorld();
    this.stats = new PlayerStats();
    this.quests = new QuestLog();
    this.flags = new GameFlags();
    seedSwitchFlags(this.world, this.flags);
    this._ammo = new Map();
    this._reloading = false;
    const [cx, cy, cz] = this._spawnCell();
    this.walk.spawnAt(cx, cy, cz, ((this.world.spawnYaw ?? 0) * Math.PI) / 180);
    this.startPlaying();
  }

  /** (Re)subscribe the current world's reaction carriers — doors gated by an
   *  `unlockFlag` — to the current flag store. Runs on every play start,
   *  when both world and store are final; listener catch-up settles every
   *  bound door to its flag right here, so a loaded game (or an edited map)
   *  can never disagree with its flags. */
  _bindReactions() {
    this._unbindReactions?.();
    this._unbindReactions = bindWorldReactions(this.world, this.flags, {
      onDoorUnlock: () => this._toast('You hear a lock click open.'),
    });
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
    writeSlot(i, makeSlot({ bundle, player, stats: this.stats.serialize(), quests: this.quests.serialize(), flags: this.flags.serialize() }), this.storage);
    this._toast(`Saved to slot ${i + 1}`);
    this._renderSlots();
  }

  async loadSlot(i) {
    const slot = readSlot(i, this.storage);
    if (!slot) {
      this._toast(`Slot ${i + 1} is empty`);
      return;
    }
    const { world } = deserializeBundle(slot.bundle);
    this._applyWorld(world);
    // The save's bundle just re-registered the registries as they were when
    // it was written. The world (geometry, placed items) is the save's to
    // keep, but authored CONTENT — NPCs and questlines — must be current, so
    // a dialogue/service/quest edited after the save reaches it too.
    await this._refreshAuthoredContent();
    this.npcs.rebuild(this._npcSpawns()); // re-instance NPCs on live defs
    this.stats = PlayerStats.deserialize(slot.stats);
    this.quests = QuestLog.deserialize(slot.quests);
    this.flags = GameFlags.deserialize(slot.flags);
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
    this.ui.btnRepairFix?.addEventListener('click', () => this._repairFix());
    this.ui.btnRepairClose?.addEventListener('click', () => this._closeRepair());
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
        if (this._repair) {
          this._closeRepair();
          return;
        }
        if (this.mode === 'playing') this.pauseGame();
        else if (this.mode === 'paused') this.resumeGame();
        else if (this.mode === 'dead') this.showMenu();
        return;
      }
      if (e.code === 'F9') {
        this.perf.toggle();
        return;
      }
      if (this.mode !== 'playing') return;
      // The repair screen is mouse-driven — keys must not leak through to the
      // dialogue replies or the hotbar underneath it.
      if (this._repair) return;
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
      if (!this.isTouch && this.mode === 'playing' && !locked && !this._repair) this.pauseGame();
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
