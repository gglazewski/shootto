// App.js — composition root: wires engine + editor together.
//
// Owns construction, input dispatch, persistence, restore, and the game loop.
// Replaces the old monolithic main.js `boot()` while keeping a stable
// debug/test handle (window.__voxelgame) with the fields the e2e suite uses.

import * as THREE from '../vendor/three.module.js';
import { World } from './engine/World.js';
import { Renderer } from './engine/Renderer.js';
import { CELL_SIZE } from './engine/Space.js';
import { listBlockIds, getBlock, SIZE, listDecalIds, getDecal, isPassable } from './engine/VoxelTypes.js';
import { getItem, listItems, registerItem, removeItem, isItemId, deserializeRegistry } from './engine/ItemRegistry.js';
import {
  getEquipItem,
  listEquipItems,
  registerEquipItem,
  removeEquipItem,
  isEquipId,
  deserializeEquipRegistry,
  deserializeEquipItem,
} from './engine/EquipmentRegistry.js';
import { MICRO_SIZE, gridOf, lightLevelForMeters, slugifyName, deserializeItem, rotateMicroPoint } from './engine/ItemTypes.js';
import { createAtlasTexture } from './textures/AtlasTexture.three.js';
import { Blinkers } from './engine/Blinkers.js';
import { FlyControls } from './editor/FlyControls.js';
import { WalkControls } from './editor/WalkControls.js';
import { SelectionGhost } from './editor/SelectionGhost.js';
import { SpawnMarker } from './editor/SpawnMarker.js';
import { MobMarker } from './editor/MobMarker.js';
import { Toolbar } from './editor/Toolbar.js';
import { Inventory } from './editor/Inventory.js';
import { UI } from './editor/UI.js';
import { buildSwatchList, buildDecalSwatchList } from './editor/Swatches.js';
import { EditorState } from './editor/EditorState.js';
import { History } from './editor/History.js';
import { ToolRegistry } from './editor/ToolRegistry.js';
import { BuildTool } from './editor/tools/BuildTool.js';
import { SquareTool } from './editor/tools/SquareTool.js';
import { SpawnTool } from './editor/tools/SpawnTool.js';
import { MobTool } from './editor/tools/MobTool.js';
import { NpcTool, NPC_MARKER_COLOR } from './editor/tools/NpcTool.js';
import { NpcQuestEditor } from './editor/npc/NpcQuestEditor.js';
import { deserializeNpcRegistry } from './engine/NpcRegistry.js';
import { deserializeQuestRegistry } from './engine/QuestRegistry.js';
import { registerBuiltinQuestItems } from './engine/QuestItems.js';
import { raycastVoxel, worldToCell } from './engine/VoxelRaycaster.js';
import { ItemTool } from './editor/tools/ItemTool.js';
import { DecalTool } from './editor/tools/DecalTool.js';
import { ItemEditor } from './editor/items/ItemEditor.js';
import { ItemCatalogue } from './editor/items/ItemCatalogue.js';
import { EquipmentEditor } from './editor/items/EquipmentEditor.js';
import { EquipCatalogue } from './editor/items/EquipCatalogue.js';
import { ItemRenderer } from './editor/ItemRenderer.js';
import { buildItemSwatch } from './editor/items/itemSwatch.js';
import { itemAwarePick, collisionWorld } from './editor/itemPick.js';
import { isDoorVoxel, isOpenDoor, toggleDoor } from './engine/Doors.js';
import { InputDispatcher } from './editor/Input.js';
import { ToolRing } from './editor/ToolRing.js';
import { Notice, onNotice } from './editor/Notice.js';
import { SignModal } from './editor/SignModal.js';
import { WorldBrowser } from './editor/WorldBrowser.js';
import { SplashCamMarker } from './editor/SplashCamMarker.js';
import { SplashMotionModal, SPLASH_MOTIONS } from './editor/SplashMotionModal.js';
import { createTextDecal } from './engine/TextDecals.js';
import { GameLoop } from './GameLoop.js';
import { PersistenceService } from './PersistenceService.js';
import { CONFIG } from './config.js';

export class App {
  /**
   * @param {object} [deps]
   * @param {Document} [deps.doc]
   * @param {HTMLElement} [deps.container]
   */
  constructor({ doc = document, container } = {}) {
    this.doc = doc;
    this.container = container ?? doc.querySelector('#game');
    this._unsubs = [];
    this._wasLocked = false;

    // --- engine ---
    this.world = new World();
    this.blinkers = new Blinkers(this.world);
    this.webgl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.container.appendChild(this.webgl.domElement);
    const { texture, tileIndexFor, atlas, rebuild } = createAtlasTexture(THREE);
    this.rebuildAtlas = rebuild;
    this.renderer = new Renderer({ THREE, webgl: this.webgl, world: this.world, atlasTexture: texture, tileIndexFor, atlas });

    // --- editor state / history ---
    this.state = new EditorState({
      blockId: 'grass', size: SIZE.SMALL, itemId: null, itemRotation: 0,
      blockRotation: 0, decalId: null, decalRotation: 0,
    });
    this.history = new History({ max: CONFIG.history.max });

    this.controls = new FlyControls({ THREE, camera: this.renderer.camera, domElement: this.webgl.domElement, opts: CONFIG.controls });
    this.walk = new WalkControls({
      THREE,
      camera: this.renderer.camera,
      domElement: this.webgl.domElement,
      world: collisionWorld(this.world),
      opts: { sensitivity: CONFIG.controls.sensitivity, ...CONFIG.player },
    });
    this.mode = 'edit'; // 'edit' | 'test'
    this._savedEditorCam = null;
    this.ghost = new SelectionGhost({ THREE, scene: this.renderer.scene, atlasTexture: texture, tileIndexFor, atlas });
    this.spawnMarker = new SpawnMarker({ THREE, scene: this.renderer.scene, world: this.world });
    this.mobMarker = new MobMarker({ THREE, scene: this.renderer.scene, world: this.world });
    // NPC spawn beacons: same renderer as mob markers, friendly-green tint.
    this.npcMarker = new MobMarker({
      THREE,
      scene: this.renderer.scene,
      world: this.world,
      forEachSpawn: (w, fn) => w.forEachNpcSpawn(fn),
      colorFor: () => NPC_MARKER_COLOR,
    });
    this.splashCamMarker = new SplashCamMarker({ THREE, scene: this.renderer.scene, world: this.world });

    // --- UI ---
    const items = listBlockIds()
      .filter((id) => !getBlock(id).hidden) // internal states (blink-off phases)
      .map((id) => ({ id, name: getBlock(id).name }));
    const decalItems = listDecalIds().map((id) => ({ id, name: getDecal(id).name }));
    this.toolbar = new Toolbar({ container: this.doc.querySelector('#toolbar'), items: buildSwatchList(items) });
    this.inventory = new Inventory({
      container: this.doc.querySelector('#inventory'),
      items: buildSwatchList(items),
      decalItems: buildDecalSwatchList(decalItems),
    });
    this.ui = new UI({ doc });
    onNotice((n) => this.ui.toast(n.message, n.level === 'info' ? 1200 : 2400));

    // --- input ---
    this.input = new InputDispatcher({ domElement: this.webgl.domElement, doc });

    // --- persistence ---
    this.persistence = new PersistenceService({
      world: this.world,
      saveKey: CONFIG.saveKey,
      itemSaveKey: CONFIG.itemSaveKey,
      equipSaveKey: CONFIG.equipSaveKey,
      npcSaveKey: CONFIG.npcSaveKey,
      questSaveKey: CONFIG.questSaveKey,
      notice: Notice,
    });

    // --- items (F2 placeable objects) ---
    this.itemRenderer = new ItemRenderer({
      THREE,
      scene: this.renderer.scene,
      world: this.world,
      lightField: this.renderer.light,
      material: this.renderer.itemMaterial,
    });
    this.itemEditor = new ItemEditor({ THREE, camera: this.renderer.camera, doc });
    this.itemEditor.onClose = () => this.exitItemEditor();
    this.itemEditor.onSave = (item) => this._saveItem(item);
    this.itemEditor.onOpenCatalogue = () => this.openCatalogue();
    this.catalogue = new ItemCatalogue({
      doc,
      container: this.doc.querySelector('#item-catalogue'),
      callbacks: {
        onCard: (id) => this._catalogueCard(id),
        onEdit: (id) => this._editItem(id),
        onExport: (id) => this._exportItem(id),
        onDelete: (id) => this._deleteItem(id),
        onImport: (text) => this._importItem(text),
      },
    });
    this.catalogue.onClose = () => {
      // Restore pointer lock in the world editor so editing resumes right away.
      if (this.mode === 'edit' && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };

    // --- world library (save/load/organize worlds on the server) ---
    this.worldBrowser = new WorldBrowser({
      doc,
      container: this.doc.querySelector('#world-browser'),
      callbacks: {
        list: () => this.persistence.listWorlds(),
        load: (path) => this.loadLibraryWorld(path),
        save: (path) => this.persistence.saveWorld(path),
        remove: (path) => this.persistence.deleteWorld(path),
        move: (from, to) => this.persistence.moveWorld(from, to),
        mkdir: (path) => this.persistence.mkdirWorlds(path),
      },
    });
    this.worldBrowser.onClose = () => {
      if (this.mode === 'edit' && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };

    // Clicking a splash-cam gizmo opens this picker for the shot's menu motion.
    this.splashMotionModal = new SplashMotionModal({ doc, container: this.doc.querySelector('#splash-motion') });
    this.splashMotionModal.onClose = () => {
      if (this.mode === 'edit' && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };
    this._raycaster = new THREE.Raycaster();

    // --- equippable items (F3 editor) ---
    this.equipmentEditor = new EquipmentEditor({ THREE, camera: this.renderer.camera, doc });
    this.equipmentEditor.onClose = () => this.exitEquipEditor();
    this.equipmentEditor.onSave = (item) => this._saveEquipItem(item);
    this.equipmentEditor.onOpenCatalogue = () => this.openEquipCatalogue();
    this.equipCatalogue = new EquipCatalogue({
      doc,
      container: this.doc.querySelector('#equip-catalogue'),
      callbacks: {
        onCard: (id) => this._editEquipItem(id),
        onEdit: (id) => this._editEquipItem(id),
        onExport: (id) => this._exportEquipItem(id),
        onDelete: (id) => this._deleteEquipItem(id),
        onImport: (text) => this._importEquipItem(text),
      },
    });
    this.equipCatalogue.onClose = () => {
      if (this.mode === 'equip') return; // stays inside the F3 editor
      if (this.mode === 'edit' && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };

    // --- NPC & quest editor (F4) ---
    this.npcQuestEditor = new NpcQuestEditor({
      doc,
      onChange: () => this._saveNpcQuestRegistries(),
    });
    this.npcQuestEditor.onClose = () => {
      if (this.mode === 'edit' && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };
    this.npcQuestEditor.onPickSpawn = (cb) => this._beginQuestSpawnPick(cb);
    this._questSpawnPick = null; // pending "Select spawn" receiver, or null

    // --- tools ---
    const ctx = {
      THREE,
      world: this.world,
      camera: this.renderer.camera,
      scene: this.renderer.scene,
      ghost: this.ghost,
      state: this.state,
      history: this.history,
      input: this.input,
      onItemChange: () => this._refreshItemLights(),
    };
    this.tools = new ToolRegistry();
    this.tools.register(new BuildTool(ctx));
    this.tools.register(new SquareTool(ctx));
    this.tools.register(new SpawnTool(ctx));
    this.tools.register(new MobTool(ctx));
    this.tools.register(new NpcTool(ctx));
    this.tools.register(new ItemTool(ctx));
    this.tools.register(new DecalTool(ctx));
    this.tool = this.tools.get('build'); // back-compat alias (tests / debug)
    this.tools.activate('build');

    this.toolRing = new ToolRing({ doc });
    this.toolRing.setTools(this.tools.list().map((t) => ({ id: t.id, name: t.name })));

    // --- state -> UI sync ---
    this.state.on(({ field }) => {
      if (field === 'blockId') {
        this.state.set('itemId', null);
        this.state.set('decalId', null);
        const id = this.state.get('blockId');
        if (id) {
          this.toolbar.selectType(id);
          this.ui.setSelection(id, this.state.get('size'));
        } else {
          // Deselected: nothing in hand.
          this.toolbar.clearSelection();
          this.ui.setSelection(null, null);
        }
      }
      if (field === 'itemId') {
        const id = this.state.get('itemId');
        if (id) {
          this.state.set('decalId', null);
          const it = getItem(id) ?? getEquipItem(id);
          this.toolbar.selectItem(id);
          this.ui.setSelection(`Item: ${it?.name ?? id}`, gridOf(it).map((g) => g * MICRO_SIZE).join('×') + ' m');
          this.tools.activate('item');
        } else if (this.tools.active?.id === 'item') {
          this.toolbar.clearSelection();
          this.ui.setSelection(this.state.get('blockId'), this.state.get('size'));
          this.tools.activate('build');
        }
        this.ui.setTool(this.tools.active.name);
      }
      if (field === 'decalId') {
        const id = this.state.get('decalId');
        if (id) {
          this.state.set('itemId', null);
          this.toolbar.selectDecal(id);
          this.ui.setSelection(`Decal: ${getDecal(id)?.name ?? id}`, 'face');
          this.tools.activate('decal');
        } else if (this.tools.active?.id === 'decal') {
          this.toolbar.clearSelection();
          this.ui.setSelection(this.state.get('blockId'), this.state.get('size'));
          this.tools.activate('build');
        }
        this.ui.setTool(this.tools.active.name);
      }
    });
    this.toolbar.onSelect = (slot) => {
      if (!slot) {
        // Deselect: nothing in hand.
        this.state.set('itemId', null);
        this.state.set('decalId', null);
        this.state.set('blockId', null);
        return;
      }
      if (slot.kind === 'item') this.state.set('itemId', slot.id);
      else if (slot.kind === 'decal') this.state.set('decalId', slot.id);
      else this.state.set('blockId', slot.id);
    };
    this.inventory.onSelect = (id) => this.state.set('blockId', id);
    this.inventory.onSelectItem = (id) => this.state.set('itemId', id);
    this.inventory.onSelectEquip = (id) => this.state.set('itemId', id);
    this.inventory.onSelectDecal = (id) => this.state.set('decalId', id);

    // --- text signs (created from the Decals section) ---
    this.signModal = new SignModal({ doc });
    this.inventory.onCreateSign = () => this.signModal.show();
    this.signModal.onCreate = (spec) => {
      const sign = createTextDecal(spec);
      if (!sign) return;
      this.rebuildAtlas();
      this._refreshDecalItems();
      this.state.set('decalId', sign.id); // in hand, decal tool active
      Notice.info(`Sign ready — click a wall to place it`);
    };
    this.signModal.onClose = () => {
      if (this.mode === 'edit' && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };
    // Closing the inventory (selection, E, or backdrop click) re-locks the
    // pointer so editing resumes right away.
    this.inventory.onClose = () => {
      if (this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };

    // --- actions ---
    this.ui.cb = {
      save: () => this.save(),
      load: (text) => this.load(text),
      export: () => this.exportMap(),
      saveFile: () => this.saveFile(),
      clear: () => this.clearWorld(),
      undo: () => this.undo(),
      redo: () => this.redo(),
      items: () => this.openCatalogue(),
      worlds: () => this.openWorldBrowser(),
    };

    // initial HUD state
    this.ui.setSelection(this.state.get('blockId'), this.state.get('size'));
    this.ui.setTool(this.tools.active.name);

    // item registry from browser storage
    this._loadItemRegistry();
    this._loadEquipRegistry();
    this._loadNpcQuestRegistries();
  }

  // --- actions ---

  save() {
    this.persistence.save();
  }

  load(text) {
    const { world: loaded, errors } = this.persistence.parse(text);
    this.replaceWorldVoxels(loaded);
    // A bundle registers its objects too; refresh the inventory/catalogue so
    // the objects the map references show up as placeable.
    this._refreshInventoryObjects();
    this.ui.toast(errors.length ? `Loaded with ${errors.length} warning(s)` : 'Loaded map');
  }

  exportMap() {
    this.persistence.export();
  }

  openWorldBrowser() {
    if (this.doc.exitPointerLock) this.doc.exitPointerLock();
    this.worldBrowser.show();
  }

  /** Load a world from the server's library into the editor. */
  async loadLibraryWorld(path) {
    const text = await this.persistence.readWorld(path);
    if (text == null) {
      this.ui.toast(`Could not load worlds/${path}`, 2000);
      return;
    }
    this.load(text);
    this.ui.toast(`Loaded worlds/${path}`);
  }

  // --- splash cameras (F8: turn the current editor view into a menu shot) ---

  /** Capture the editor camera as a splash camera and, when the world lives
   *  in the library, register the shot in the menu's splash manifest. */
  async captureSplashCam() {
    const cam = this.renderer.camera;
    const id = `cam_${Date.now().toString(36)}`;
    this.world.addSplashCam({
      id,
      pos: [cam.position.x, cam.position.y, cam.position.z],
      yaw: this.controls.yaw,
      pitch: this.controls.pitch,
      fov: cam.fov,
      motion: 'orbit',
    });
    const worldPath = this.worldBrowser.currentPath;
    if (!worldPath) {
      this.ui.toast('Splash camera saved in this world — save it to the Worlds library to put it on the menu', 3200);
      return;
    }
    // Persist the world (the cam lives in it) before pointing the menu at it.
    if (!(await this.persistence.saveWorld(worldPath))) {
      this.ui.toast('Splash camera saved, but the world could not be written to the library', 2600);
      return;
    }
    const manifest = (await this.persistence.readSplash()) ?? { format: 'splashlist', version: 1, entries: [] };
    if (!Array.isArray(manifest.entries)) manifest.entries = [];
    manifest.entries.push({ world: worldPath, cam: id });
    if (await this.persistence.writeSplash(manifest)) {
      this.ui.toast(`Splash screen #${manifest.entries.length} added to the main menu`, 2200);
    } else {
      this.ui.toast('Splash camera saved, but the menu manifest could not be written', 2600);
    }
  }

  /** LMB on a splash-cam gizmo: open the motion picker for that shot.
   *  @returns {boolean} true when a gizmo was hit (the click is consumed) */
  _clickSplashCam() {
    const camId = this.splashCamMarker.pick(this._raycaster, this.renderer.camera);
    if (!camId) return false;
    const cam = this.world.splashCams.find((c) => c.id === camId);
    if (!cam) return false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.splashMotionModal.open(cam, async (motion) => {
      cam.motion = motion;
      const label = SPLASH_MOTIONS.find((m) => m.id === motion)?.label ?? motion;
      this.ui.toast(`Splash motion: ${label}`, 1200);
      // The shot lives in the world — persist so the menu plays the new motion.
      const worldPath = this.worldBrowser.currentPath;
      if (worldPath) await this.persistence.saveWorld(worldPath);
    });
    return true;
  }

  /** Remove the splash camera nearest to the editor view (Shift+F8). */
  async deleteNearestSplashCam() {
    const p = this.renderer.camera.position;
    let best = null;
    let bestD = Infinity;
    this.world.forEachSplashCam((c) => {
      const d = Math.hypot(c.pos[0] - p.x, c.pos[1] - p.y, c.pos[2] - p.z);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    });
    if (!best || bestD > 10) {
      this.ui.toast('No splash camera nearby (fly within 10 m of its gizmo)', 2000);
      return;
    }
    this.world.removeSplashCam(best.id);
    this.ui.toast('Splash camera removed', 1400);
    const manifest = await this.persistence.readSplash();
    if (manifest?.entries?.some((e) => e.cam === best.id)) {
      manifest.entries = manifest.entries.filter((e) => e.cam !== best.id);
      await this.persistence.writeSplash(manifest);
    }
    const worldPath = this.worldBrowser.currentPath;
    if (worldPath) await this.persistence.saveWorld(worldPath);
  }

  /** Save the world + objects to the deployment file (map/voxelbundle.json)
   *  when a server is present; otherwise fall back to browser storage. */
  async saveFile() {
    const saved = await this.persistence.saveToServer();
    if (!saved) {
      this.persistence.save();
      this.ui.toast('Saved to browser (no server available)', 1600);
    }
  }

  clearWorld() {
    this.world.clear();
    this.history.clear();
    this.renderer.clearChunks();
    this.itemRenderer.clear();
    this._refreshItemLights();
    this.ui.toast('World cleared');
  }

  undo() {
    const cmd = this.history.undo();
    if (cmd) this.ui.toast(`Undo: ${cmd.description}`, 700);
  }

  redo() {
    const cmd = this.history.redo();
    if (cmd) this.ui.toast(`Redo: ${cmd.description}`, 700);
  }

  /** Toggle the polaroid/bloom post pipeline at runtime (P). */
  togglePostFX() {
    const on = this.renderer.togglePostFX();
    this.ui.toast(`Polaroid filter: ${on ? 'on' : 'off'}`, 900);
  }

  /** Middle-click: aim the selection at the block or item under the crosshair. */
  pickBlock() {
    const hit = itemAwarePick(this.world, THREE, this.renderer.camera);
    if (!hit) return;
    const item = this.world.itemAt(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (item) {
      this.state.set('itemId', item.itemId);
      const def = getItem(item.itemId) ?? getEquipItem(item.itemId);
      this.ui.toast(`Picked item: ${def?.name ?? item.itemId}`, 900);
      return;
    }
    const voxel = this.world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!voxel) return;
    // A blinking light caught dark picks as its lit id, never the hidden phase.
    const id = getBlock(voxel.type)?.blinkOn ?? voxel.type;
    this.state.set('blockId', id);
    this.state.set('size', voxel.size);
    this.state.set('blockRotation', voxel.rotation ?? 0);
    this.state.set('blockVariant', voxel.variant ?? null);
    this.ui.toast(`Picked: ${getBlock(id).name}`, 900);
  }

  // --- item registry / rendering ---

  _loadItemRegistry() {
    const text = this.persistence.readItemRegistry();
    if (text) {
      const loaded = deserializeRegistry(text);
      if (loaded.length) {
        Notice.info(`Loaded ${loaded.length} saved item(s)`);
        this._refreshInventoryObjects();
      }
      return;
    }
    // No saved registry: seed the catalogue from the deployed bundle's objects.
    const bundled = this.persistence.loadBundled();
    if (bundled.world && bundled.itemCount > 0) {
      Notice.info(`Loaded ${bundled.itemCount} bundled item(s)`);
      this._refreshInventoryObjects();
    }
  }

  _saveItem(item) {
    registerItem(item);
    this.persistence.saveItemRegistry();
    this.itemRenderer.rebuildAll();
    this._refreshInventoryObjects();
    this.catalogue.refresh();
    this._refreshItemLights();
    this.ui.toast(`Saved "${item.name}" to the catalogue`);
  }

  _refreshInventoryObjects() {
    this.inventory.updateObjectItems(
      listItems().map((it) => ({ id: it.id, name: it.name, canvas: buildItemSwatch(it) })),
    );
  }

  /** Hotbar entry for a block id (from the toolbar's block swatch list). */
  _blockEntry(id) {
    return this.toolbar.items.find((it) => it.id === id) ?? null;
  }

  /** Re-list decals in the inventory (after a text sign was registered). */
  _refreshDecalItems() {
    const decalItems = listDecalIds().map((id) => ({ id, name: getDecal(id).name }));
    this.inventory.updateDecalItems(buildDecalSwatchList(decalItems));
  }

  /** Hotbar entry for a decal id (fresh preview canvas). */
  _decalEntry(id) {
    const decal = getDecal(id);
    if (!decal) return null;
    return { kind: 'decal', id: decal.id, name: decal.name, canvas: buildDecalSwatchList([{ id: decal.id, name: decal.name }])[0].canvas };
  }

  /** Hotbar entry for a placeable object id (fresh preview canvas). */
  _objectEntry(id) {
    const item = getItem(id);
    if (!item) return null;
    return { kind: 'item', id: item.id, name: item.name, canvas: buildItemSwatch(item) };
  }

  /** Hotbar entry for an equippable item id (fresh preview canvas). */
  _equipEntry(id) {
    const item = getEquipItem(id);
    if (!item) return null;
    return { kind: 'item', id: item.id, name: item.name, canvas: buildItemSwatch(item) };
  }

  // --- item catalogue ---

  openCatalogue() {
    this.catalogue.refresh();
    this.catalogue.show();
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Card click: in the world editor arm placement, in the item editor load it. */
  _catalogueCard(id) {
    if (this.mode === 'item') this._editItem(id);
    else {
      this.state.set('itemId', id);
      this.catalogue.hide();
      this.ui.toast(`Placing: ${getItem(id)?.name}`, 900);
    }
  }

  /** Load a saved item back into the item editor for editing. */
  _editItem(id) {
    const item = getItem(id);
    if (!item) return;
    this.itemEditor.loadItem(item);
    if (this.mode !== 'item') this.enterItemEditor();
    this.catalogue.hide();
    this.ui.toast(`Editing "${item.name}"`, 900);
  }

  /** Explicit export: download the item's file (save itself stays in-app). */
  _exportItem(id) {
    const item = getItem(id);
    if (!item) return;
    this.persistence.downloadItem(item);
    this.ui.toast(`Exported ${item.name}.json`, 900);
  }

  /** Remove an item from the catalogue, the inventory and the world. */
  _deleteItem(id) {
    const item = getItem(id);
    if (!item) return;
    const placed = this.world.removeItemsById(id);
    removeItem(id);
    this.persistence.saveItemRegistry();
    this.itemRenderer.rebuildAll();
    this._refreshInventoryObjects();
    this.catalogue.refresh();
    this._refreshItemLights();
    if (this.state.get('itemId') === id) this.state.set('itemId', null);
    this.ui.toast(`Deleted "${item.name}"${placed ? ` (${placed} placed)` : ''}`);
  }

  /** Import an item file into the catalogue (handles id collisions). */
  _importItem(text) {
    const { item, errors } = deserializeItem(text);
    if (!item) {
      this.ui.toast(errors[0] ?? 'Import failed', 2400);
      return;
    }
    let id = item.id;
    if (!id || isItemId(id)) {
      const base = slugifyName(item.name);
      id = base;
      let n = 2;
      while (isItemId(id)) id = `${base}_${n++}`;
    }
    item.id = id;
    registerItem(item);
    this.persistence.saveItemRegistry();
    this.itemRenderer.rebuildAll();
    this._refreshInventoryObjects();
    this.catalogue.refresh();
    this.ui.toast(`Imported "${item.name}"`);
  }

  // --- equipment registry (F3 equippable items) ---

  _loadEquipRegistry() {
    // Built-in quest items (granny's teapot) register first, so they're
    // always placeable; an authored def saved under the same id wins.
    registerBuiltinQuestItems();
    const text = this.persistence.readEquipRegistry();
    if (text && deserializeEquipRegistry(text).length) {
      Notice.info('Loaded saved item(s) for the items editor');
    }
    this._refreshInventoryEquip();
  }

  // --- NPC + quest registries (F4 editor) ---

  /** Restore authored NPCs/questlines from browser storage. Nothing saved
   *  yet → the built-in defaults (the granny) stand. */
  _loadNpcQuestRegistries() {
    const npcText = this.persistence.readNpcRegistry();
    if (npcText) deserializeNpcRegistry(npcText);
    const questText = this.persistence.readQuestRegistry();
    if (questText) deserializeQuestRegistry(questText);
  }

  /** Persist both registries (every F4 panel mutation lands here). */
  _saveNpcQuestRegistries() {
    this.persistence.saveNpcRegistry();
    this.persistence.saveQuestRegistry();
  }

  /** F4 "Select spawn": close the quest panel and let the next crosshair
   *  click in the world pick the slay pack's spawn cell. The panel reopens
   *  with the result (see _finishQuestSpawnPick, hooked into mousedown). */
  _beginQuestSpawnPick(cb) {
    this._questSpawnPick = cb;
    this.npcQuestEditor.close(); // onClose re-locks the pointer for aiming
    Notice.info('Aim and click a block — the pack spawns on the cell above it (RMB cancels)', 2600);
  }

  /** Resolve a pending spawn pick: LMB takes the cell adjacent to the hovered
   *  face (where a mob's feet would go), RMB cancels. Reopens the panel. */
  _finishQuestSpawnPick(button) {
    const cb = this._questSpawnPick;
    this._questSpawnPick = null;
    if (button === 0) {
      const origin = worldToCell(this.renderer.camera.position.toArray());
      const dir = this.renderer.camera.getWorldDirection(new THREE.Vector3());
      const hit = raycastVoxel(this.world, origin, [dir.x, dir.y, dir.z]);
      if (hit) {
        cb([hit.cell[0] + hit.normal[0], hit.cell[1] + hit.normal[1], hit.cell[2] + hit.normal[2]]);
        Notice.info('Slay spawn set');
      } else {
        Notice.warn('No block hit — spawn point unchanged');
      }
    }
    if (document.pointerLockElement) document.exitPointerLock();
    this.npcQuestEditor.open();
  }

  /** Refresh the E inventory's Equippable Items section from the registry. */
  _refreshInventoryEquip() {
    this.inventory.updateEquipItems(
      listEquipItems().map((it) => ({ id: it.id, name: it.name, canvas: buildItemSwatch(it) })),
    );
  }

  /** Register + persist an equippable item saved from the F3 editor. */
  _saveEquipItem(item) {
    registerEquipItem(item);
    this.persistence.saveEquipRegistry();
    this.equipCatalogue.refresh();
    this._refreshInventoryEquip();
    this.ui.toast(`Saved "${item.name}" to the items catalogue`);
  }

  /** Load a saved equippable item back into the F3 editor for editing. */
  _editEquipItem(id) {
    const item = getEquipItem(id);
    if (!item) return;
    this.equipmentEditor.loadEquipItem(item);
    if (this.mode !== 'equip') this.enterEquipEditor();
    this.equipCatalogue.hide();
    this.ui.toast(`Editing "${item.name}"`, 900);
  }

  /** Explicit export: download the item's file (save itself stays in-app). */
  _exportEquipItem(id) {
    const item = getEquipItem(id);
    if (!item) return;
    this.persistence.downloadEquipItem(item);
    this.ui.toast(`Exported ${item.name}.json`, 900);
  }

  /** Remove an equippable item from the registry and any placements. */
  _deleteEquipItem(id) {
    const item = getEquipItem(id);
    if (!item) return;
    const placed = this.world.removeItemsById(id);
    removeEquipItem(id);
    this.persistence.saveEquipRegistry();
    this.itemRenderer.rebuildAll();
    this.equipCatalogue.refresh();
    this._refreshInventoryEquip();
    this._refreshItemLights();
    if (this.state.get('itemId') === id) this.state.set('itemId', null);
    this.ui.toast(`Deleted "${item.name}"${placed ? ` (${placed} placed)` : ''}`);
  }

  /** Import an equippable item file into the catalogue (handles id collisions). */
  _importEquipItem(text) {
    const { item, errors } = deserializeEquipItem(text);
    if (!item) {
      this.ui.toast(errors[0] ?? 'Import failed', 2400);
      return;
    }
    let id = item.id;
    if (!id || isEquipId(id)) {
      const base = slugifyName(item.name);
      id = base;
      let n = 2;
      while (isEquipId(id)) id = `${base}_${n++}`;
    }
    item.id = id;
    registerEquipItem(item);
    this.persistence.saveEquipRegistry();
    this.equipCatalogue.refresh();
    this._refreshInventoryEquip();
    this.ui.toast(`Imported "${item.name}"`);
  }

  openEquipCatalogue() {
    this.equipCatalogue.refresh();
    this.equipCatalogue.show();
  }

  /** Recompute item light sources for the light field, then re-flood and
   *  re-bake chunk light so the world is lit instantly. */
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
    // Placing/removing an item changes the light field but doesn't mark chunks
    // dirty, so rebuild the loaded chunks to bake the new light immediately.
    this.renderer.rebakeChunkLight();
  }

  // --- test-run mode (F5) ---

  toggleTestMode() {
    if (this.mode === 'edit') this.enterTestMode();
    else this.exitTestMode();
  }

  enterTestMode() {
    const cam = this.renderer.camera;
    this._savedEditorCam = {
      x: cam.position.x,
      y: cam.position.y,
      z: cam.position.z,
      yaw: cam.rotation.y,
      pitch: cam.rotation.x,
    };
    // stop editor gesture state
    this.tools.active?.cancel?.();
    if (this.toolRing.open) this.toolRing.close();
    this.inventory.hide();
    this.ui.hideHelp();
    this.ghost.hide();
    this.spawnMarker.setVisible(false);
    this.mobMarker.setVisible(false);
    this.npcMarker.setVisible(false);
    this.splashCamMarker.setVisible(false);
    this.controls.keys.clear();
    this.controls.velocity.set(0, 0, 0);

    const cell = this._testSpawnCell();
    this.walk.spawnAt(cell[0], cell[1], cell[2], ((this.world.spawnYaw ?? 0) * Math.PI) / 180);

    this._openedDoors = new Set();
    this._testPrompt = null;
    this.ui.setPrompt(null);

    this.mode = 'test';
    this.doc.body.classList.add('test-mode');
    this.ui.toast('Test run — F5 to exit', 2200);
    if (this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
  }

  exitTestMode() {
    this.mode = 'edit';
    this.walk.keys.clear();
    this.walk.velocity.set(0, 0, 0);
    // A playtest must not edit the map: put every door the player touched
    // back the way the author left it.
    for (const voxel of this._openedDoors ?? []) toggleDoor(this.world, voxel);
    this._openedDoors = null;
    this._testPrompt = null;
    this.ui.setPrompt(null);
    this.doc.body.classList.remove('test-mode');
    if (this._savedEditorCam) {
      const cam = this.renderer.camera;
      const c = this._savedEditorCam;
      cam.position.set(c.x, c.y, c.z);
      cam.rotation.set(c.pitch, c.yaw, 0, 'YXZ');
      this.controls.yaw = c.yaw;
      this.controls.pitch = c.pitch;
      this._savedEditorCam = null;
    }
    this.ui.toast('Back to editor', 1200);
  }

  /** The door voxel under the crosshair in a test run, or null. Mirrors the
   *  game's aim: the primary ray treats OPEN doors as air (their footprint
   *  fills the whole doorway and would otherwise swallow everything beyond
   *  it), so a second ray runs only when the first found nothing — that one
   *  hits the open leaf so it can be closed again. */
  _testPickDoor() {
    const solid = {
      get: (x, y, z) => {
        const v = this.world.get(x, y, z);
        return v && isPassable(v.type) ? null : v;
      },
      itemAt: (x, y, z) => this.world.itemAt(x, y, z),
    };
    for (const w of [solid, this.world]) {
      const hit = itemAwarePick(w, THREE, this.renderer.camera, CONFIG.test.interactCells);
      if (!hit) continue;
      const voxel = this.world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
      if (isDoorVoxel(voxel)) return voxel;
      // The first ray hit something solid that isn't a door — nothing to
      // interact with, and the open-door pass would only see through it.
      return null;
    }
    return null;
  }

  /** Per-frame while test-running: show/hide the "press E" prompt for whatever
   *  the crosshair is on. The DOM is touched only when the text changes. */
  _updateTestPrompt() {
    const door = this._testPickDoor();
    const text = door ? `Press <kbd>E</kbd> to ${isOpenDoor(door) ? 'close' : 'open'} the door` : null;
    if (text === this._testPrompt) return;
    this._testPrompt = text;
    this.ui.setPrompt(text);
  }

  /** E in a test run: act on the aimed object (doors for now). */
  _testInteract() {
    const door = this._testPickDoor();
    if (!door) return;
    // Remembered so exitTestMode can undo it — a playtest leaves no trace.
    if (!toggleDoor(this.world, door)) return;
    if (this._openedDoors.has(door)) this._openedDoors.delete(door);
    else this._openedDoors.add(door);
    this._updateTestPrompt();
  }

  // --- item editor mode (F2) ---

  toggleItemEditor() {
    if (this.mode === 'edit') this.enterItemEditor();
    else if (this.mode === 'item') this.exitItemEditor();
  }

  enterItemEditor() {
    if (this.mode !== 'edit') return;
    this._savedEditorCam = {
      x: this.renderer.camera.position.x,
      y: this.renderer.camera.position.y,
      z: this.renderer.camera.position.z,
      yaw: this.controls.yaw,
      pitch: this.controls.pitch,
    };
    this.tools.active?.cancel?.();
    if (this.toolRing.open) this.toolRing.close();
    this.inventory.hide();
    this.ui.hideHelp();
    this.ghost.hide();
    this.spawnMarker.setVisible(false);
    this.mobMarker.setVisible(false);
    this.npcMarker.setVisible(false);
    this.splashCamMarker.setVisible(false);
    this.controls.keys.clear();
    this.controls.velocity.set(0, 0, 0);
    if (document.pointerLockElement) document.exitPointerLock();
    this.controls.enabled = false;
    this.walk.enabled = false;

    this.mode = 'item';
    this.doc.body.classList.add('item-mode');
    this.itemEditor.enter();
    this.ui.toast('Item editor — F2 to exit', 2200);
  }

  exitItemEditor() {
    if (this.mode !== 'item') return;
    this.itemEditor.exit();
    this.mode = 'edit';
    this.controls.enabled = true;
    this.walk.enabled = true;
    this.doc.body.classList.remove('item-mode');
    if (this._savedEditorCam) {
      const cam = this.renderer.camera;
      const c = this._savedEditorCam;
      cam.position.set(c.x, c.y, c.z);
      cam.rotation.set(c.pitch, c.yaw, 0, 'YXZ');
      this.controls.yaw = c.yaw;
      this.controls.pitch = c.pitch;
      this._savedEditorCam = null;
    }
    if (this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    this.ui.toast('Back to world editor', 1200);
  }

  // --- items editor mode (F3) ---

  toggleEquipEditor() {
    if (this.mode === 'edit') this.enterEquipEditor();
    else if (this.mode === 'equip') this.exitEquipEditor();
  }

  enterEquipEditor() {
    if (this.mode !== 'edit') return;
    this._savedEditorCam = {
      x: this.renderer.camera.position.x,
      y: this.renderer.camera.position.y,
      z: this.renderer.camera.position.z,
      yaw: this.controls.yaw,
      pitch: this.controls.pitch,
    };
    this.tools.active?.cancel?.();
    if (this.toolRing.open) this.toolRing.close();
    this.inventory.hide();
    this.ui.hideHelp();
    this.ghost.hide();
    this.spawnMarker.setVisible(false);
    this.mobMarker.setVisible(false);
    this.npcMarker.setVisible(false);
    this.splashCamMarker.setVisible(false);
    this.controls.keys.clear();
    this.controls.velocity.set(0, 0, 0);
    if (document.pointerLockElement) document.exitPointerLock();
    this.controls.enabled = false;
    this.walk.enabled = false;

    this.mode = 'equip';
    this.doc.body.classList.add('equip-mode');
    this.equipmentEditor.enter();
    this.ui.toast('Items editor — F3 to exit', 2200);
  }

  exitEquipEditor() {
    if (this.mode !== 'equip') return;
    this.equipmentEditor.exit();
    this.equipCatalogue.hide();
    this.mode = 'edit';
    this.controls.enabled = true;
    this.walk.enabled = true;
    this.doc.body.classList.remove('equip-mode');
    if (this._savedEditorCam) {
      const cam = this.renderer.camera;
      const c = this._savedEditorCam;
      cam.position.set(c.x, c.y, c.z);
      cam.rotation.set(c.pitch, c.yaw, 0, 'YXZ');
      this.controls.yaw = c.yaw;
      this.controls.pitch = c.pitch;
      this._savedEditorCam = null;
    }
    if (this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    this.ui.toast('Back to world editor', 1200);
  }

  /** Feet-cell to spawn the player at: the world spawn, else the world-center
   *  column top, nudged up until the standing AABB fits. */
  _testSpawnCell() {
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

  /** Replace world contents with another world's (one shared copy path —
   *  World.copyFrom — so rotation/decals/items always survive), then reload. */
  replaceWorldVoxels(loaded) {
    this.history.clear();
    this.world.copyFrom(loaded);
    // The map may have registered text sign decals during deserialization —
    // fold their runtime tiles into the atlas before chunks are meshed.
    this.rebuildAtlas();
    this._refreshDecalItems();
    this.renderer.clearChunks();
    this.renderer.loadWorldBounds();
    this.itemRenderer.rebuildAll();
    this._refreshItemLights();
    if (!this.frameToSpawn()) this.renderer.frameCamera();
  }

  /** Aim the camera at the spawn point. @returns {boolean} true when framed */
  frameToSpawn() {
    const s = this.world.spawn;
    if (!s) return false;
    const cam = this.renderer.camera;
    const x = s[0] * CELL_SIZE + CELL_SIZE / 2;
    const y = s[1] * CELL_SIZE + CELL_SIZE / 2;
    const z = s[2] * CELL_SIZE + CELL_SIZE / 2;
    cam.position.set(x + 1.5, y + 2, z + 1.5);
    cam.lookAt(x, y, z);
    return true;
  }

  /** Rebuild chunk meshes + reframe the camera (after clear/load/seed). */
  reloadWorld() {
    this.renderer.clearChunks();
    this.renderer.loadWorldBounds();
    this.renderer.frameCamera();
  }

  seedGround() {
    const { groundSpan } = CONFIG;
    for (let x = 0; x < groundSpan * 2; x += 2) {
      for (let z = 0; z < groundSpan * 2; z += 2) {
        this.world.place('grass', SIZE.BIG, x, 0, z);
      }
    }
  }

  /** Adopt a parsed map. Only an unreadable file (`fatal`) is thrown away —
   *  per-entry skips (a decal that lost its face, a block id this build no
   *  longer knows) leave the rest of the map intact, so a single stale entry
   *  must never cost the author their world. */
  _adoptRestored(label, { world: loaded, errors, fatal }) {
    if (fatal) {
      Notice.warn(`${label} could not be read (${errors[0]}) — starting fresh`);
      return false;
    }
    this.replaceWorldVoxels(loaded);
    if (errors.length) Notice.warn(`${label} loaded — skipped ${errors.length} stale entry(s)`);
    return true;
  }

  async restore() {
    // 1. Author's in-progress browser save wins (fast, offline, works from file://).
    const saved = this.persistence.readSaved();
    if (saved) {
      this._adoptRestored('Saved map', this.persistence.parse(saved));
    } else {
      // 2. Next, the world file on disk (served by server.mjs), so edits the
      //    editor wrote to the repo are picked up by other machines/deploys.
      const serverText = await this.persistence.readServerWorld();
      if (serverText) {
        // The bundle registered its objects; make them placeable.
        if (this._adoptRestored('Server map', this.persistence.parse(serverText))) {
          this._refreshInventoryObjects();
        }
      } else {
        // 3. Finally, the world baked into the build for deployed visitors.
        const bundled = this.persistence.loadBundled();
        if (bundled.world) this._adoptRestored('Bundled map', bundled);
      }
    }
    if (this.world.count === 0) this.seedGround();
    this.reloadWorld();
  }

  // --- lifecycle ---

  async start() {
    this._wireInput();
    this._onResize = () => this.renderer.resize(window.innerWidth, window.innerHeight);
    window.addEventListener('resize', this._onResize);
    this._onResize();

    await this.restore();

    this.loop = new GameLoop({ onFrame: (dt) => this._frame(dt) });
    this.loop.start();
    this.controls.connect();
    this.walk.connect();
    this.input.connect();
    return this;
  }

  dispose() {
    this.loop?.stop();
    this.controls.disconnect();
    this.walk.disconnect();
    this.input.disconnect();
    window.removeEventListener('resize', this._onResize);
    for (const unsub of this._unsubs.splice(0)) unsub();
  }

  // --- internals ---

  _wireInput() {
    const on = this.input.on.bind(this.input);
    const sub = (action, fn) => this._unsubs.push(on(action, fn));
    const editorOnly = (fn) => (...args) => {
      if (this.mode !== 'edit') return;
      fn(...args);
    };

    sub('keydown', ({ code, event }) => {
      if (code === 'Tab' && this.mode === 'edit') {
        event.preventDefault();
        if (!event.repeat) this.toolRing.show(this.toolIndex);
      }
      if (this.mode === 'item') this.itemEditor.onKeyDown(code, event);
      else if (this.mode === 'equip') this.equipmentEditor.onKeyDown(code, event);
      else if (this.mode === 'test') this.walk.onKeyDown(code);
      else if (this.mode === 'edit') this.controls.onKeyDown(code);
    });
    sub('keyup', ({ code }) => {
      if (code === 'Tab' && this.mode === 'edit') this._closeToolRing();
      if (this.mode === 'test') this.walk.onKeyUp(code);
      else if (this.mode === 'edit') this.controls.onKeyUp(code);
    });
    sub('mousemove', ({ dx, dy, x, y }) => {
      if (this.mode === 'item') this.itemEditor.onMouseMove({ dx, dy, x, y });
      else if (this.mode === 'equip') this.equipmentEditor.onMouseMove({ dx, dy, x, y });
      else if (this.mode === 'test') this.walk.onMouseMove(dx, dy);
      else if (this.toolRing.open) this.toolRing.move(dx, dy);
      else this.controls.onMouseMove(dx, dy);
    });
    sub('wheel', ({ deltaY }) => {
      if (this.mode === 'item') this.itemEditor.onWheel({ deltaY });
      else if (this.mode === 'equip') this.equipmentEditor.onWheel({ deltaY });
      else if (this.mode === 'edit') this.ui.setSpeed(this.controls.onWheel(deltaY));
    });
    sub('mousedown', ({ button, x, y, shiftKey }) => {
      if (this.mode === 'item') {
        this.itemEditor.onMouseDown({ button, x, y, shiftKey });
        return;
      }
      if (this.mode === 'equip') {
        this.equipmentEditor.onMouseDown({ button, x, y, shiftKey });
        return;
      }
      if (this.toolRing.open) return;
      // Tools only edit in the world editor — test run is walk-only.
      if (this.mode !== 'edit') return;
      if (!this.controls.locked) return;
      // A pending F4 "Select spawn" swallows the next click (LMB picks, RMB
      // cancels) and reopens the quest panel.
      if (this._questSpawnPick) {
        this._finishQuestSpawnPick(button);
        return;
      }
      if (button === 1) {
        // Middle-click: pick the block/item under the crosshair.
        this.pickBlock();
        return;
      }
      // Clicking a splash-cam gizmo edits the shot's motion instead of the world.
      if (button === 0 && this._clickSplashCam()) return;
      this.tools.active?.onMouseDown(button);
    });
    sub('mouseup', ({ button, x, y }) => {
      if (this.mode === 'item') {
        this.itemEditor.onMouseUp({ button, x, y });
        return;
      }
      if (this.mode === 'equip') {
        this.equipmentEditor.onMouseUp({ button, x, y });
        return;
      }
      if (this.toolRing.open) return;
      // Test run must not edit; only the world editor places/removes.
      if (this.mode !== 'edit') return;
      if (this.controls.locked) this.tools.active?.onMouseUp(button);
    });

    for (let i = 0; i < 10; i++) {
      sub(`select.${i}`, editorOnly(() => {
          if (this.inventory.isOpen) {
            // Assign the hovered block/object/item to this hotbar slot.
            const h = this.inventory.hovered;
            if (!h) return;
            const entry = h.kind === 'item' ? this._objectEntry(h.id)
              : h.kind === 'equip' ? this._equipEntry(h.id)
              : h.kind === 'decal' ? this._decalEntry(h.id)
              : this._blockEntry(h.id);
            if (entry && this.toolbar.assign(i, entry)) {
              this.ui.toast(`Slot ${Toolbar.keyFor(i)}: ${entry.name}`, 900);
            }
          } else {
            this.toolbar.toggle(i);
          }
      }));
    }
    sub('size.toggle', editorOnly(() => {
      const s = this.tool.toggleSize();
      this.ui.setSelection(this.state.get('blockId'), s);
      this.ui.toast(`Voxel size: ${s}`, 700);
    }));
    sub('variant.cycle', editorOnly(() => {
      // V cycles the pending block's slab variant: full -> lower -> upper.
      // Only cube-shaped blocks come in halves (panes and doors don't).
      const id = this.state.get('blockId');
      if (!id || (getBlock(id)?.shape ?? 'cube') !== 'cube') return;
      const order = [null, 'lower', 'upper'];
      const next = order[(order.indexOf(this.state.get('blockVariant') ?? null) + 1) % order.length];
      this.state.set('blockVariant', next);
      const label = next === 'lower' ? 'lower half' : next === 'upper' ? 'upper half' : 'full block';
      this.ui.toast(`Block variant: ${label}`, 700);
    }));
    sub('item.rotate', editorOnly(() => {
      // With the Spawn tool, R rotates the player's facing at the spawn point.
      if (this.tools.active?.id === 'spawn' && this.world.spawn) {
        this.world.spawnYaw = ((this.world.spawnYaw ?? 0) + 90) % 360;
        this.ui.toast(`Spawn direction: ${this.world.spawnYaw}°`, 700);
        return;
      }
      // Decal in hand: R spins it on its face in quarter turns.
      if (this.state.get('decalId')) {
        const rot = ((this.state.get('decalRotation') ?? 0) + 1) % 4;
        this.state.set('decalRotation', rot);
        this.ui.toast(`Decal rotation: ${rot * 90}°`, 700);
        return;
      }
      if (this.state.get('itemId')) {
        const rot = (this.state.get('itemRotation') + 90) % 360;
        this.state.set('itemRotation', rot);
        this.ui.toast(`Rotation: ${rot}°`, 700);
        return;
      }
      // Block in hand: R spins the pending voxel's textures in quarter
      // turns (rotate a road line, a crack, wood grain...).
      if (this.state.get('blockId')) {
        const rot = ((this.state.get('blockRotation') ?? 0) + 1) % 4;
        this.state.set('blockRotation', rot);
        this.ui.toast(`Block rotation: ${rot * 90}°`, 700);
      }
    }));
    sub('inventory.toggle', () => {
      // E is the interact key in a test run (doors), the inventory in the editor.
      if (this.mode === 'test') {
        this._testInteract();
        return;
      }
      if (this.mode !== 'edit') return;
      const opened = this.inventory.toggle();
      // Free the mouse so the player can click a block in the grid.
      if (opened && document.pointerLockElement === this.webgl.domElement) document.exitPointerLock();
    });
    sub('mob.cycle', editorOnly(() => {
      // G cycles the active spawn tool's type — mobs and NPCs alike.
      if (this.tools.active?.id === 'mob' || this.tools.active?.id === 'npc') this.tools.active.cycleType();
    }));
    sub('postfx.toggle', () => this.togglePostFX());
    sub('help.toggle', editorOnly(() => {
      const shown = this.ui.toggleHelp();
      if (shown && document.pointerLockElement === this.webgl.domElement) document.exitPointerLock();
    }));
    sub('save', editorOnly(() => this.save()));
    sub('undo', editorOnly(() => this.undo()));
    sub('redo', editorOnly(() => this.redo()));
    sub('item.toggle', () => this.toggleItemEditor());
    sub('equip.toggle', () => this.toggleEquipEditor());
    sub('npc.toggle', () => {
      // F4: modal overlay, only from the world editor (not F2/F3/test modes).
      if (this.mode !== 'edit') return;
      const opened = this.npcQuestEditor.toggle();
      if (opened && document.pointerLockElement === this.webgl.domElement) document.exitPointerLock();
    });
    sub('test.toggle', () => {
      if (this.mode !== 'item' && this.mode !== 'equip') this.toggleTestMode();
    });
    sub('splash.capture', editorOnly(() => this.captureSplashCam()));
    sub('splash.delete', editorOnly(() => this.deleteNearestSplashCam()));
  }

  /** Index of the active tool in the registry (for the tool ring). */
  get toolIndex() {
    const ids = this.tools.list().map((t) => t.id);
    return Math.max(0, ids.indexOf(this.tools.active?.id));
  }

  _closeToolRing() {
    if (!this.toolRing.open) return;
    const moved = this.toolRing.wasMoved;
    const index = this.toolRing.selectedIndex;
    this.toolRing.close();
    const t = moved
      ? this.tools.list()[index]
      : this.tools.cycle(); // tap -> keep the old "cycle" behaviour
    if (t) {
      this.tools.activate(t.id);
      if (t.id !== 'item') this.state.set('itemId', null);
      if (t.id !== 'decal') this.state.set('decalId', null);
      this.ui.setTool(t.name);
      this.ui.toast(`Tool: ${t.name}`, 700);
    }
  }

  _frame(dt) {
    if (this.mode === 'edit') {
      if (this._wasLocked && !this.controls.locked) {
        if (this.toolRing.open) this.toolRing.close();
        this.tools.active?.cancel?.();
      }
      this.controls.update(dt);
      this.tools.active?.update(dt);
      this.spawnMarker.update();
      this.mobMarker.update();
      this.npcMarker.update();
      this.splashCamMarker.update();
    } else if (this.mode === 'test') {
      this.walk.update(dt);
      this._updateTestPrompt();
    }
    // Blinking lights strobe in the editor too; the periodic rescan picks up
    // newly placed/removed lamps without an explicit hook.
    if (this.mode === 'edit' || this.mode === 'test') this.blinkers.update(dt, 1);
    if (this.mode === 'item') {
      this.itemEditor.update(dt);
    } else if (this.mode === 'equip') {
      this.equipmentEditor.update(dt);
    }
    this.itemRenderer.update();
    this._wasLocked = this.controls.locked;
    // The item/equipment editors render their own dedicated scene (clean floor
    // + axes, no day/night cycle), so hand it to the renderer directly.
    const editorScene =
      this.mode === 'item' ? this.itemEditor.scene
      : this.mode === 'equip' ? this.equipmentEditor.scene
      : undefined;
    this.renderer.render(dt, editorScene);

    this._fpsEma = this._fpsEma ?? 60;
    this._fpsTimer = this._fpsTimer ?? 0;
    this._fpsEma += (1 / dt - this._fpsEma) * 0.05;
    this._fpsTimer += dt;
    if (this._fpsTimer > 0.4) {
      this._fpsTimer = 0;
      this.ui.setFps(this._fpsEma);
      const p = this.renderer.camera.position;
      this.ui.setPosition(p.x, p.y, p.z);
    }
  }

  /** Debug/test handle. Keeps the stable surface the e2e suite relies on. */
  get debugHandle() {
    const handle = {
      app: this,
      world: this.world,
      renderer: this.renderer,
      tool: this.tool,
      controls: this.controls,
      walk: this.walk,
      ui: this.ui,
      toolbar: this.toolbar,
      inventory: this.inventory,
      state: this.state,
      history: this.history,
      tools: this.tools,
      input: this.input,
      spawnMarker: this.spawnMarker,
      mobMarker: this.mobMarker,
      npcMarker: this.npcMarker,
      npcQuestEditor: this.npcQuestEditor,
      toolRing: this.toolRing,
      itemEditor: this.itemEditor,
      itemRenderer: this.itemRenderer,
      catalogue: this.catalogue,
      equipmentEditor: this.equipmentEditor,
      equipCatalogue: this.equipCatalogue,
    };
    // live accessor: main.js snapshots this object once, but mode changes
    // at runtime, so expose it as a getter rather than a frozen primitive.
    Object.defineProperty(handle, 'mode', { enumerable: true, get: () => this.mode });
    return handle;
  }
}
