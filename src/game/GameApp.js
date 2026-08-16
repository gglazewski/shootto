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
import { deserialize, collectSparse } from '../persistence/WorldSerializer.js';
import { deserializeBundle, BUNDLE_FORMAT } from '../persistence/WorldBundle.js';
import { openSaveStore, makeSave, manualSlotKey, diffPickedUp } from '../persistence/SaveStore.js';
import { importLegacySlots } from '../persistence/LegacySaves.js';
import { getItem } from '../engine/ItemRegistry.js';
import { getEquipItem, listEquipItems } from '../engine/EquipmentRegistry.js';
import { registerBuiltinQuestItems } from '../engine/QuestItems.js';
import {
  registerBuiltinMaterials, MATERIAL_IDS, REPAIR_COST, REPAIR_DECAY_FRACTION,
  ADHESIVE_IDS, SCRAP_IDS, MATERIAL_STACK,
} from '../engine/Materials.js';
import { registerBuiltinCraftables } from '../engine/Craftables.js';
import {
  registerBuiltinRecipes, listRecipes, getRecipe, craftPlan, applyCraft,
  selfCraftDecay, recipeAvailable, CRAFT_CATEGORIES,
} from '../engine/Crafting.js';
import { ammoName } from '../engine/AmmoTypes.js';
import { MICRO_SIZE, gridOf, lightLevelForMeters, rotateMicroPoint, quarterTurns } from '../engine/ItemTypes.js';
import { layFlat } from '../engine/LayFlat.js';
import { isPassable, isGlass } from '../engine/VoxelTypes.js';
import { isDoorVoxel, isOpenDoor, toggleDoor, canToggle, isDoorLocked } from '../engine/Doors.js';
import { isSwitchDecal, isSwitchOn, flipSwitch, seedSwitchFlags, faceFromNormal } from '../engine/Switches.js';
import { BUNDLED_WORLD } from '../bundledWorld.js';
import { SLOT_COUNT } from './SaveSlots.js';
import { PlayerStats, MAX_HEALTH, EQUIPMENT_SLOTS } from './PlayerStats.js';
import { ContainerStore } from './ContainerStore.js';
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

/** Chance a dead mob drops a weapon from its loot pool (see _dropLoot). */
const LOOT_DROP_CHANCE = 0.05;

/** Chance a dead mob drops a repair material — rolled independently of the
 *  weapon drop, so scavenging parts is the common case and a weapon the
 *  jackpot. */
const MATERIAL_DROP_CHANCE = 0.18;

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

/** The death sequence: the kill plays out in slow motion while the camera
 *  keels over, then "YOU DIED" fades in, then the respawn button. Delays are
 *  real seconds (the slow-mo factor only scales the world simulation). */
const DEATH_SLOWMO = 0.3;
const DEATH_FALL_SECONDS = 1.4;
const DEATH_ROLL = 0.35; // radians of camera tilt at rest
const DEATH_REST_EYE = 0.25; // camera height above the feet once fallen
const DEATH_TITLE_SECONDS = 1.1;
const DEATH_BUTTON_SECONDS = 2.6;

export class GameApp {
  /**
   * @param {object} [deps]
   * @param {Document} [deps.doc]
   * @param {HTMLElement} [deps.container]
   * @param {Storage} [deps.storage]  localStorage (legacy v1 save-slot import)
   * @param {object} [deps.saveStore]  injected SaveStore (tests); opened async in start() otherwise
   */
  constructor({ doc = document, container, storage = null, saveStore = null } = {}) {
    this.doc = doc;
    this.container = container ?? doc.querySelector('#game');
    this.storage = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    this.saves = saveStore; // resolved in start() when not injected
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
    const { texture, tileIndexFor, atlas, rebuild, tiles } = createAtlasTexture(THREE);
    this.rebuildAtlas = rebuild;
    // The game starts shortly after nightfall (the editor keeps its day start),
    // so a fresh run faces most of the night before the first dawn.
    this.renderer = new Renderer({
      THREE, webgl: this.webgl, world: this.world, atlasTexture: texture, tileIndexFor, atlas, tiles,
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
          craft: () => (this._craft ? this._closeCraft() : this._openCraft()),
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
    this._typeTimer = null; // typewriter tick while an NPC line reveals
    this._typeFull = ''; // the full line being revealed
    this._typePos = 0; // characters revealed so far
    this._qt = new Map(); // live gain-card key (quest id, item:<id>, reward:<stat>) -> { el, timer, amount }
    // Open NPC repair screen: { npc, slot } — slot is the picked equipment
    // slot name (null until the player clicks a weapon). See _openRepair.
    this._repair = null;
    // Open crafting screen (Q, or an NPC's 'craft' service): { npc, tab,
    // recipeId }. npc null = self-crafting (field recipes only, homemade
    // wear); an NPC works at their bench (every recipe, full quality).
    this._craft = null;
    // Backpack grid (B): open state — the game keeps running underneath.
    this._backpackOpen = false;
    // Storage containers (E on an object authored as storage): persistent
    // stash contents keyed by placement anchor, serialized into save slots.
    this.containers = new ContainerStore();
    // The open container: { item, key } or null. Like the backpack, the game
    // keeps running underneath while you rummage.
    this._container = null;
    // Item being dragged between the stash and backpack grids (see
    // _renderContainer): { from: 'storage'|'player'|'equip', ... } or null.
    this._containerDrag = null;
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
    // it up): a silhouette halo around the item's form, not a wire over every
    // voxel edge. The item's own geometry is inflated along smoothed normals
    // (the `outlineDir` attribute, see createOutlineGeometry) and drawn back-
    // face only — an inverted hull — so a single glowing rim hugs the shape.
    // The geometry is swapped in per aimed item (_showItemOutline).
    this._pickupOutline = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({
        uniforms: {
          color: { value: new THREE.Color(0x66ccff) },
          // Halo thickness in micro-voxel units (the mesh is scaled by MICRO_SIZE).
          offset: { value: 0.5 },
        },
        vertexShader: `
          attribute vec3 outlineDir;
          uniform float offset;
          void main() {
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position + outlineDir * offset, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 color;
          void main() { gl_FragColor = vec4(color, 1.0); }`,
        side: THREE.BackSide,
      }),
    );
    this._pickupOutline.visible = false;
    this._pickupOutline.frustumCulled = false;
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

    // Containers already searched this run: placement anchor key -> seconds
    // until the loot restocks (Infinity = never; see _searchObject).
    this._searched = new Map();

    // --- UI ---
    this.ui = {
      menu: this.doc.querySelector('#menu'),
      pause: this.doc.querySelector('#pause'),
      hud: this.doc.querySelector('#hud'),
      toast: this.doc.querySelector('#toast'),
      pickup: this.doc.querySelector('#pickup'),
      dialog: this.doc.querySelector('#dialog'),
      dialogName: this.doc.querySelector('#dialog-name'),
      dialogMarker: this.doc.querySelector('#dialog-marker'),
      dialogText: this.doc.querySelector('#dialog-text'),
      dialogChoices: this.doc.querySelector('#dialog-choices'),
      dialogHint: this.doc.querySelector('#dialog-hint'),
      backpack: this.doc.querySelector('#backpack'),
      backpackEquip: this.doc.querySelector('#backpack-equip'),
      backpackGrid: this.doc.querySelector('#backpack-grid'),
      btnBackpackClose: this.doc.querySelector('#btn-backpack-close'),
      container: this.doc.querySelector('#container'),
      containerTitle: this.doc.querySelector('#container-title'),
      containerGrid: this.doc.querySelector('#container-grid'),
      containerEquip: this.doc.querySelector('#container-equip'),
      containerPlayerGrid: this.doc.querySelector('#container-player-grid'),
      btnContainerClose: this.doc.querySelector('#btn-container-close'),
      repair: this.doc.querySelector('#repair'),
      repairSub: this.doc.querySelector('#repair-sub'),
      repairList: this.doc.querySelector('#repair-list'),
      btnRepairFix: this.doc.querySelector('#btn-repair-fix'),
      btnRepairClose: this.doc.querySelector('#btn-repair-close'),
      craft: this.doc.querySelector('#craft'),
      craftTitle: this.doc.querySelector('#craft-title'),
      craftSub: this.doc.querySelector('#craft-sub'),
      craftTabs: this.doc.querySelector('#craft-tabs'),
      craftList: this.doc.querySelector('#craft-list'),
      craftDetail: this.doc.querySelector('#craft-detail'),
      btnCraftMake: this.doc.querySelector('#btn-craft-make'),
      btnCraftClose: this.doc.querySelector('#btn-craft-close'),
      quest: this.doc.querySelector('#quest'),
      questList: this.doc.querySelector('#quest-list'),
      qtoasts: this.doc.querySelector('#qtoasts'),
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
      deathTitle: this.doc.querySelector('#death-title'),
      deathSub: this.doc.querySelector('#death-sub'),
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

    this.saves ??= await openSaveStore();
    // One-time import of legacy v1 localStorage slots (frees their quota).
    await importLegacySlots(this.storage, this.saves);

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
      this._tickSearched(dt);
      this.mobs.update(dt, this.walk.position, this._viewFacing());
      this.npcs.update(dt);
      // Walking away mid-chat ends the conversation.
      if (this._dialog) {
        const npc = this._dialog.npc;
        const p = this.walk.position;
        if (Math.hypot(p.x - npc.pos.x, p.z - npc.pos.z) > TALK_BREAK_RANGE) this._closeDialog();
      }
    } else if (this.mode === 'dead' && this._death) {
      this._updateDeath(dt);
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
    const world = await this._fetchBaseWorld();
    this._setLoadProgress(0.6, 'Building world…');
    this._applyWorld(world);
  }

  /** Fetch + build a fresh base world, registering the current content along
   *  the way, WITHOUT touching the world in play. Also remembers the map's
   *  object placements — saves store which of them the player picked up. */
  async _fetchBaseWorld() {
    // Built-in quest items first — an authored def under the same id wins.
    registerBuiltinQuestItems();
    registerBuiltinMaterials();
    registerBuiltinCraftables(); // craftable weapons / vests / healing items
    registerBuiltinRecipes();
    const text = await this._fetchWorldFile();
    this._setLoadProgress(0.4, 'Reading map…');
    let world = null;
    if (text) world = this._parseWorld(text);
    if (!world && BUNDLED_WORLD?.map) {
      world = deserializeBundle(JSON.stringify(BUNDLED_WORLD)).world;
    }
    world ??= new World();
    this._baseItems = collectSparse(world).items.map(({ itemId, x, y, z }) => ({ itemId, x, y, z }));
    return world;
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
    this._searched.clear();
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
    // Pickups landing while the bag is open show up in it immediately.
    if (this._backpackOpen) this._renderBackpack();
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
      const slot = this.stats.activeSlotName;
      const max = this._effDurability(slot, weapon);
      const left = Math.max(0, max - (this.stats.wear[slot] ?? 0));
      el.classList.remove('hidden');
      el.textContent = `${left}/${max}`;
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
    // Backpack badge: stored items + material total, contents in the tooltip,
    // B (or a tap) opens the grid. Hidden while empty so the default HUD
    // stays untouched.
    const materialTotal = Object.values(this.stats.materials).reduce((a, b) => a + b, 0);
    if (this.stats.backpack.length || materialTotal) {
      const pack = document.createElement('div');
      pack.className = 'eq-slot eq-backpack';
      const names = [
        ...this.stats.backpack.map((e) => (getItem(e.id) ?? getEquipItem(e.id))?.name ?? e.id),
        ...Object.entries(this.stats.materials).map(([id, n]) => `${getEquipItem(id)?.name ?? id} ×${n}`),
      ];
      pack.title = `Backpack (B): ${names.join(', ')}`;
      const keyHint = document.createElement('span');
      keyHint.className = 'eq-slot-label';
      keyHint.textContent = 'B';
      pack.appendChild(keyHint);
      const icon = document.createElement('span');
      icon.className = 'eq-slot-name';
      icon.textContent = `\u{1F392} ${this.stats.backpack.length + materialTotal}`;
      pack.appendChild(icon);
      pack.addEventListener('click', () => this._openBackpack());
      el.appendChild(pack);
    }
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

  /** A slot's weapon durability ceiling after repair decay: every repair
   *  shaves points off the base (see _repairFix), never below 1 — a much-
   *  patched weapon breaks on its first landed hit. */
  _effDurability(slot, weapon) {
    if (!(weapon.durability > 0)) return 0;
    return Math.max(1, weapon.durability - (this.stats.decay[slot] ?? 0));
  }

  /** Melee weapons wear out on flesh, not on walls: each hit that lands on a
   *  mob costs one point of durability, and at zero the weapon snaps and the
   *  slot empties (the breaking blow still deals its damage). Missed swings
   *  and hits on the world cost nothing. Fists and guns (durability 0) never
   *  wear. Repairs lower the ceiling (see _effDurability), so a patched-up
   *  weapon snaps sooner. */
  _degradeMeleeWeapon(weapon) {
    if (weapon.kind !== 'melee' || !(weapon.durability > 0)) return;
    const slot = this.stats.activeSlotName;
    if (!this.stats.equipment[slot]) return; // bare fists in an empty slot
    const wear = this.stats.addWear(slot);
    if (wear < this._effDurability(slot, weapon)) {
      this._updateAmmoHud();
      return;
    }
    this.stats.unequip(slot);
    this._gainCard({ key: `broke:${slot}`, kicker: 'Broken', title: weapon.name, cls: 'q-broke', ms: 4500 });
    this._refillFromBackpack(slot);
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
      this._dropLoot(mob);
    }
    this._updateHud();
  }

  /** Loot drop from a dead mob — two independent rolls, materials common and
   *  weapons rare. The pool comes from the mob's spawner when one is set
   *  (split by item kind); an explicit empty pool drops nothing. The item
   *  flies from the corpse straight to the player, exactly like an E-pickup —
   *  the grant lands when the flight does. */
  _dropLoot(mob) {
    const def = this._rollLoot(mob._respawn?.loot ?? null);
    if (!def) return;
    const start = new THREE.Vector3(mob.pos.x, mob.pos.y + mob.height * 0.5, mob.pos.z);
    this._pickupQueue.push({ def, start, yaw: Math.random() * Math.PI * 2 });
    this._pumpPickupQueue();
  }

  /** One loot roll — two independent chances, weapons rare and materials
   *  common. `authored` narrows the pool (split by item kind); an explicit
   *  empty pool never yields anything. Shared by mob deaths and container
   *  searches. @returns {object|null} the rolled equip def */
  _rollLoot(authored) {
    if (authored && authored.length === 0) return null;
    const isMelee = (i) => i.kind === 'weapon' && (i.weapon?.kind ?? 'melee') === 'melee';
    const pick = (ids) => ids[Math.floor(Math.random() * ids.length)];

    let dropId = null;
    if (Math.random() < LOOT_DROP_CHANCE) {
      // The default pool is authored weapons only — built-in craftables
      // (shiv, plank, spear) exist to be MADE, not found on a corpse.
      const weapons = authored
        ? authored.filter((id) => isMelee(getEquipItem(id) ?? {}))
        : listEquipItems().filter((i) => isMelee(i) && !i.builtin).map((i) => i.id);
      if (weapons.length) dropId = pick(weapons);
    }
    if (!dropId && Math.random() < MATERIAL_DROP_CHANCE) {
      const mats = authored
        ? authored.filter((id) => getEquipItem(id)?.kind === 'material')
        : MATERIAL_IDS.filter((id) => getEquipItem(id));
      if (mats.length) dropId = pick(mats);
    }
    return dropId ? getEquipItem(dropId) ?? null : null;
  }

  /** Search a loot-granting object (garbage can, cupboard, …): one roll from
   *  its authored pool. The object itself stays put — only the find (if any)
   *  flies to the player, exactly like an E-pickup. The container counts as
   *  searched either way, restocking after its authored `reset` seconds or
   *  never (see _tickSearched). */
  _searchObject(item) {
    this._searched.set(item.anchor.join(','), item.loot.reset ?? Infinity);
    this._hidePickup();
    const def = this._rollLoot(item.loot.pool);
    if (!def) {
      this._toast('Nothing inside');
      return;
    }
    // Flight starts at the top centre of the object's footprint — the loot
    // comes out of the container. Odd quarter turns swap the x/z span.
    const [ax, ay, az] = item.anchor;
    const [w, h, d] = item.cells;
    const [sx, sz] = quarterTurns(item.rotation ?? 0) & 1 ? [d, w] : [w, d];
    const start = new THREE.Vector3(
      (ax + sx / 2) * CELL_SIZE,
      (ay + h) * CELL_SIZE,
      (az + sz / 2) * CELL_SIZE,
    );
    this._pickupQueue.push({ def, start, yaw: item.rotation ?? 0 });
    this._pumpPickupQueue();
  }

  /** Count searched containers back toward a restock. Authored `reset`
   *  seconds tick only while playing, like mob respawn timers; Infinity
   *  entries (no reset authored) never come back. */
  _tickSearched(dt) {
    for (const [k, t] of this._searched) {
      if (t === Infinity) continue;
      if (t - dt <= 0) this._searched.delete(k);
      else this._searched.set(k, t - dt);
    }
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

  /** Start the death sequence: the world drops into slow motion while the
   *  camera keels over, then _updateDeath stages the "YOU DIED" title and
   *  the respawn button in. */
  gameOver() {
    if (this.mode === 'dead') return;
    this.mode = 'dead';
    this._closeBackpack();
    this._closeContainer();
    this._closeDialog();
    this._firing = false;
    this.touch?.setEnabled(false);
    this.walk.enabled = false;
    this.walk.keys.clear();
    this.walk.velocity.set(0, 0, 0);
    if (document.pointerLockElement) document.exitPointerLock();
    this.ui.menu.classList.add('hidden');
    this.ui.pause.classList.add('hidden');
    this.ui.hud.classList.add('hidden');
    this.ui.death.classList.remove('hidden');
    this._death = { t: 0, eyeY: this.renderer.camera.position.y };
    this.container.classList.add('dying');
    this.hand.group.visible = false; // no floating fists over the corpse
    this._hidePickup();
    this._closeRepair();
  }

  /** One dead-mode frame: the horde shambles on in slow motion, the camera
   *  sinks and tilts, and the death UI fades in staged on the real clock. */
  _updateDeath(dt) {
    const d = this._death;
    d.t += dt;
    this.mobs.update(dt * DEATH_SLOWMO, this.walk.position, this._viewFacing());
    const p = Math.min(1, d.t / DEATH_FALL_SECONDS);
    const ease = 1 - (1 - p) * (1 - p);
    const cam = this.renderer.camera;
    cam.position.y = d.eyeY - ease * (d.eyeY - (this.walk.position.y + DEATH_REST_EYE));
    cam.rotation.z = ease * DEATH_ROLL;
    if (d.t >= DEATH_TITLE_SECONDS) this.ui.deathTitle?.classList.add('show');
    if (d.t >= DEATH_BUTTON_SECONDS) {
      this.ui.deathSub?.classList.add('show');
      this.ui.btnRespawn?.classList.add('show');
    }
  }

  /** Tear the death presentation down (any path back into play or menu). */
  _endDeathSequence() {
    if (!this._death) return;
    this._death = null;
    this.container.classList.remove('dying');
    this.renderer.camera.rotation.z = 0;
    for (const el of [this.ui.deathTitle, this.ui.deathSub, this.ui.btnRespawn]) {
      el?.classList.remove('show');
    }
  }

  /** Death is canon: everything the player carried is gone forever. The
   *  world, quests, flags and stashes stay exactly as they are — only the
   *  player restarts, empty-handed, at the map's spawn point. */
  respawn() {
    this.stats = new PlayerStats();
    this._ammo = new Map();
    this._reloading = false;
    const [cx, cy, cz] = this._spawnCell();
    this.walk.spawnAt(cx, cy, cz, ((this.world.spawnYaw ?? 0) * Math.PI) / 180);
    this.mobs.rebuild(); // a fresh horde from its spawners — no aggro follows you home
    this.startPlaying();
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
   *  objects stay put, though one authored to grant loot answers E as a
   *  searchable container ({cell, item, search}). Short-range, so the
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
        // A storage container opens its stash — before search loot, so an
        // object authored as storage never rolls one-shot loot.
        if (item.storage) return { cell: hit.cell, item, container: true };
        // A placed object authored to grant loot is searchable — until it has
        // been searched and its restock timer (if any) runs out.
        if (item.loot && !this._searched.has(item.anchor.join(','))) {
          return { cell: hit.cell, item, search: true };
        }
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
          // Quest-state pip beside the key hint: ! = the NPC has work on
          // offer, ? = a job is ready to hand in — readable at a glance.
          const st = this.quests.statusFor(this._talkNpc.type.id);
          const pip = st === 'available'
            ? '<span class="pip avail">!</span>'
            : st === 'ready' ? '<span class="pip ready">?</span>' : '';
          this.ui.pickup.innerHTML = `${pip}Press <kbd>E</kbd> to talk to ${this._talkNpc.name}`;
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
    if (target.container) {
      // Storage containers highlight like pickups, with their own prompt.
      this._showItemOutline(target.item);
      if (this.ui.pickup) {
        this.ui.pickup.innerHTML = 'Press <kbd>E</kbd> to open';
        this.ui.pickup.classList.remove('hidden');
      }
      return;
    }
    if (target.search) {
      // Searchable objects highlight like pickups, with their own prompt.
      this._showItemOutline(target.item);
      if (this.ui.pickup) {
        this.ui.pickup.innerHTML = 'Press <kbd>E</kbd> to search';
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

  /** The E key / touch PICK button: finish a typewriting line, advance an
   *  open dialog, start one with a nearby NPC, or fall through to the aimed
   *  pickup/door. While replies are on screen E does nothing — picking is
   *  deliberate (digits, click, or tap). */
  _interact() {
    if (this._dialog) {
      if (this._typing()) {
        this._finishTypewriter();
        return;
      }
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
   *  topics, bye). See Dialogue.js. The pointer is freed so replies are
   *  clickable; closing the chat re-locks it. */
  _startDialog(npc) {
    this._dialog = { npc, convo: new Dialogue({ npc, quests: this.quests, flags: this.flags }) };
    this._hidePickup();
    if (!this.isTouch && document.pointerLockElement) document.exitPointerLock();
    this._renderDialog();
  }

  _renderDialog() {
    const { npc, convo } = this._dialog;
    if (this.ui.dialogName) this.ui.dialogName.textContent = npc.name;
    // Quest-state marker on the name bar: ! = work on offer, ? = ready to
    // hand in — the player reads the NPC's business before picking a reply.
    const status = this.quests.statusFor(npc.type.id);
    if (this.ui.dialogMarker) {
      this.ui.dialogMarker.dataset.state = status === 'available' || status === 'ready' ? status : '';
      this.ui.dialogMarker.textContent = status === 'available' ? '!' : status === 'ready' ? '?' : '';
    }
    this._startTypewriter(convo.line() ?? '');
    const choices = convo.choices();
    const box = this.ui.dialogChoices;
    if (box) {
      box.replaceChildren();
      for (const [i, choice] of (choices ?? []).entries()) {
        const btn = this.doc.createElement('button');
        btn.className = `c-${choice.kind ?? 'node'}`;
        btn.style.animationDelay = `${Math.min(i * 30, 150)}ms`;
        const key = this.doc.createElement('kbd');
        key.textContent = String(i + 1);
        btn.append(key, this.doc.createTextNode(choice.label));
        btn.addEventListener('click', () => this._chooseDialog(i));
        box.appendChild(btn);
      }
      box.classList.toggle('hidden', !choices);
    }
    if (this.ui.dialogHint) {
      this.ui.dialogHint.innerHTML = choices
        ? (this.isTouch ? 'Tap a reply' : '<kbd>1</kbd>–<kbd>9</kbd> pick a reply&ensp;·&ensp;<kbd>Esc</kbd> leave')
        : (this.isTouch ? 'Tap <b>PICK</b> to continue' : 'Press <kbd>E</kbd> to continue');
    }
    this.ui.dialog?.classList.remove('hidden');
  }

  /** Reveal the NPC's current line letter by letter (fast — a beat, not a
   *  slog). Re-renders restart it; E / PICK finishes it instantly. */
  _startTypewriter(text) {
    this._stopTypewriter();
    const el = this.ui.dialogText;
    if (!el) return;
    this._typeFull = text;
    this._typePos = 0;
    if (!text) {
      el.textContent = '';
      return;
    }
    el.textContent = '';
    this._typeTimer = setInterval(() => {
      this._typePos += 2;
      if (this._typePos >= this._typeFull.length) this._finishTypewriter();
      else el.textContent = this._typeFull.slice(0, this._typePos);
    }, 16);
  }

  _typing() {
    return !!this._typeTimer;
  }

  /** Dump the whole line at once and stop the tick. */
  _finishTypewriter() {
    if (!this._typeTimer) return;
    this._stopTypewriter();
    if (this.ui.dialogText) this.ui.dialogText.textContent = this._typeFull ?? '';
  }

  _stopTypewriter() {
    clearInterval(this._typeTimer);
    this._typeTimer = null;
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
      this._questToast(result.accepted, 'new');
      applyFlagList(this.flags, result.accepted.flags?.accept);
      // Starting gear changes hands the moment the player signs up — the
      // giver equips them for the job (items fly over like a turn-in reward).
      if (result.accepted.startReward) this._grantReward(result.accepted.startReward, npc);
      // A slay quest with a spawn point materializes its pack the moment the
      // player signs up — picking "I'll do it" was them agreeing to the fight.
      this._spawnQuestPacks(result.accepted);
    }
    if (result?.completed) {
      this._questToast(result.completed, 'done');
      applyFlagList(this.flags, result.completed.flags?.complete);
      if (result.reward) this._grantReward(result.reward, npc);
      // A turn-in may unlock a chained (auto-starting) next tier.
      this._questEvents(this.quests.autoAcceptAvailable());
    }
    // A picked service reply: the conversation drops back to its hub and the
    // matching screen opens on top of the chat.
    if (result?.service?.type === 'repair') this._openRepair();
    if (result?.service?.type === 'craft') this._openCraft(npc);
    if (result) this._updateQuestHud();
    // The flags above landed after choose() ran — if the conversation is
    // already back on its hub, rebuild it so a service gated on a flag this
    // very reply raised shows up without leaving the chat.
    if (result) convo.refreshHub();
    if (convo.done) this._closeDialog();
    else this._renderDialog();
  }

  /** Close without applying anything — Esc, walking away, or pausing mid-chat
   *  leaves unpicked offers and turn-ins for next time. The pointer re-locks
   *  so play resumes seamlessly. */
  _closeDialog() {
    if (!this._dialog) return;
    this._dialog = null;
    this._stopTypewriter();
    this.ui.dialog?.classList.add('hidden');
    this._closeRepair();
    this._closeCraft();
    if (!this._repair && !this._craft) this._relockPointer();
  }

  /** Ask for the pointer lock back. Browsers may refuse without a fresh user
   *  gesture (e.g. the chat closed by walking away, not a keypress) — then
   *  the next canvas click retries it (see the mousedown wiring). */
  _relockPointer() {
    if (this.isTouch || this.mode !== 'playing') return;
    try {
      const p = this.webgl.domElement.requestPointerLock?.();
      p?.catch?.(() => {});
    } catch { /* refusal is non-fatal — the click retry covers it */ }
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

  /** What the next repair would consume, against what the player carries:
   *  one adhesive (duck tape, then glue) + REPAIR_COST.scrap pieces of any
   *  scrap (metal → wood → glass). @returns {{ok:boolean, take:{id:string,
   *  count:number}[], missing:string[]}} */
  _repairPlan() {
    const take = [];
    const missing = [];
    const adhesive = ADHESIVE_IDS.find((id) => this.stats.materialCount(id) > 0);
    if (adhesive) take.push({ id: adhesive, count: REPAIR_COST.adhesive });
    else missing.push('adhesive (duck tape or glue)');
    let scrapLeft = REPAIR_COST.scrap;
    for (const id of SCRAP_IDS) {
      if (scrapLeft <= 0) break;
      const use = Math.min(scrapLeft, this.stats.materialCount(id));
      if (use > 0) {
        take.push({ id, count: use });
        scrapLeft -= use;
      }
    }
    if (scrapLeft > 0) missing.push(`${scrapLeft}× scrap (metal / wood / glass)`);
    return { ok: missing.length === 0, take, missing };
  }

  /** Durability the picked weapon would cap at AFTER one more repair. */
  _repairNextMax(slot) {
    const weapon = weaponFor(this.stats.equipment[slot]);
    const penalty = Math.max(1, Math.ceil(weapon.durability * REPAIR_DECAY_FRACTION));
    return Math.max(1, this._effDurability(slot, weapon) - penalty);
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
      const max = this._effDurability(slot, weapon);
      const left = Math.max(0, max - (this.stats.wear[slot] ?? 0));
      const row = this.doc.createElement('button');
      row.className = `repair-row${slot === this._repair.slot ? ' selected' : ''}`;
      if (item) row.appendChild(buildItemSwatch(item, 36));
      const name = this.doc.createElement('span');
      name.className = 'r-name';
      name.textContent = weapon.name;
      const cond = this.doc.createElement('span');
      cond.className = `r-cond${left < max ? ' worn' : ''}`;
      cond.textContent = `${left}/${max}`;
      // A repaired weapon caps lower — say so up front, per row.
      if (max < weapon.durability) {
        cond.textContent += ` (was ${weapon.durability})`;
      }
      row.append(name, cond);
      row.addEventListener('click', () => {
        this._repair.slot = slot;
        this._renderRepair();
      });
      list.appendChild(row);
    }

    // Cost strip: each material the next repair consumes, have/need, plus
    // what's missing in red. Rendered fresh under the weapon rows.
    const plan = this._repairPlan();
    const cost = this.doc.createElement('div');
    cost.id = 'repair-cost';
    const label = this.doc.createElement('span');
    label.className = 'rc-label';
    label.textContent = 'Costs';
    cost.appendChild(label);
    for (const t of plan.take) {
      const def = getEquipItem(t.id);
      const chip = this.doc.createElement('span');
      chip.className = 'rc-chip';
      chip.title = def?.name ?? t.id;
      if (def) chip.appendChild(buildItemSwatch(def, 24));
      chip.append(`×${t.count}`);
      cost.appendChild(chip);
    }
    for (const m of plan.missing) {
      const miss = this.doc.createElement('span');
      miss.className = 'rc-chip rc-missing';
      miss.textContent = `needs ${m}`;
      cost.appendChild(miss);
    }
    list.appendChild(cost);

    const picked = this._repair.slot;
    if (picked) {
      const note = this.doc.createElement('p');
      note.className = 'rc-note';
      note.textContent = `Patching wears it down: max durability drops to ${this._repairNextMax(picked)} after this fix.`;
      list.appendChild(note);
    }

    // Repair lights up for a worn weapon the player can afford to fix.
    if (this.ui.btnRepairFix) {
      this.ui.btnRepairFix.disabled = !picked || !(this.stats.wear[picked] > 0) || !plan.ok;
    }
  }

  /** Repair the picked weapon: consumes materials (see _repairPlan), zeroes
   *  its wear, and permanently lowers its durability ceiling — every patch
   *  brings the final break closer. */
  _repairFix() {
    const slot = this._repair?.slot;
    if (!slot || !(this.stats.wear[slot] > 0)) return;
    const plan = this._repairPlan();
    if (!plan.ok) {
      this._toast(`Missing ${plan.missing.join(' + ')}`);
      return;
    }
    for (const t of plan.take) this.stats.takeMaterial(t.id, t.count);
    const weapon = weaponFor(this.stats.equipment[slot]);
    const penalty = Math.max(1, Math.ceil(weapon.durability * REPAIR_DECAY_FRACTION));
    this.stats.repairWear(slot);
    this.stats.decay[slot] = (this.stats.decay[slot] ?? 0) + penalty;
    const max = this._effDurability(slot, weapon);
    this._toast(max <= 1
      ? `${weapon.name} patched — barely holding together.`
      : `${weapon.name} repaired — holds ${max} more hits.`);
    this._renderRepair();
    this._updateAmmoHud();
  }

  /** Close the repair screen back into the conversation. The pointer stays
   *  free while a chat is open underneath — its replies are mouse-driven. */
  _closeRepair() {
    if (!this._repair) return;
    this._repair = null;
    this.ui.repair?.classList.add('hidden');
    if (!this._dialog && !this._craft) this._relockPointer();
  }

  // --- crafting (Q anywhere; an NPC's 'craft' service opens the bench) ---

  /** Open the crafting screen (Q). `npc` null = self-crafting in the field
   *  (only 'field' recipes, homemade weapons wear in faster); an NPC works at
   *  their bench — every recipe, full quality. The game keeps running
   *  underneath like the backpack grid; the pointer is freed so the rows are
   *  clickable. */
  _openCraft(npc = null) {
    if (this._craft || this.mode !== 'playing') return;
    this._craft = { npc, tab: 'all', recipeId: null };
    this._firing = false;
    if (document.pointerLockElement) document.exitPointerLock();
    this._renderCraft();
    this.ui.craft?.classList.remove('hidden');
  }

  /** Close the crafting screen — back into the conversation when an NPC's
   *  service opened it, else straight back to play. */
  _closeCraft() {
    if (!this._craft) return;
    this._craft = null;
    this.ui.craft?.classList.add('hidden');
    if (!this._dialog && !this._repair) this._relockPointer();
  }

  /** The recipes the open screen lists: the active tab's slice (or all). */
  _craftRecipes() {
    if (!this._craft) return [];
    const tab = this._craft.tab;
    return listRecipes().filter((r) => tab === 'all' || r.category === tab);
  }

  /** Render the crafting screen: category tabs, the recipe list (swatch,
   *  name, cost chips; locked recipes show a padlock until you find a bench)
   *  and the detail pane of the selected recipe — big swatch, stats, the
   *  ingredient ledger (have/need) and the Craft button. */
  _renderCraft() {
    const c = this._craft;
    if (!c || !this.ui.craftList || !this.ui.craftDetail) return;
    const byNpc = !!c.npc;

    if (this.ui.craftTitle) {
      this.ui.craftTitle.textContent = byNpc ? `${c.npc.name}'s Workbench` : 'Crafting';
    }
    if (this.ui.craftSub) {
      this.ui.craftSub.textContent = byNpc
        ? 'Proper tools, proper results — no homemade wear.'
        : 'Scrap in, survival out. The game keeps running!';
    }

    // Tabs: All + one per category.
    const tabs = this.ui.craftTabs;
    if (tabs) {
      tabs.replaceChildren();
      for (const t of [{ id: 'all', label: 'All' }, ...CRAFT_CATEGORIES]) {
        const btn = this.doc.createElement('button');
        btn.className = `craft-tab${c.tab === t.id ? ' active' : ''}`;
        btn.textContent = t.label;
        btn.addEventListener('click', () => {
          c.tab = t.id;
          c.recipeId = null;
          this._renderCraft();
        });
        tabs.appendChild(btn);
      }
    }

    // Recipe list.
    const list = this.ui.craftList;
    list.replaceChildren();
    const recipes = this._craftRecipes();
    if (c.recipeId && !recipes.some((r) => r.id === c.recipeId)) c.recipeId = null;
    for (const recipe of recipes) {
      const def = getEquipItem(recipe.output.id);
      const locked = !recipeAvailable(recipe, byNpc);
      const plan = craftPlan(recipe, this.stats);
      const row = this.doc.createElement('button');
      row.className = `craft-row${recipe.id === c.recipeId ? ' selected' : ''}${locked ? ' locked' : plan.ok ? ' ready' : ''}`;
      if (def) row.appendChild(buildItemSwatch(def, 40));
      const name = this.doc.createElement('span');
      name.className = 'cr-name';
      name.textContent = recipe.name;
      row.appendChild(name);
      // Mini cost chips — red when short.
      const costs = this.doc.createElement('span');
      costs.className = 'cr-costs';
      for (const input of recipe.inputs) {
        const chip = this.doc.createElement('span');
        const have = this.stats.materialCount(input.id);
        chip.className = `cr-chip${have < input.count ? ' short' : ''}`;
        chip.textContent = `${have}/${input.count}`;
        chip.title = `${getEquipItem(input.id)?.name ?? input.id} ×${input.count}`;
        costs.appendChild(chip);
      }
      row.appendChild(costs);
      if (locked) {
        const lock = this.doc.createElement('span');
        lock.className = 'cr-lock';
        lock.textContent = '⚒';
        lock.title = 'Needs a craftsman with a workbench';
        row.appendChild(lock);
      }
      row.addEventListener('click', () => {
        c.recipeId = recipe.id;
        this._renderCraft();
      });
      list.appendChild(row);
    }

    // Detail pane.
    const detail = this.ui.craftDetail;
    detail.replaceChildren();
    const recipe = recipes.find((r) => r.id === c.recipeId) ?? recipes[0];
    if (recipe) c.recipeId = recipe.id;
    if (recipe) {
      const def = getEquipItem(recipe.output.id);
      const locked = !recipeAvailable(recipe, byNpc);
      const plan = craftPlan(recipe, this.stats);

      const head = this.doc.createElement('div');
      head.className = 'cd-head';
      if (def) head.appendChild(buildItemSwatch(def, 88));
      const headText = this.doc.createElement('div');
      headText.className = 'cd-headtext';
      const nameEl = this.doc.createElement('div');
      nameEl.className = 'cd-name';
      nameEl.textContent = recipe.name;
      headText.appendChild(nameEl);
      if (recipe.desc) {
        const desc = this.doc.createElement('div');
        desc.className = 'cd-desc';
        desc.textContent = recipe.desc;
        headText.appendChild(desc);
      }
      const tags = this.doc.createElement('div');
      tags.className = 'cd-tags';
      const cat = CRAFT_CATEGORIES.find((k) => k.id === recipe.category);
      const tagCat = this.doc.createElement('span');
      tagCat.className = `cd-tag t-${recipe.category}`;
      tagCat.textContent = cat?.label ?? recipe.category;
      tags.appendChild(tagCat);
      const tagStation = this.doc.createElement('span');
      tagStation.className = `cd-tag t-${recipe.station === 'npc' ? 'bench' : 'field'}`;
      tagStation.textContent = recipe.station === 'npc' ? 'Workbench' : 'Field';
      tags.appendChild(tagStation);
      headText.appendChild(tags);
      head.appendChild(headText);
      detail.appendChild(head);

      const statsEl = this.doc.createElement('div');
      statsEl.className = 'cd-stats';
      for (const line of this._craftStatsLines(def)) {
        const row = this.doc.createElement('div');
        row.className = 'cd-stat';
        row.textContent = line;
        statsEl.appendChild(row);
      }
      detail.appendChild(statsEl);

      // Ingredient ledger.
      const ledger = this.doc.createElement('div');
      ledger.className = 'cd-ledger';
      const ledgerLabel = this.doc.createElement('div');
      ledgerLabel.className = 'cd-label';
      ledgerLabel.textContent = 'Materials';
      ledger.appendChild(ledgerLabel);
      for (const input of recipe.inputs) {
        const matDef = getEquipItem(input.id);
        const have = this.stats.materialCount(input.id);
        const row = this.doc.createElement('div');
        row.className = `cd-mat${have < input.count ? ' short' : ''}`;
        if (matDef) row.appendChild(buildItemSwatch(matDef, 28));
        const matName = this.doc.createElement('span');
        matName.className = 'cd-mat-name';
        matName.textContent = matDef?.name ?? input.id;
        const matCount = this.doc.createElement('span');
        matCount.className = 'cd-mat-count';
        matCount.textContent = `${have} / ${input.count}`;
        row.append(matName, matCount);
        ledger.appendChild(row);
      }
      detail.appendChild(ledger);

      // Homemade wear note — only self-crafted weapons pay it.
      const decay = byNpc ? 0 : selfCraftDecay(def);
      if (decay > 0) {
        const note = this.doc.createElement('p');
        note.className = 'cd-note';
        note.textContent = `Homemade: max durability ${decay} lower. A craftsman's bench version doesn't wear in.`;
        detail.appendChild(note);
      }
      if (locked) {
        const note = this.doc.createElement('p');
        note.className = 'cd-note locked';
        note.textContent = 'Needs a craftsman with a proper workbench — ask around.';
        detail.appendChild(note);
      }

      if (this.ui.btnCraftMake) {
        this.ui.btnCraftMake.textContent = locked ? 'Locked' : 'Craft';
        this.ui.btnCraftMake.disabled = locked || !plan.ok;
      }
    } else {
      const empty = this.doc.createElement('p');
      empty.className = 'cd-note';
      empty.textContent = 'Nothing to make here yet.';
      detail.appendChild(empty);
      if (this.ui.btnCraftMake) this.ui.btnCraftMake.disabled = true;
    }
  }

  /** Human-readable effect lines for the detail pane, by item kind. */
  _craftStatsLines(def) {
    if (!def) return [];
    if (def.kind === 'consumable') {
      const lines = [];
      if (def.consumable?.health > 0) lines.push(`Heals ${def.consumable.health} HP (use with F)`);
      if (def.consumable?.armor > 0) lines.push(`+${def.consumable.armor} armor`);
      return lines.length ? lines : ['One-use medical item'];
    }
    if (def.kind === 'armor') return [`+${def.armor?.amount ?? 25} armor — strapped on the spot`];
    const s = def.stats ?? {};
    const lines = [`${s.damage ?? '?'} damage · ${s.cooldown ?? '?'}s swing · ${s.reach ?? '?'} m reach`];
    if (s.durability > 0) lines.push(`${s.durability} hits before it breaks`);
    return lines;
  }

  /** Craft the selected recipe: consume the materials, grant the output.
   *  Armor vests strap on immediately; weapons/consumables take a slot (or
   *  the backpack); self-crafted weapons carry their homemade decay. */
  _craftMake() {
    const c = this._craft;
    if (!c) return;
    const recipe = getRecipe(c.recipeId);
    if (!recipe || !recipeAvailable(recipe, !!c.npc)) return;
    const plan = craftPlan(recipe, this.stats);
    if (!plan.ok) {
      const names = plan.missing.map(
        (m) => `${getEquipItem(m.id)?.name ?? m.id} ×${m.short}`,
      );
      this._toast(`Missing ${names.join(' + ')}`);
      return;
    }
    if (!applyCraft(recipe, this.stats)) return;
    const def = getEquipItem(recipe.output.id);
    for (let i = 0; i < (recipe.output.count || 1); i++) this._grantCrafted(def, { byNpc: !!c.npc });
    this._updateHud();
    this._renderCraft();
  }

  /** Hand over a crafted item: armor vests grant their points straight away
   *  (same as a pickup), weapons and consumables land in a slot — the
   *  homemade decay rides along — or the backpack when everything's full. */
  _grantCrafted(def, { byNpc = false } = {}) {
    if (!def) return;
    if (def.kind === 'armor') {
      const before = this.stats.armor;
      this.stats.repair(def.armor?.amount ?? 25);
      const gained = Math.round(this.stats.armor - before);
      this._itemCard(def, {
        from: 'craft',
        line: gained > 0 ? `Armor +${gained}` : 'Armor already full',
      });
      return;
    }
    if (def.kind === 'material') {
      this._itemCard(def, { from: 'craft', amount: 1 });
      return;
    }
    const decay = byNpc ? 0 : selfCraftDecay(def);
    // A crafted consumable goes straight to the injection slot (its F-use
    // home) when free; everything else follows the usual pickup preference.
    const slot = def.kind === 'consumable' && !this.stats.equipment.injection
      ? 'injection'
      : this._pickupSlot(def);
    if (!slot) {
      this.stats.stow(def.id, 0, decay);
      this._itemCard(def, { from: 'craft', line: '→ backpack' });
      return;
    }
    this.stats.equip(slot, def.id);
    this.stats.decay[slot] = decay;
    this._updateHeldItem();
    this._itemCard(def, { from: 'craft' });
  }

  /** Quest reward: flat boosts through the usual PlayerStats paths, announced
   *  as quest-amber cards. Item rewards ride the pickup queue — each flies
   *  from the giver's hands to the player (same flight as a floor pickup)
   *  and is granted on arrival, card marked as a reward. */
  _grantReward(reward, npc = null) {
    if (reward.health) {
      this.stats.heal(reward.health);
      this._gainCard({ key: 'reward:health', kicker: 'Quest reward', title: `Health +${reward.health}`, ms: 4500 });
    }
    if (reward.armor) {
      this.stats.repair(reward.armor);
      this._gainCard({ key: 'reward:armor', kicker: 'Quest reward', title: `Armor +${reward.armor}`, ms: 4500 });
    }
    if (reward.ammo?.type) {
      const amount = reward.ammo.amount ?? 0;
      this.stats.addAmmo(reward.ammo.type, amount);
      this._gainCard({
        key: `item:ammo:${reward.ammo.type}`, // coalesces with picked-up ammo of the same type
        kicker: 'Quest reward',
        title: ammoName(reward.ammo.type),
        amount,
        ms: 4500,
      });
    }
    for (const id of reward.items ?? []) {
      const def = getEquipItem(id);
      if (!def) continue;
      if (npc) {
        // Chest height on the giver, so the item leaves their hands.
        const start = new THREE.Vector3(npc.pos.x, npc.pos.y + npc.height * 0.6, npc.pos.z);
        this._pickupQueue.push({ def, start, yaw: 0, from: 'reward' });
      } else {
        this._grantPickup(def, 'reward'); // no giver in sight — grant instantly
      }
    }
    this._pumpPickupQueue();
    this._updateHud();
  }

  /** React to quest events (kills, pickups, area visits, and the chain
   *  events _advance appends): moment toasts bottom-right, tracker refresh
   *  top-right (the ticked quest's entry bumps), field-completion rewards,
   *  and auto-started quests' packs. */
  _questEvents(events) {
    let bumped = null;
    for (const ev of events) {
      if (ev.accepted) {
        // A chained quest started by itself — same ceremony as picking
        // "I'll do it", minus the dialog (starting gear included).
        this._questToast(ev.quest, 'new');
        applyFlagList(this.flags, ev.quest.flags?.accept);
        if (ev.quest.startReward) this._grantReward(ev.quest.startReward);
        this._spawnQuestPacks(ev.quest);
        // The player may already be standing in the new quest's visit area —
        // forget the last checked cell so the next frame re-tests it.
        this._visitCell = null;
        bumped = null;
      } else if (ev.completed) {
        this._questToast(ev.quest, 'done');
        applyFlagList(this.flags, ev.quest.flags?.complete);
        if (ev.reward) this._grantReward(ev.reward);
        bumped = null;
      } else if (ev.ready) {
        this._questToast(ev.quest, 'ready');
        bumped = null;
      } else {
        // Plain progress: no toast spam — the tracker's counter is the
        // feedback, with a nudge on the entry that moved.
        bumped = ev.quest.id;
      }
    }
    if (events.length) this._updateQuestHud(bumped);
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

  /** Bottom-right announcement cards — the ONE system for gained things:
   *  quest moments AND item gains (floor pickups, quest rewards, stat
   *  boosts). Cards are kicker + name (+ one optional line), keyed so
   *  repeats coalesce into the existing card — and keyed item cards
   *  ACCUMULATE their amounts, so scooping a trail of ammo reads as one
   *  "+24" card ticking up, not a pile of duplicates. The stack is capped;
   *  the oldest card falls off first. */
  _gainCard({ key, kicker, title, line = null, amount = 0, cls = '', ms = 3800 }) {
    const host = this.ui.qtoasts;
    if (!host) return;
    const mk = (k, text) => {
      const el = this.doc.createElement('div');
      el.className = k;
      if (text != null) el.textContent = text;
      return el;
    };
    const prev = this._qt.get(key);
    if (prev) amount += prev.amount ?? 0;
    const card = mk('qt' + (cls ? ` ${cls}` : ''));
    card.appendChild(mk('qt-kicker', kicker));
    card.appendChild(mk('qt-title', title));
    // The line: caller's static text (Return to X, → backpack), else the
    // accumulated amount once there is one.
    const detail = line ?? (amount > 0 ? `+${amount}` : null);
    if (detail != null) card.appendChild(mk('qt-line', detail));
    if (prev) {
      clearTimeout(prev.timer);
      prev.el.replaceWith(card);
    } else {
      host.appendChild(card);
      while (host.children.length > 4) this._removeQuestToast(host.firstChild);
    }
    const timer = setTimeout(() => this._dismissQuestToast(key), ms);
    this._qt.set(key, { el: card, timer, amount });
    // Restart the slide-in so an in-place update reads as a bump.
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';
  }

  /** Quest moment as a card — thin wrapper over _gainCard with the quest
   *  look (amber business, green success) and the giver nudge when ready. */
  _questToast(quest, kind) {
    if (!quest) return;
    this._gainCard({
      key: quest.id,
      kicker: kind === 'new' ? 'New quest' : kind === 'done' ? 'Quest complete' : 'Objective complete',
      title: quest.title,
      line: kind === 'ready' ? `Return to ${getNpcType(quest.giver)?.name ?? quest.giver}` : null,
      cls: kind === 'done' || kind === 'ready' ? `q-${kind}` : '',
      ms: 4500,
    });
  }

  /** Item gain as a card: blue-accented for pickups, quest-amber when the
   *  item came from a reward, green "Crafted" when it left a workbench.
   *  `amount` makes the line a cumulative +N for stackables (ammo,
   *  materials); equippables show name only. */
  _itemCard(def, { from = 'pickup', amount = 0, line = null } = {}) {
    if (!def) return;
    this._gainCard({
      key: `item:${def.id}`,
      kicker: from === 'reward' ? 'Quest reward' : from === 'craft' ? 'Crafted' : 'Picked up',
      title: def.name,
      amount,
      line,
      cls: from === 'reward' || from === 'craft' ? '' : 'q-item',
    });
  }

  _dismissQuestToast(questId) {
    const entry = this._qt.get(questId);
    if (!entry) return;
    this._removeQuestToast(entry.el);
    this._qt.delete(questId);
  }

  /** Drop a card straight out of the stack (cap overflow or dismissal). */
  _removeQuestToast(el) {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }

  /** Clear the whole quest toast stack — menu, or a fresh play start. */
  _clearQuestToasts() {
    for (const { timer } of this._qt.values()) clearTimeout(timer);
    this._qt.clear();
    this.ui.qtoasts?.replaceChildren();
  }

  /** Objective tracker (top-right): the PERSISTENT view of what's in flight —
   *  every active quest as a gold title over indented objective lines with
   *  tabular n/count counters; ready-to-turn-in quests flip green with a
   *  pulsing "?" chip. Hidden when nothing is running. `bumpId` names the
   *  quest an event just ticked — its entry plays a nudge so a counter
   *  change reads as feedback even in the eye's periphery. */
  _updateQuestHud(bumpId = null) {
    if (!this.ui.quest || !this.ui.questList) return;
    const entries = this.quests.trackerEntries();
    if (!entries.length) {
      this.ui.quest.classList.add('hidden');
      return;
    }
    this.ui.questList.textContent = '';
    for (const e of entries) {
      const entry = this.doc.createElement('div');
      entry.className = 'quest-entry' + (e.ready ? ' ready' : '') + (e.id === bumpId ? ' bump' : '');
      if (e.id === bumpId) setTimeout(() => entry.classList.remove('bump'), 450);
      const title = this.doc.createElement('div');
      title.className = 'q-title';
      title.textContent = e.title;
      if (e.ready) {
        const chip = this.doc.createElement('span');
        chip.className = 'q-chip';
        chip.textContent = '?';
        title.appendChild(chip);
      }
      entry.appendChild(title);
      // One line per objective; met ones stay listed but dimmed, so a
      // multi-goal quest reads as a checklist. "noun 3/4" lines get their
      // counter split out for the chunky gold digits.
      for (const line of e.lines ?? [{ text: e.text, done: false }]) {
        const obj = this.doc.createElement('div');
        obj.className = line.done ? 'q-obj done' : 'q-obj';
        const m = line.text.match(/^(.*) (\d+)\/(\d+)$/);
        if (m) {
          obj.append(m[1] + ' ');
          const count = this.doc.createElement('span');
          count.className = 'q-count';
          count.textContent = `${m[2]}/${m[3]}`;
          obj.appendChild(count);
        } else {
          obj.textContent = line.text;
        }
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
    if (target.container) {
      this._openContainer(target.item);
      return;
    }
    if (target.search) {
      this._searchObject(target.item);
      return;
    }
    const def = getEquipItem(target.item.itemId);
    if (!def) return;
    this._hidePickup();
    const [ax, ay, az] = target.item.anchor;
    this.world.removeItemAt(ax, ay, az);
    // Flight starts at the centre of the resting pose (cropped + laid flat),
    // the shape that was actually sitting in the world.
    const [hx, hy, hz] = layFlat(def).grid.map((g) => (g * MICRO_SIZE) / 2);
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
      this._grantPickup(next.def, next.from ?? 'pickup');
      // Quest hook AFTER the grant, so an "objective complete" toast isn't
      // immediately overwritten by the pickup's own toast.
      this._questEvents(this.quests.onCollect(next.def));
      this._pumpPickupQueue();
    });
  }

  /** Grant a picked-up item that has floated to the player: quest items grant
   *  nothing visible (the quest hook counts them), ammo packs give their
   *  ammo, armor vests add armor points, everything else is equipped into a
   *  slot. Gains announce as bottom-right cards (`from` marks provenance —
   *  quest reward items read "Quest reward" instead of "Picked up"). */
  _grantPickup(def, from = 'pickup') {
    if (def.kind === 'quest') {
      // Deliberately invisible: no hotbar slot, no stat change — the item
      // only exists for its quest (counted by onCollect in _pumpPickupQueue).
      this._itemCard(def, { from });
      return;
    }
    if (def.kind === 'armor') {
      const amount = def.armor?.amount ?? 25;
      const before = this.stats.armor;
      this.stats.repair(amount);
      const gained = Math.round(this.stats.armor - before);
      if (gained > 0) this._itemCard(def, { from, line: `Armor +${gained}` });
      else this._toast('Armor already full');
      this._updateHud();
      return;
    }
    if (def.kind === 'material') {
      this.stats.addMaterial(def.id, 1);
      this._itemCard(def, { from, amount: 1 });
      this._updateHud();
      return;
    }
    if (def.kind === 'ammo') {
      const a = def.ammo ?? {};
      const type = a.type ?? '';
      const amount = a.amount ?? 0;
      if (type && amount > 0) {
        this.stats.addAmmo(type, amount);
        this._itemCard(def, { from, amount });
      } else {
        this._itemCard(def, { from });
      }
      this._updateHud();
      return;
    }
    const slot = this._pickupSlot(def);
    if (!slot) {
      // Every slot is taken — overflow goes into the backpack instead of
      // silently replacing what's in hand.
      this.stats.stow(def.id);
      this._updateHud();
      this._itemCard(def, { from, line: '→ backpack' });
      return;
    }
    this.stats.equip(slot, def.id);
    this._updateHud();
    this._itemCard(def, { from });
  }

  /** Slot a picked-up item lands in: weapons avoid the injection slot, while
   *  consumables (no damage) prefer it. Fills the active slot first when empty,
   *  then the first empty slot; null when everything is taken (the item goes
   *  to the backpack — see _grantPickup). */
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
    return null;
  }

  /** Refill a freshly emptied slot from the backpack: a weapon slot grabs the
   *  first stored weapon, the injection slot the first consumable. The stowed
   *  condition (wear + repair decay) comes back with it. Quiet no-op when the
   *  backpack has nothing suitable. */
  _refillFromBackpack(slot) {
    const wantWeapon = slot !== 'injection';
    const entry = this.stats.unstow((itemId) => {
      const def = getEquipItem(itemId) ?? getItem(itemId);
      const isWeapon = (def?.stats?.damage ?? 0) > 0;
      return wantWeapon === isWeapon;
    });
    if (!entry) return;
    this.stats.equip(slot, entry.id);
    this.stats.wear[slot] = entry.wear ?? 0;
    this.stats.decay[slot] = entry.decay ?? 0;
    const def = getEquipItem(entry.id) ?? getItem(entry.id);
    this._toast(`${def?.name ?? entry.id} out of the backpack (${this.stats.backpack.length} left)`);
  }

  // --- backpack (B): Minecraft-style grid over the game ---

  /** Open the backpack grid. The game keeps running underneath — rummaging
   *  through your bag mid-horde is a choice. Pointer lock is released so the
   *  cells are clickable (like the repair screen). */
  _openBackpack() {
    if (this._backpackOpen || this.mode !== 'playing') return;
    this._backpackOpen = true;
    this._firing = false;
    if (document.pointerLockElement) document.exitPointerLock();
    this._renderBackpack();
    this.ui.backpack?.classList.remove('hidden');
  }

  _closeBackpack() {
    if (!this._backpackOpen) return;
    this._backpackOpen = false;
    this.ui.backpack?.classList.add('hidden');
    if (!this.isTouch && this.mode === 'playing' && this.webgl.domElement.requestPointerLock) {
      this.webgl.domElement.requestPointerLock();
    }
  }

  /** Condition suffix for a stored weapon's tooltip, e.g. " — 3/6". */
  _conditionLabel(id, wear, decay) {
    const weapon = weaponFor(id);
    if (weapon.kind !== 'melee' || !(weapon.durability > 0)) return '';
    const max = Math.max(1, weapon.durability - (decay ?? 0));
    return ` — ${Math.max(0, max - (wear ?? 0))}/${max}`;
  }

  /** Render the two halves of the backpack screen: the four equipment slots
   *  (click to select where the next item goes) and the Minecraft-style grid
   *  of stored items — material stacks with counts first, then weapons and
   *  consumables. Clicking a stored item equips it into the first free
   *  preferred slot, or swaps with the ACTIVE slot when everything is full —
   *  the displaced weapon drops into the bag keeping its condition. */
  _renderBackpack() {
    const equipEl = this.ui.backpackEquip;
    const grid = this.ui.backpackGrid;
    if (!equipEl || !grid) return;

    equipEl.replaceChildren();
    EQUIPMENT_SLOTS.forEach((slot, i) => {
      const id = this.stats.equipment[slot];
      const item = id ? getItem(id) ?? getEquipItem(id) : null;
      const cell = this.doc.createElement('div');
      cell.className = `bp-slot bp-equip${i === this.stats.activeSlot ? ' active' : ''}`;
      cell.title = item
        ? `${item.name}${this._conditionLabel(id, this.stats.wear[slot], this.stats.decay[slot])} (${i + 1})`
        : `Empty slot (${i + 1})`;
      const key = this.doc.createElement('span');
      key.className = 'bp-key';
      key.textContent = String(i + 1);
      cell.appendChild(key);
      if (item) cell.appendChild(buildItemSwatch(item, 44));
      cell.addEventListener('click', () => {
        this._selectSlot(i);
        this._renderBackpack();
      });
      equipEl.appendChild(cell);
    });

    grid.replaceChildren();
    const cells = [];
    for (const id of Object.keys(this.stats.materials)) {
      const def = getEquipItem(id);
      if (!def || !(this.stats.materials[id] > 0)) continue;
      // Big piles split into Minecraft-style stacks.
      let left = this.stats.materials[id];
      while (left > 0) {
        const n = Math.min(left, MATERIAL_STACK);
        cells.push({ def, count: n });
        left -= n;
      }
    }
    this.stats.backpack.forEach((entry, index) => {
      const def = getEquipItem(entry.id) ?? getItem(entry.id);
      if (def) cells.push({ def, entry, index });
    });

    const COLS = 6;
    const total = Math.max(COLS * 3, Math.ceil(cells.length / COLS) * COLS);
    for (let i = 0; i < total; i++) {
      const c = cells[i];
      const cell = this.doc.createElement('div');
      cell.className = 'bp-slot';
      if (!c) {
        cell.classList.add('empty');
        grid.appendChild(cell);
        continue;
      }
      cell.appendChild(buildItemSwatch(c.def, 44));
      if (c.count != null) {
        cell.title = `${c.def.name} ×${c.count} — repair material`;
        const badge = this.doc.createElement('span');
        badge.className = 'bp-count';
        badge.textContent = String(c.count);
        cell.appendChild(badge);
      } else {
        cell.classList.add('takeable');
        cell.title = `${c.def.name}${this._conditionLabel(c.entry.id, c.entry.wear, c.entry.decay)} — click to equip`;
        cell.addEventListener('click', () => this._takeFromBackpack(c.index));
      }
      grid.appendChild(cell);
    }
  }

  /** Equip a stored item: into the first free preferred slot, else swap with
   *  the active slot — the displaced item goes back into the bag with its
   *  wear and repair decay intact. */
  _takeFromBackpack(index) {
    const entry = this.stats.backpack[index];
    if (!entry) return;
    const def = getEquipItem(entry.id) ?? getItem(entry.id);
    if (!def) return;
    const slot = this._pickupSlot(def) ?? this.stats.activeSlotName;
    const displacedId = this.stats.equipment[slot];
    this.stats.backpack.splice(index, 1);
    if (displacedId) {
      this.stats.stow(displacedId, this.stats.wear[slot], this.stats.decay[slot]);
    }
    this.stats.equip(slot, entry.id);
    this.stats.wear[slot] = entry.wear ?? 0;
    this.stats.decay[slot] = entry.decay ?? 0;
    const displaced = displacedId ? (getEquipItem(displacedId) ?? getItem(displacedId)) : null;
    this._toast(displaced ? `${def.name} out, ${displaced.name} stowed` : `${def.name} equipped`);
    this._updateHud();
    this._renderBackpack();
  }

  // --- storage containers (E on an object authored as storage) ---

  /** Open a storage container's stash screen. Like the backpack, the game
   *  keeps running underneath; pointer lock is released so cells are
   *  clickable and draggable. */
  _openContainer(item) {
    if (this._container || this.mode !== 'playing') return;
    this._container = { item, key: item.anchor.join(',') };
    this._firing = false;
    this._hidePickup();
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.ui.containerTitle) this.ui.containerTitle.textContent = getItem(item.itemId)?.name ?? 'Storage';
    this._renderContainer();
    this.ui.container?.classList.remove('hidden');
  }

  _closeContainer() {
    if (!this._container) return;
    this._container = null;
    this._containerDrag = null;
    this.ui.container?.classList.add('hidden');
    if (!this.isTouch && this.mode === 'playing' && this.webgl.domElement.requestPointerLock) {
      this.webgl.domElement.requestPointerLock();
    }
  }

  /** Cell list for one side of the container screen: material stacks with
   *  counts first (split like the backpack grid), then stored items.
   *  `materials` is a Record<id, count>, `items` [{id, wear, decay}]. */
  _stashCells(materials, items) {
    const cells = [];
    for (const id of Object.keys(materials)) {
      const def = getEquipItem(id);
      if (!def || !(materials[id] > 0)) continue;
      let left = materials[id];
      while (left > 0) {
        const n = Math.min(left, MATERIAL_STACK);
        cells.push({ def, count: n });
        left -= n;
      }
    }
    items.forEach((entry, index) => {
      const def = getEquipItem(entry.id) ?? getItem(entry.id);
      if (def) cells.push({ def, entry, index });
    });
    return cells;
  }

  /** Render the container screen: the stash grid on top, the player's four
   *  equipment slots and backpack grid below. Click a cell to move it to the
   *  other side; drag and drop works too — a stored item dropped on an
   *  equipment slot equips there, swapping the held item into the stash. */
  _renderContainer() {
    const key = this._container?.key;
    const equipEl = this.ui.containerEquip;
    if (!key || !this.ui.containerGrid || !this.ui.containerPlayerGrid || !equipEl) return;
    const stash = this.containers.open(key);
    this._renderStashGrid(this.ui.containerGrid, 'storage', this._stashCells(stash.materials, stash.items));
    this._renderStashGrid(this.ui.containerPlayerGrid, 'player', this._stashCells(this.stats.materials, this.stats.backpack));

    equipEl.replaceChildren();
    EQUIPMENT_SLOTS.forEach((slot, i) => {
      const id = this.stats.equipment[slot];
      const item = id ? getItem(id) ?? getEquipItem(id) : null;
      const cell = this.doc.createElement('div');
      cell.className = `bp-slot bp-equip${i === this.stats.activeSlot ? ' active' : ''}`;
      cell.title = item
        ? `${item.name}${this._conditionLabel(id, this.stats.wear[slot], this.stats.decay[slot])} — click or drag to stash`
        : `Empty slot (${i + 1}) — drop a stored item here to equip it`;
      const keyEl = this.doc.createElement('span');
      keyEl.className = 'bp-key';
      keyEl.textContent = String(i + 1);
      cell.appendChild(keyEl);
      if (item) {
        cell.appendChild(buildItemSwatch(item, 44));
        cell.classList.add('takeable');
        const move = { from: 'equip', slot };
        cell.draggable = true;
        cell.addEventListener('dragstart', (e) => {
          this._containerDrag = move;
          e.dataTransfer?.setData('text/plain', id);
        });
        cell.addEventListener('dragend', () => { this._containerDrag = null; });
        cell.addEventListener('click', () => this._moveStash(move));
      }
      // A stored item dropped straight onto a slot equips there.
      cell.addEventListener('dragover', (e) => {
        if (this._containerDrag?.from === 'storage') {
          e.preventDefault();
          e.stopPropagation();
        }
      });
      cell.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const drag = this._containerDrag;
        this._containerDrag = null;
        if (drag?.from === 'storage') this._equipFromStash(drag, slot);
      });
      equipEl.appendChild(cell);
    });
  }

  /** Render one grid of the container screen. `side` names where its cells
   *  live ('storage' | 'player'); clicking or dragging a cell moves it to
   *  the other side. */
  _renderStashGrid(grid, side, cells) {
    grid.replaceChildren();
    const COLS = 6;
    const total = Math.max(COLS * 3, Math.ceil(cells.length / COLS) * COLS);
    for (let i = 0; i < total; i++) {
      const c = cells[i];
      const cell = this.doc.createElement('div');
      cell.className = 'bp-slot';
      if (!c) {
        cell.classList.add('empty');
        grid.appendChild(cell);
        continue;
      }
      cell.appendChild(buildItemSwatch(c.def, 44));
      cell.classList.add('takeable');
      const move = { from: side, id: c.def.id, count: c.count ?? null, index: c.index ?? null };
      if (c.count != null) {
        cell.title = `${c.def.name} ×${c.count} — click or drag to move`;
        const badge = this.doc.createElement('span');
        badge.className = 'bp-count';
        badge.textContent = String(c.count);
        cell.appendChild(badge);
      } else {
        cell.title = `${c.def.name}${this._conditionLabel(c.entry.id, c.entry.wear, c.entry.decay)} — click or drag to move`;
      }
      cell.draggable = true;
      cell.addEventListener('dragstart', (e) => {
        this._containerDrag = move;
        e.dataTransfer?.setData('text/plain', c.def.id);
      });
      cell.addEventListener('dragend', () => { this._containerDrag = null; });
      cell.addEventListener('click', () => this._moveStash(move));
      grid.appendChild(cell);
    }
  }

  /** Move a container-screen cell to the other side. Storage → player lands
   *  in the backpack (materials join the pile); player/equip → storage
   *  stashes it, condition intact. Whole material stacks move at once. */
  _moveStash(move) {
    const key = this._container?.key;
    if (!key) return;
    if (move.from === 'storage') {
      if (move.count != null) {
        const taken = this.containers.takeMaterial(key, move.id, move.count);
        if (taken) this.stats.addMaterial(move.id, taken);
      } else {
        const entry = this.containers.take(key, move.index);
        if (entry) this.stats.stow(entry.id, entry.wear, entry.decay);
      }
    } else if (move.from === 'player') {
      if (move.count != null) {
        const taken = this.stats.takeMaterial(move.id, move.count);
        if (taken) this.containers.addMaterial(key, move.id, taken);
      } else {
        const entry = this.stats.backpack.splice(move.index, 1)[0];
        if (entry) this.containers.stow(key, entry.id, entry.wear, entry.decay);
      }
    } else if (move.from === 'equip') {
      const id = this.stats.equipment[move.slot];
      if (!id) return;
      this.containers.stow(key, id, this.stats.wear[move.slot], this.stats.decay[move.slot]);
      this.stats.unequip(move.slot);
      this._updateHud();
    }
    this._renderContainer();
  }

  /** Drop a stored item onto an equipment slot: equip it there, stashing any
   *  displaced item back into the container. Material stacks can't be
   *  equipped — they fall through to the normal player-side move. */
  _equipFromStash(move, slot) {
    const key = this._container?.key;
    if (!key || move.from !== 'storage') return;
    if (move.count != null) {
      this._moveStash(move);
      return;
    }
    const entry = this.containers.take(key, move.index);
    if (!entry) return;
    const displacedId = this.stats.equipment[slot];
    if (displacedId) this.containers.stow(key, displacedId, this.stats.wear[slot], this.stats.decay[slot]);
    this.stats.equip(slot, entry.id);
    this.stats.wear[slot] = entry.wear ?? 0;
    this.stats.decay[slot] = entry.decay ?? 0;
    this._updateHud();
    this._renderContainer();
  }

  /** Use the equipped consumable (heals — and patches armor if the item's
   *  pack says so — then consumes it). Works for the classic injection and
   *  for crafted medical items alike; see engine/Craftables.js. */
  _useInjection() {
    const id = this.stats.equipment.injection;
    if (!id) {
      this._toast('No injection equipped');
      return;
    }
    const def = getEquipItem(id);
    if (this.stats.useInjection(def?.consumable ?? null)) {
      this._toast(`${def?.name ?? 'Injection'} used`);
      this._refillFromBackpack('injection');
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
    this._endDeathSequence();
    this.mode = 'menu';
    this._closeBackpack();
    this._closeContainer();
    this._closeCraft();
    this.touch?.setEnabled(false);
    this.ui.menu.classList.remove('hidden');
    this.ui.pause.classList.add('hidden');
    this.ui.death.classList.add('hidden');
    this.ui.hud.classList.add('hidden');
    this.ui.quest?.classList.add('hidden');
    this._clearQuestToasts();
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
    this._endDeathSequence();
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
    this._clearQuestToasts();
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
    this._closeBackpack();
    this._closeContainer();
    this._closeCraft();
    this._closeDialog();
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
    this.containers = new ContainerStore();
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

  async saveSlot(i) {
    try {
      const payload = this._makeSavePayload();
      await this.saves.write(manualSlotKey(i), payload, { savedAt: payload.savedAt });
      this._toast(`Saved to slot ${i + 1}`);
    } catch (e) {
      // Surface failures (quota, private mode) — a save the player believes
      // in but that never landed is the worst outcome.
      console.error('Save failed:', e);
      this._toast('Save failed');
    }
    this._renderSlots();
  }

  /** The full v3 save payload: pure player state. The world is static, so
   *  the save records only which map objects the player picked up — the
   *  world itself always comes from the current authored map. */
  _makeSavePayload() {
    return makeSave({
      pickedUp: diffPickedUp(this._baseItems ?? [], collectSparse(this.world).items),
      player: {
        x: this.walk.position.x,
        y: this.walk.position.y,
        z: this.walk.position.z,
        yaw: this.walk.yaw,
        pitch: this.walk.pitch,
      },
      stats: this.stats.serialize(),
      quests: this.quests.serialize(),
      flags: this.flags.serialize(),
      containers: this.containers.serialize(),
    });
  }

  async loadSlot(i) {
    const slot = await this.saves.read(manualSlotKey(i));
    if (!slot) {
      this._toast(`Slot ${i + 1} is empty`);
      return;
    }
    // The world is static: the CURRENT authored map is always the world —
    // a save only says which objects the player took off it. Map edits
    // therefore reach every save, and a tombstone that no longer matches
    // (its object was moved or removed by an edit) is simply ignored. Old
    // v2 snapshot saves carry no pickup list: their picked-up objects
    // respawn once, and the next save records pickups properly.
    const world = await this._fetchBaseWorld();
    for (const t of slot.pickedUp ?? []) {
      const it = world.itemAt(t.x, t.y, t.z);
      if (it && it.itemId === t.itemId) world.removeItemAt(t.x, t.y, t.z);
    }
    this._applyWorld(world);
    this.stats = PlayerStats.deserialize(slot.stats);
    this.quests = QuestLog.deserialize(slot.quests);
    this.flags = GameFlags.deserialize(slot.flags);
    this.containers = ContainerStore.deserialize(slot.containers);
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

  /** Slot metadata for the menu lists — reads only the tiny meta record,
   *  never the multi-MB payload. */
  async _slotMeta(i) {
    const meta = await this.saves?.readMeta(manualSlotKey(i));
    if (!meta) return { empty: true, label: 'Empty' };
    const d = new Date(meta.savedAt);
    const time = d.toLocaleTimeString?.() ?? `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    return { empty: false, label: `Slot ${i + 1} — ${time}` };
  }

  async _renderSlots() {
    const metas = await Promise.all(Array.from({ length: SLOT_COUNT }, (_, i) => this._slotMeta(i)));
    for (const el of [this.ui.slotsMenu, this.ui.slotsPause]) {
      if (!el) continue;
      el.innerHTML = '';
      for (let i = 0; i < SLOT_COUNT; i++) {
        const meta = metas[i];
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
    this.ui.btnRespawn?.addEventListener('click', () => this.respawn());
    this.ui.btnRepairFix?.addEventListener('click', () => this._repairFix());
    this.ui.btnRepairClose?.addEventListener('click', () => this._closeRepair());
    this.ui.btnCraftMake?.addEventListener('click', () => this._craftMake());
    this.ui.btnCraftClose?.addEventListener('click', () => this._closeCraft());
    this.ui.btnBackpackClose?.addEventListener('click', () => this._closeBackpack());
    this.ui.btnContainerClose?.addEventListener('click', () => this._closeContainer());
    // Grid-level drop targets wire once (the grids persist; only their cells
    // are re-rendered): anything dragged from the other side lands here.
    const acceptDrop = (el, wantFrom) => {
      if (!el) return;
      el.addEventListener('dragover', (e) => {
        if (this._containerDrag && wantFrom.includes(this._containerDrag.from)) e.preventDefault();
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const drag = this._containerDrag;
        this._containerDrag = null;
        if (drag && wantFrom.includes(drag.from)) this._moveStash(drag);
      });
    };
    acceptDrop(this.ui.containerGrid, ['player', 'equip']);
    acceptDrop(this.ui.containerPlayerGrid, ['storage']);
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
        if (this._craft) {
          this._closeCraft();
          return;
        }
        if (this._container) {
          this._closeContainer();
          return;
        }
        if (this._backpackOpen) {
          this._closeBackpack();
          return;
        }
        // Esc in a conversation is "leave me be": the chat closes and the
        // pointer re-locks — pausing stays on a second press.
        if (this._dialog) {
          this._closeDialog();
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
      // The crafting screen works like the backpack grid: the legs keep
      // working, Q (or Esc) closes it.
      if (this._craft) {
        if (e.code === 'KeyQ') this._closeCraft();
        else this.walk.onKeyDown(e.code);
        return;
      }
      // The container screen works like the backpack grid: the legs keep
      // working, E (or Esc) closes it.
      if (this._container) {
        if (e.code === 'KeyE' || e.code === 'KeyB') this._closeContainer();
        else this.walk.onKeyDown(e.code);
        return;
      }
      // The backpack grid leaves the legs alone — you can keep running from
      // the horde while rummaging. B (or Esc) closes it.
      if (this._backpackOpen) {
        if (e.code === 'KeyB') this._closeBackpack();
        else this.walk.onKeyDown(e.code);
        return;
      }
      if (e.code === 'KeyB') {
        this._openBackpack();
        return;
      }
      if (e.code === 'KeyQ') {
        this._openCraft();
        return;
      }
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
      // Only the locked pointer turns the head — a free cursor (dialogue
      // replies on screen) must be able to cross the screen standstill.
      if (this.mode === 'playing' && document.pointerLockElement) this.walk.onMouseMove(e.movementX, e.movementY);
    });
    on(this.doc, 'mousedown', (e) => {
      if (this.mode !== 'playing' || e.button !== 0) return;
      if (this._dialog || this._repair || this._backpackOpen || this._container || this._craft) return;
      // A click with no lock (e.g. the browser refused the post-dialog
      // re-lock) takes the lock back instead of firing — one click, no stray
      // shots into the menu that was supposed to be gone.
      if (!document.pointerLockElement) {
        this._relockPointer();
        return;
      }
      // Hold to autofire: _frame keeps attacking while the button is down
      // (the weapon's cooldown sets the fire rate).
      this._firing = true;
      this._attack();
    });
    on(this.doc, 'mouseup', (e) => {
      if (e.button === 0) this._firing = false;
    });
    // Losing pointer lock while playing (e.g. browser-requested exit) opens
    // the pause menu instead of leaving the player stuck. A conversation (or
    // one of its screens) intentionally frees the pointer, so those don't
    // count. Touch devices never enter pointer lock, so they pause on
    // backgrounding instead (below).
    on(this.doc, 'pointerlockchange', () => {
      const locked = document.pointerLockElement === this.webgl.domElement;
      if (!this.isTouch && this.mode === 'playing' && !locked && !this._repair && !this._backpackOpen && !this._container && !this._craft && !this._dialog) this.pauseGame();
    });
    // Mobile: when the app is backgrounded, auto-pause (there's no Esc and
    // pointer-lock loss never fires) so the player isn't killed while away.
    on(this.doc, 'visibilitychange', () => {
      if (this.isTouch && document.hidden && this.mode === 'playing') this.pauseGame();
    });
  }

  /** Center-screen one-liner for moment-to-moment gameplay notes (pickups,
   *  reloads, breakage). Quest business lives in the bottom-right card
   *  stack — see _questToast. */
  _toast(text) {
    if (!this.ui.toast) return;
    this.ui.toast.textContent = text;
    this.ui.toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.ui.toast.classList.remove('show'), 1600);
  }
}
