// App.js — composition root: wires engine + editor together.
//
// Owns construction, input dispatch, persistence, restore, and the game loop.
// Replaces the old monolithic main.js `boot()` while keeping a stable
// debug/test handle (window.__voxelgame) with the fields the e2e suite uses.

import * as THREE from '../vendor/three.module.js';
import { World } from './engine/World.js';
import { Renderer } from './engine/Renderer.js';
import { CELL_SIZE } from './engine/Space.js';
import { listBlockIds, getBlock, SIZE, listDecalIds, getDecal, isPassable, unregisterDecal } from './engine/VoxelTypes.js';
import { getItem, listItems, registerItem, removeItem, isItemId } from './engine/ItemRegistry.js';
import {
  getEquipItem,
  listEquipItems,
  registerEquipItem,
  removeEquipItem,
  isEquipId,
  deserializeEquipItem,
} from './engine/EquipmentRegistry.js';
import { MICRO_SIZE, gridOf, lightLevelForMeters, slugifyName, deserializeItem, rotateMicroPoint } from './engine/ItemTypes.js';
import { objectToEquip, equipToObject } from './engine/itemConvert.js';
import { createAtlasTexture } from './textures/AtlasTexture.three.js';
import { unregisterRuntimeTile } from './textures/TextureAtlas.js';
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
import { CubeDeleteTool } from './editor/tools/CubeDeleteTool.js';
import { SpawnTool } from './editor/tools/SpawnTool.js';
import { MobTool } from './editor/tools/MobTool.js';
import { NpcTool } from './editor/tools/NpcTool.js';
import { NpcPalette } from './editor/NpcPalette.js';
import { NpcSpriteMarker } from './editor/NpcSpriteMarker.js';
import { NpcQuestEditor } from './editor/npc/NpcQuestEditor.js';
import { QuestAreaMarker } from './editor/QuestAreaMarker.js';
import { registerBuiltinQuestItems } from './engine/QuestItems.js';
import { registerBuiltinMaterials } from './engine/Materials.js';
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
import {
  isDoorVoxel, isOpenDoor, toggleDoor, canToggle,
  isDoorLocked, doorHinge, doorSwing, setDoorLocked, setDoorOpening,
} from './engine/Doors.js';
import { DoorMarker } from './editor/DoorMarker.js';
import { DoorModal } from './editor/DoorModal.js';
import { isLightVoxel, lightBaseDef, lightMode, setLightMode, syncLightType } from './engine/Lights.js';
import { isSwitchDecal, isSwitchOn, flipSwitch, setSwitchArt, seedSwitchFlags, faceFromNormal } from './engine/Switches.js';
import { GameFlags, bindWorldReactions } from './game/Reactions.js';
import { LightModal } from './editor/LightModal.js';
import { SwitchModal } from './editor/SwitchModal.js';
import { MobModal } from './editor/MobModal.js';
import { ObjectModal } from './editor/ObjectModal.js';
import { getMob } from './engine/mobTypes.js';
import { InputDispatcher } from './editor/Input.js';
import { ToolRing } from './editor/ToolRing.js';
import { Notice, onNotice } from './editor/Notice.js';
import { SignModal } from './editor/SignModal.js';
import { DecalEditor } from './editor/DecalEditor.js';
import { DecalCatalogue } from './editor/items/DecalCatalogue.js';
import { WorldBrowser } from './editor/WorldBrowser.js';
import { PrefabTool } from './editor/tools/PrefabTool.js';
import { PaintTool } from './editor/tools/PaintTool.js';
import { PrefabResizeTool } from './editor/tools/PrefabResizeTool.js';
import { contentBounds, resizeLimits, resizePlan, faceLabel } from './editor/prefabResize.js';
import { prefabResizeCommand } from './editor/commands.js';
import { PrefabBrowser } from './editor/PrefabBrowser.js';
import { PrefabPanel } from './editor/PrefabPanel.js';
import { PrefabBounds } from './editor/PrefabBounds.js';
import { PrefabLibrary } from './PrefabLibrary.js';
import { serializePrefab, deserializePrefab, slugifyPrefabName, normalizePrefabDims } from './persistence/PrefabSerializer.js';
import { stampPrefab, flipPlacement } from './engine/PrefabStamp.js';
import { SplashCamMarker } from './editor/SplashCamMarker.js';
import { SplashMotionModal, SPLASH_MOTIONS } from './editor/SplashMotionModal.js';
import { createTextDecal } from './engine/TextDecals.js';
import { createPixelDecal } from './engine/PixelDecals.js';
import { GameLoop } from './GameLoop.js';
import { PersistenceService } from './PersistenceService.js';
import { CONFIG } from './config.js';

/** Idle delay before a dirty world autosaves to map/voxelbundle.json. */
const AUTOSAVE_DELAY_MS = 1500;

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
    const { texture, tileIndexFor, atlas, rebuild, tiles } = createAtlasTexture(THREE);
    this.rebuildAtlas = rebuild;
    this.renderer = new Renderer({ THREE, webgl: this.webgl, world: this.world, atlasTexture: texture, tileIndexFor, atlas, tiles });

    // --- editor state / history ---
    this.state = new EditorState({
      blockId: 'grass', size: SIZE.SMALL, itemId: null, itemRotation: 0,
      blockRotation: 0, decalId: null, decalRotation: 0,
      prefabId: null, prefabRotation: 0, prefabMirror: false,
    });
    this.history = new History({
      max: CONFIG.history.max,
      onChange: () => {
        this._markDirty();
        this._syncHistoryUI();
      },
    });

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
    // NPC spawns render as the actual character sprites (plus a green ring).
    this.npcMarker = new NpcSpriteMarker({ THREE, scene: this.renderer.scene, world: this.world });
    this.splashCamMarker = new SplashCamMarker({ THREE, scene: this.renderer.scene, world: this.world });
    // Plan-view arcs showing how each door swings (and whether it's locked).
    this.doorMarker = new DoorMarker({ THREE, scene: this.renderer.scene, world: this.world });

    // --- UI ---
    const items = listBlockIds()
      .filter((id) => !getBlock(id).hidden) // internal states (lights' dark phases)
      .map((id) => ({ id, name: getBlock(id).name }));
    const decalItems = listDecalIds()
      .filter((id) => !getDecal(id).hidden) // internal states (the switch's ON art)
      .map((id) => ({ id, name: getDecal(id).name }));
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

    // --- persistence (file driven — map/voxelbundle.json via server.mjs) ---
    this.persistence = new PersistenceService({ world: this.world, notice: Notice });
    this._dirty = false;
    this._autosaveTimer = null;
    // Leaving the tab flushes a pending autosave so closing/reloading the
    // editor never costs more than the debounce window of work.
    this._onVisibility = () => {
      if (this.doc.visibilityState === 'hidden') this._flushAutosave();
    };
    this.doc.addEventListener('visibilitychange', this._onVisibility);

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
        onConvert: (id) => this._objectToEquip(id),
        onDelete: (id) => this._deleteItem(id),
        onImport: (text) => this._importItem(text),
      },
    });
    this.catalogue.onClose = () => {
      // A catalogue transfer hands off to the sibling modal — don't grab the
      // pointer back while that one is on screen.
      if (this.equipCatalogue?.isOpen) return;
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
        saveState: (state) => this.persistence.writeEditorState(state),
      },
    });
    this.worldBrowser.onClose = () => {
      if (this.mode === 'edit' && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };

    // --- prefab library & editor (F6: build once, stamp anywhere) ---
    this.prefabs = new PrefabLibrary({ persistence: this.persistence });
    this.prefabBrowser = new PrefabBrowser({
      doc,
      container: this.doc.querySelector('#prefab-browser'),
      library: this.prefabs,
      callbacks: {
        onCard: (id) => this._placePrefab(id),
        onEdit: (id) => this._editPrefab(id),
        onExport: (id) => this._exportPrefab(id),
        onDelete: (id) => this._deletePrefab(id),
        onImport: (text) => this._importPrefab(text),
        onNew: () => this.enterPrefabEditor(),
      },
    });
    this.prefabBrowser.onClose = () => {
      if (this.mode === 'edit' && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };
    this.prefabPanel = new PrefabPanel({
      doc,
      container: this.doc.querySelector('#prefab-panel'),
      callbacks: {
        onName: (name) => {
          if (!this.prefabSession) return;
          this.prefabSession.name = name;
          this.prefabSession.dirty = true;
          this.prefabPanel.setDirty(true);
        },
        onDims: (dims) => this._setPrefabDims(dims),
        onPaste: () => this.openPrefabBrowser(),
        onSave: () => this.savePrefab(),
        onExit: (force) => this._requestPrefabExit(force),
      },
    });
    /** Active prefab-editing session ({id, name, dims, dirty}), or null. */
    this.prefabSession = null;
    this._prefabStash = null;
    this._prefabBounds = new PrefabBounds({ THREE, scene: this.renderer.scene });

    // Clicking a splash-cam gizmo opens this picker for the shot's menu motion.
    this.splashMotionModal = new SplashMotionModal({ doc, container: this.doc.querySelector('#splash-motion') });
    this.splashMotionModal.onClose = () => {
      if (this.mode === 'edit' && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };

    // Clicking a door opens its lock / opening-direction settings.
    this.doorModal = new DoorModal({ doc, container: this.doc.querySelector('#door-settings') });
    this.doorModal.onClose = () => {
      if (this.mode === 'edit' && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };

    // Clicking a light opens its state (on/off/flicker + power flag) settings.
    this.lightModal = new LightModal({ doc, container: this.doc.querySelector('#light-settings') });
    this.lightModal.onClose = this.doorModal.onClose;

    // Clicking a wall switch opens its flag wiring.
    this.switchModal = new SwitchModal({ doc, container: this.doc.querySelector('#switch-settings') });
    this.switchModal.onClose = this.doorModal.onClose;

    // Clicking a mob spawn beacon opens its loot pool / respawn timer settings.
    this.mobModal = new MobModal({ doc, container: this.doc.querySelector('#mob-settings') });
    this.mobModal.onClose = this.doorModal.onClose;

    // Clicking a placed object opens its search-loot settings.
    this.objectModal = new ObjectModal({ doc, container: this.doc.querySelector('#object-settings') });
    this.objectModal.onClose = this.doorModal.onClose;
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
        onConvert: (id) => this._equipToObject(id),
        onDelete: (id) => this._deleteEquipItem(id),
        onImport: (text) => this._importEquipItem(text),
      },
    });
    this.equipCatalogue.onClose = () => {
      if (this.mode === 'equip') return; // stays inside the F3 editor
      if (this.catalogue.isOpen) return; // handing off to the object catalogue
      if (this.mode === 'edit' && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };

    // --- NPC & quest editor (F4) ---
    this.npcQuestEditor = new NpcQuestEditor({
      doc,
      onChange: () => {
        this._markDirty();
        // Keep the NPC tool's palette current while F4 authors/reskins NPCs.
        if (this.npcPalette.isOpen) this.npcPalette.refresh();
      },
    });
    this.npcQuestEditor.onClose = () => {
      if (this.mode === 'edit' && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };
    this.npcQuestEditor.onPickSpawn = (cb) => this._beginQuestSpawnPick(cb);
    this._questSpawnPick = null; // pending "Select spawn" receiver, or null
    this.npcQuestEditor.onPickArea = (cells, cb) => this._beginQuestAreaPick(cells, cb);
    this._questAreaPick = null; // pending "Mark area" session {cells, cb}, or null
    this._questAreaMarker = null; // yellow top-face overlay, built on first use

    // --- NPC palette (shown while the NPC tool is active) ---
    this.npcPalette = new NpcPalette({
      doc,
      container: this.doc.querySelector('#npc-palette'),
      onPick: (id) => this.tools.get('npc')?.setType(id),
    });

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
      // A freshly placed wall switch opens its wiring right away — an
      // unwired switch clicks but drives nothing, which reads as a bug.
      onSwitchPlaced: (decal) => this._openSwitchModal(decal),
      atlasTexture: texture,
      tileIndexFor,
      atlas,
      prefabs: this.prefabs,
      npcPalette: this.npcPalette,
      viewport: () => ({ w: this.webgl.domElement.clientWidth || 1, h: this.webgl.domElement.clientHeight || 1 }),
      // The prefab session's build volume, for the Resize tool.
      prefab: {
        session: () => this.prefabSession,
        bounds: this._prefabBounds,
        resize: (spec) => this._resizePrefabVolume(spec),
        previewDims: (dims) => this.prefabPanel.setDims(dims),
      },
    };
    this.tools = new ToolRegistry();
    this.tools.register(new BuildTool(ctx));
    this.tools.register(new SquareTool(ctx));
    this.tools.register(new CubeDeleteTool(ctx));
    this.tools.register(new SpawnTool(ctx));
    this.tools.register(new MobTool(ctx));
    this.tools.register(new NpcTool(ctx));
    this.tools.register(new ItemTool(ctx));
    this.tools.register(new DecalTool(ctx));
    this.tools.register(new PaintTool(ctx));
    this.tools.register(new PrefabTool(ctx));
    this.tools.register(new PrefabResizeTool(ctx));
    // Volume-resize only makes sense on a prefab's own build box.
    this.tools.setAvailability((t) => !t.prefabOnly || !!this.prefabSession);
    this.tool = this.tools.get('build'); // back-compat alias (tests / debug)
    this.tools.activate('build');

    this.toolRing = new ToolRing({ doc });
    this._syncToolRing();

    // --- state -> UI sync ---
    this.state.on(({ field }) => {
      if (field === 'blockId') {
        this.state.set('itemId', null);
        this.state.set('decalId', null);
        if (this.state.get('blockId')) this.state.set('prefabId', null);
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
          this.state.set('prefabId', null);
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
          this.state.set('prefabId', null);
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
      if (field === 'prefabId') {
        const id = this.state.get('prefabId');
        if (id) {
          this.state.set('itemId', null);
          this.state.set('decalId', null);
          const p = this.prefabs.cached(id);
          this.toolbar.clearSelection();
          this.ui.setSelection(
            `Prefab: ${p?.name ?? id}`,
            p ? p.dims.map((d) => (d * CELL_SIZE).toFixed(1).replace(/\.0$/, '')).join('×') + ' m' : '',
          );
          this.tools.activate('prefab');
        } else if (this.tools.active?.id === 'prefab') {
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

    // --- drawn decals (2D pixel editor, from the Decals section) ---
    this.decalEditor = new DecalEditor({ doc });
    this.inventory.onCreateDecal = () => this.decalEditor.show();
    this.decalEditor.onCreate = (spec) => {
      const decal = createPixelDecal(spec);
      if (!decal) return;
      this.rebuildAtlas();
      this._refreshDecalItems();
      this.state.set('decalId', decal.id); // in hand, decal tool active
      Notice.info(`Decal ready — click a surface to place it`);
    };
    this.decalEditor.onClose = () => {
      if (this.mode === 'edit' && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };

    // --- decal catalogue (manage custom decals, from the Decals section) ---
    this.decalCatalogue = new DecalCatalogue({
      doc,
      container: this.doc.querySelector('#decal-catalogue'),
      world: this.world,
      callbacks: {
        onCard: (id) => {
          this.decalCatalogue.hide();
          this.state.set('decalId', id); // in hand, decal tool active
        },
        onDelete: (id) => this._deleteCustomDecal(id),
      },
    });
    this.inventory.onOpenDecalCatalogue = () => this.decalCatalogue.show();
    this.decalCatalogue.onClose = () => {
      if (this.mode === 'edit' && this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };
    // Closing the inventory (selection, E, or backdrop click) re-locks the
    // pointer so editing resumes right away.
    this.inventory.onClose = () => {
      if (this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    };

    // --- actions ---
    // Sidebar buttons and their keyboard shortcuts share these entry points,
    // so a click and the key can never drift apart.
    this.ui.cb = {
      save: () => this.save(),
      load: (text) => this.load(text),
      export: () => this.exportMap(),
      newWorld: () => this.newWorld(),
      undo: () => this.undo(),
      redo: () => this.redo(),
      items: () => this.openCatalogue(),
      worlds: () => this.toggleWorldBrowser(),
      prefabs: () => this.togglePrefabBrowser(),
      objects: () => this.toggleItemEditor(),
      equip: () => this.toggleEquipEditor(),
      npcs: () => this.toggleNpcEditor(),
      test: () => this.requestTestMode(),
      help: () => this.toggleHelp(),
    };

    // initial HUD state
    this.ui.setSelection(this.state.get('blockId'), this.state.get('size'));
    this.ui.setTool(this.tools.active.name);
    this._syncHistoryUI();
    // Item/equip/npc/quest registries restore together with the world file
    // in restore() — the bundle carries them all.
  }

  // --- actions ---

  /** Ctrl+S: write the world + objects to map/voxelbundle.json right now. */
  save() {
    return this._saveNow();
  }

  /** Mark the world dirty and schedule a debounced autosave. Every tool edit
   *  (via History.onChange) and every registry mutation lands here. While a
   *  prefab session is open the world holds the PREFAB's scratch volume — it
   *  must never autosave over the real world file; edits mark the session
   *  dirty instead. */
  _markDirty() {
    if (this.prefabSession) {
      this.prefabSession.dirty = true;
      this.prefabPanel.setDirty(true);
      this._updatePrefabCount();
      return;
    }
    this._dirty = true;
    if (this._autosaveTimer != null) return; // a save is already scheduled
    this._autosaveTimer = setTimeout(() => {
      this._autosaveTimer = null;
      this._autosave();
    }, AUTOSAVE_DELAY_MS);
  }

  async _autosave() {
    if (this.prefabSession) return; // scratch volume — never write the world file
    if (!this._dirty) return;
    const ok = await this.persistence.saveToServer({ silent: true });
    if (ok) this._dirty = false;
    else this._markDirty(); // server briefly unreachable — try again later
  }

  /** Cancel the timer and push a pending save immediately (tab hiding). */
  _flushAutosave() {
    if (this._autosaveTimer != null) {
      clearTimeout(this._autosaveTimer);
      this._autosaveTimer = null;
    }
    if (this.prefabSession) return; // the world file is stashed, nothing to flush
    if (this._dirty) this.persistence.saveToServer({ silent: true, keepalive: true });
    this._dirty = false;
  }

  /** Explicit save: PUT the bundle, tell the author where it went. */
  async _saveNow() {
    if (this._autosaveTimer != null) {
      clearTimeout(this._autosaveTimer);
      this._autosaveTimer = null;
    }
    const ok = await this.persistence.saveToServer();
    if (ok) {
      this._dirty = false;
    } else {
      this.ui.toast('Save failed — no server reachable. Use Export to download a copy.', 3600);
    }
    return ok;
  }

  load(text) {
    const { world: loaded, errors } = this.persistence.parse(text);
    this.replaceWorldVoxels(loaded);
    // A bundle registers its objects too; refresh the inventory/catalogue so
    // the objects the map references show up as placeable.
    this._refreshInventoryObjects();
    this._refreshInventoryEquip();
    this._markDirty(); // the working file must follow the loaded world
    this.ui.toast(errors.length ? `Loaded with ${errors.length} warning(s)` : 'Loaded map');
  }

  exportMap() {
    this.persistence.export();
  }

  openWorldBrowser() {
    if (this.prefabSession) {
      Notice.warn('Finish the prefab first — the world catalogue waits outside (F6)');
      return;
    }
    if (this.doc.exitPointerLock) this.doc.exitPointerLock();
    this.worldBrowser.show();
  }

  /** F7 / sidebar "Worlds…": the world catalogue, open or shut. */
  toggleWorldBrowser() {
    if (this.worldBrowser.isOpen) this.worldBrowser.hide();
    else this.openWorldBrowser();
  }

  /** Sidebar "New": throw the open world away and start on bare ground.
   *  The catalogue link goes with it, so the next save can't silently
   *  overwrite the world that was open. Item/equipment/NPC catalogues are
   *  kept — they are the author's toolbox, not part of this map. */
  newWorld() {
    if (this.prefabSession) {
      Notice.warn('Go back to the world first (F6) — "New" replaces the world');
      return;
    }
    this.clearWorld({ silent: true });
    this.seedGround();
    this.reloadWorld();
    this.worldBrowser.currentPath = null;
    this.ui.toast('New world');
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

  // --- prefab library & editor (F6) ---

  /** F6 / sidebar "Prefabs…": library in, library out — or back out of an
   *  open prefab-editing session. Inside a session the library can be open
   *  too (Shift+F6, to paste), and F6 then shuts it rather than ending the
   *  session — one step back per press. */
  togglePrefabBrowser() {
    if (this.prefabSession) {
      if (this.prefabBrowser.isOpen) this.prefabBrowser.hide();
      else this._requestPrefabExit();
      return;
    }
    if (this.mode !== 'edit') return;
    if (this.prefabBrowser.isOpen) this.prefabBrowser.hide();
    else this.openPrefabBrowser();
  }

  /** The library, open to pick something to stamp. Inside a prefab session it
   *  opens in paste mode: the pick lands in the build volume, so prefabs are
   *  built out of prefabs (a kiosk into a street, a street into a district). */
  openPrefabBrowser() {
    if (this.mode !== 'edit') return;
    if (this.doc.exitPointerLock) this.doc.exitPointerLock();
    this.prefabBrowser.setPasteMode(!!this.prefabSession);
    this.prefabBrowser.show();
  }

  /** Card click: put the prefab in hand and arm the Prefab tool. In a session
   *  the very same hand stamps into the build volume. */
  _placePrefab(id) {
    const prefab = this.prefabs.cached(id);
    if (!prefab) return;
    this.prefabBrowser.hide();
    this.state.set('prefabRotation', 0);
    this.state.set('prefabMirror', false);
    this.state.set('prefabId', id);
    const where = this.prefabSession ? 'Pasting into the prefab' : 'Placing';
    this.ui.toast(`${where}: ${prefab.name} — LMB stamps · R rotates · F / Shift+F flips · RMB puts away`, 2600);
  }

  _editPrefab(id) {
    const prefab = this.prefabs.cached(id);
    if (!prefab) return;
    this.enterPrefabEditor({ prefab });
  }

  _exportPrefab(id) {
    const prefab = this.prefabs.cached(id);
    if (!prefab) return;
    this.persistence.downloadPrefab(prefab);
    this.ui.toast(`Exported ${prefab.id}.json`, 900);
  }

  async _deletePrefab(id) {
    const prefab = this.prefabs.cached(id);
    if (!(await this.prefabs.remove(id))) {
      this.ui.toast('Delete failed — is the server running?', 2000);
      return;
    }
    if (this.state.get('prefabId') === id) this.state.set('prefabId', null);
    this.prefabBrowser.refreshFromServer();
    this.ui.toast(`Deleted "${prefab?.name ?? id}" from the library`);
  }

  /** Import a prefab file into the library (handles id collisions). */
  async _importPrefab(text) {
    const { prefab, errors } = deserializePrefab(text);
    if (!prefab) {
      this.ui.toast(errors[0] ?? 'Import failed', 2400);
      return;
    }
    let id = prefab.id;
    if (await this.prefabs.load(id)) {
      const base = id;
      let n = 2;
      while (await this.prefabs.load(`${base}_${n}`)) n++;
      id = `${base}_${n}`;
    }
    prefab.id = id;
    if (await this.prefabs.save(prefab)) {
      this.prefabBrowser.refreshFromServer();
      this.ui.toast(`Imported "${prefab.name}"`);
    } else {
      this.ui.toast('Import failed — is the server running?', 2000);
    }
  }

  /**
   * Enter the prefab editor. The real world is stashed in memory (object
   * copy, no serialization) and the SAME world/renderer/tools edit a scratch
   * volume on a concrete baseplate — building a prefab feels exactly like
   * building in the world, at full chunk-renderer performance.
   */
  enterPrefabEditor({ prefab = null } = {}) {
    if (this.mode !== 'edit') return;
    if (this.prefabSession) {
      Notice.warn('Already editing a prefab — save or go back first (F6)');
      return;
    }
    this.prefabBrowser.hide();
    this.catalogue.hide();

    const stash = new World();
    stash.copyFrom(this.world);
    this._prefabStash = {
      world: stash,
      dirty: this._dirty,
      cam: {
        x: this.renderer.camera.position.x,
        y: this.renderer.camera.position.y,
        z: this.renderer.camera.position.z,
        yaw: this.controls.yaw,
        pitch: this.controls.pitch,
      },
    };
    if (this._autosaveTimer != null) {
      clearTimeout(this._autosaveTimer);
      this._autosaveTimer = null;
    }
    this.tools.active?.cancel?.();
    this.state.set('prefabId', null);
    this.state.set('itemId', null);
    this.state.set('decalId', null);
    this.history.clear();
    this._syncHistoryUI();
    this.world.clear();

    const dims = normalizePrefabDims(prefab?.dims ?? [16, 12, 16]);
    this.prefabSession = {
      id: prefab?.id ?? null,
      name: prefab?.name ?? 'New Prefab',
      dims,
      dirty: false,
    };
    if (prefab) stampPrefab(this.world, prefab, [0, 0, 0], 0);
    this._seedPrefabBaseplate();
    this.rebuildAtlas(); // the prefab may carry text signs
    this._refreshDecalItems();
    this.renderer.clearChunks();
    this.renderer.loadWorldBounds();
    this.itemRenderer.rebuildAll();
    this._refreshItemLights();
    this._prefabBounds.update(dims);
    this._framePrefabCamera();
    this._syncToolRing(); // the Resize tool joins the ring inside a session

    this.doc.body.classList.add('prefab-mode');
    this.prefabPanel.show({ name: this.prefabSession.name, dims });
    this._updatePrefabCount();
    this.ui.toast(
      prefab
        ? `Editing prefab "${prefab.name}" — F6 goes back to the world`
        : 'New prefab — build inside the cyan box · F6 goes back to the world',
      3000,
    );
  }

  /** Leave the session; asks about unsaved changes unless `force`. */
  _requestPrefabExit(force = false) {
    if (!this.prefabSession) return;
    if (this.prefabSession.dirty && !force) {
      if (this.doc.exitPointerLock) this.doc.exitPointerLock();
      this.prefabPanel.askExit();
      return;
    }
    this.exitPrefabEditor();
  }

  exitPrefabEditor() {
    if (!this.prefabSession) return;
    this.prefabSession = null;
    this.prefabPanel.hide();
    if (this.tools.active?.prefabOnly) this.tools.activate('build');
    this._syncToolRing();
    this._prefabBounds.dispose();
    this.doc.body.classList.remove('prefab-mode');
    this.state.set('prefabId', null);
    this.tools.active?.cancel?.();
    const stash = this._prefabStash;
    this._prefabStash = null;
    if (stash) {
      this.replaceWorldVoxels(stash.world);
      const cam = this.renderer.camera;
      const c = stash.cam;
      cam.position.set(c.x, c.y, c.z);
      cam.rotation.set(c.pitch, c.yaw, 0, 'YXZ');
      this.controls.yaw = c.yaw;
      this.controls.pitch = c.pitch;
      if (stash.dirty) this._markDirty();
    }
    if (this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
    this.ui.toast('Back to world editor', 1200);
  }

  /** Save the session's volume to the library (Ctrl+S inside the session). */
  async savePrefab() {
    const s = this.prefabSession;
    if (!s) return false;
    s.name = this.prefabPanel.name;
    const { prefab, outside } = serializePrefab(this.world, { id: s.id ?? 'prefab', name: s.name, dims: s.dims });
    if (!prefab) {
      Notice.warn(`${outside} element(s) stick out of the ${s.dims.join('×')} volume — grow the size or move them inside`);
      return false;
    }
    let spawns = 0;
    this.world.forEachMobSpawn(() => spawns++);
    this.world.forEachNpcSpawn(() => spawns++);
    if (spawns) Notice.warn(`${spawns} mob/NPC spawn(s) are not part of prefabs — they will not be saved`);
    if (!s.id) {
      let id = slugifyPrefabName(s.name);
      if (await this.prefabs.load(id)) {
        const base = id;
        let n = 2;
        while (await this.prefabs.load(`${base}_${n}`)) n++;
        id = `${base}_${n}`;
      }
      s.id = id;
      prefab.id = id;
    }
    prefab.thumb = this._capturePrefabThumb() ?? undefined;
    if (!(await this.prefabs.save(prefab))) {
      Notice.warn('Prefab save failed — no server reachable');
      return false;
    }
    s.dirty = false;
    this.prefabPanel.setDirty(false);
    Notice.info(`Saved "${s.name}" to the prefab library`);
    return true;
  }

  /**
   * Typed size change from the panel. Each axis moves the wall its side toggle
   * points at, so a number edit does exactly what grabbing that wall would;
   * shrinking still refuses while content sticks out.
   * @param {number[]} dims
   * @param {{axis?: number|null, side?: 'min'|'max'}} [opts]
   */
  _setPrefabDims(dims, { axis = null, side = 'max' } = {}) {
    const s = this.prefabSession;
    if (!s) return;
    const next = normalizePrefabDims(dims);
    if (next.join() === s.dims.join()) return;
    // One axis at a time (the panel's own edits); a whole-vector change walks
    // the axes, each from its own side.
    const axes = axis == null ? [0, 1, 2] : [axis];
    for (const a of axes) {
      const delta = next[a] - this.prefabSession.dims[a];
      if (!delta) continue;
      const from = axis == null ? this.prefabPanel.sideFor(a) : side;
      this._resizePrefabVolume({ axis: a, sign: from === 'min' ? -1 : 1, delta, clamp: false });
    }
    this.prefabPanel.setDims(this.prefabSession.dims);
  }

  /**
   * Move ONE wall of the build volume by `delta` cells (positive = outward).
   * Pulling a min wall also slides the content and the camera, so the build
   * stays where it is on screen and only the wall travels. Lands as one
   * history entry.
   * @param {{axis:number, sign:number, delta:number, clamp?:boolean}} spec
   *   clamp: drags stop at the limit; typed sizes refuse instead.
   * @returns {boolean} whether the volume changed
   */
  _resizePrefabVolume({ axis, sign, delta, clamp = true }) {
    const s = this.prefabSession;
    if (!s || !delta) return false;
    const limits = resizeLimits(s.dims, contentBounds(this.world), axis, sign);
    const d = Math.max(limits.min, Math.min(limits.max, Math.round(delta)));
    if (d !== delta && !clamp) {
      Notice.warn(`The ${faceLabel(axis, sign)} side stops at ${s.dims[axis] + limits.min} cells — content is in the way`);
      return false;
    }
    if (!d) return false;
    const prevDims = [...s.dims];
    const { dims, shift } = resizePlan(s.dims, axis, sign, d);
    const cmd = prefabResizeCommand(this.world, {
      dims,
      prevDims,
      shift,
      apply: (next, moved) => this._applyPrefabResize(next, moved),
    });
    cmd.do();
    this.history.push(cmd);
    this.ui.toast(`Build volume: ${dims.join(' × ')} cells (${faceLabel(axis, sign)})`, 900);
    return true;
  }

  /** Re-seat everything that hangs off the build volume after a resize. */
  _applyPrefabResize(dims, shift) {
    const s = this.prefabSession;
    if (!s) return;
    s.dims = [...dims];
    s.dirty = true;
    this.prefabPanel.setDims(dims);
    this.prefabPanel.setDirty(true);
    this._seedPrefabBaseplate();
    if (shift.some((n) => n !== 0)) {
      // The content moved as a block: rebuild the meshes wholesale and carry
      // the camera along so the build does not appear to jump.
      this.renderer.clearChunks();
      this.itemRenderer.rebuildAll();
      this._refreshItemLights();
      const cam = this.renderer.camera;
      cam.position.set(
        cam.position.x + shift[0] * CELL_SIZE,
        cam.position.y + shift[1] * CELL_SIZE,
        cam.position.z + shift[2] * CELL_SIZE,
      );
    }
    this.renderer.loadWorldBounds();
    this._prefabBounds.update(dims);
    this._updatePrefabCount();
  }

  /** Concrete workshop floor at y=-1, exactly under the build volume. It is
   *  scaffolding: serializePrefab ignores everything below y=0. */
  _seedPrefabBaseplate() {
    const stale = [];
    this.world.forEachVoxel((v) => {
      if (v.anchor[1] < 0) stale.push([...v.anchor]);
    });
    for (const [x, y, z] of stale) this.world.remove(x, y, z);
    const [W, , D] = this.prefabSession.dims;
    for (let x = 0; x < W; x++) {
      for (let z = 0; z < D; z++) this.world.place('concrete', SIZE.SMALL, x, -1, z);
    }
  }

  /** Frame the whole build volume from a friendly iso angle. */
  _framePrefabCamera() {
    const [W, H, D] = this.prefabSession.dims;
    const cx = (W * CELL_SIZE) / 2;
    const cz = (D * CELL_SIZE) / 2;
    const r = Math.max(W, D, H, 8) * CELL_SIZE;
    const cam = this.renderer.camera;
    cam.position.set(cx + r * 0.85, H * CELL_SIZE + r * 0.5, cz + r * 0.85);
    cam.lookAt(cx, (H * CELL_SIZE) * 0.25, cz);
    const e = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ');
    this.controls.yaw = e.y;
    this.controls.pitch = e.x;
    cam.rotation.set(e.x, e.y, 0, 'YXZ');
  }

  _updatePrefabCount() {
    if (!this.prefabSession) return;
    let blocks = 0;
    let items = 0;
    this.world.forEachVoxel((v) => {
      if (v.anchor[1] >= 0) blocks++;
    });
    this.world.forEachItem(() => items++);
    this.prefabPanel.setCount(blocks, items);
  }

  /** Downscaled screenshot for the library card. The camera hops to an iso
   *  view framing the CONTENT (not the whole build volume — a small kiosk in
   *  a big box would be a speck), renders one frame, captures, and hops back. */
  _capturePrefabThumb() {
    try {
      const cam = this.renderer.camera;
      const saved = { pos: cam.position.clone(), quat: cam.quaternion.clone() };

      // Content bounds (cells, y >= 0); the dims box stands in when empty.
      let b = null;
      this.world.forEachVoxel((v) => {
        const [x, y, z] = v.anchor;
        if (y < 0) return;
        if (!b) b = { min: [x, y, z], max: [x, y, z] };
        b.min = b.min.map((n, i) => Math.min(n, [x, y, z][i]));
        b.max = b.max.map((n, i) => Math.max(n, [x, y, z][i]));
      });
      if (!b) b = { min: [0, 0, 0], max: this.prefabSession.dims.map((d) => d - 1) };
      const center = b.min.map((n, i) => ((n + b.max[i] + 1) / 2) * CELL_SIZE);
      const extent = Math.max(...b.max.map((n, i) => n - b.min[i] + 1)) * CELL_SIZE;
      const r = extent * 1.15 + 1.5;
      cam.position.set(center[0] + r, center[1] + r * 0.75, center[2] + r);
      cam.lookAt(center[0], center[1], center[2]);

      this.renderer.render(0);
      const src = this.webgl.domElement;
      let thumb = null;
      if (src.width && src.height) {
        const w = 220;
        const h = Math.max(1, Math.round((w * src.height) / src.width));
        const c = this.doc.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(src, 0, 0, w, h);
        thumb = c.toDataURL('image/jpeg', 0.75);
      }

      cam.position.copy(saved.pos);
      cam.quaternion.copy(saved.quat);
      return thumb;
    } catch {
      return null;
    }
  }

  // --- splash cameras (F8: turn the current editor view into a menu shot) ---

  /** Capture the editor camera as a splash camera and, when the world lives
   *  in the library, register the shot in the menu's splash manifest. */
  async captureSplashCam() {
    if (this.prefabSession) {
      Notice.warn('Splash cameras live in worlds — go back first (F6)');
      return;
    }
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
    this._markDirty();
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
      this._markDirty();
      const label = SPLASH_MOTIONS.find((m) => m.id === motion)?.label ?? motion;
      this.ui.toast(`Splash motion: ${label}`, 1200);
      // The shot lives in the world — persist so the menu plays the new motion.
      const worldPath = this.worldBrowser.currentPath;
      if (worldPath) await this.persistence.saveWorld(worldPath);
    });
    return true;
  }

  /** LMB on a door: open its settings (lock + how it opens) instead of
   *  letting the tool edit. Shift+LMB skips this, so a tool can still work
   *  right at a doorway.
   *  @returns {boolean} true when a door was hit (the click is consumed) */
  _clickDoor() {
    const hit = itemAwarePick(this.world, THREE, this.renderer.camera, CONFIG.editor.doorClickCells);
    if (!hit) return false;
    const voxel = this.world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!isDoorVoxel(voxel)) return false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.doorModal.open({
      name: getBlock(voxel.type)?.name ?? '',
      locked: isDoorLocked(voxel),
      unlockFlag: voxel.unlockFlag ?? '',
      hinge: doorHinge(voxel),
      swing: doorSwing(voxel),
      alongX: ((voxel.rotation ?? 0) & 1) === 0,
    }, (change) => {
      let touched = false;
      if ('locked' in change) touched = setDoorLocked(voxel, change.locked) || touched;
      if ('unlockFlag' in change && change.unlockFlag !== (voxel.unlockFlag ?? '')) {
        if (change.unlockFlag) voxel.unlockFlag = change.unlockFlag;
        else delete voxel.unlockFlag;
        touched = true;
      }
      if ('hinge' in change || 'swing' in change) touched = setDoorOpening(this.world, voxel, change) || touched;
      if (!touched) return;
      this.doorMarker.refresh();
      this._markDirty();
    });
    return true;
  }

  /** LMB on a light block: open its state settings (on/off/flicker + power
   *  flag). Shift+LMB skips this, like doors.
   *  @returns {boolean} true when a light was hit (the click is consumed) */
  _clickLight() {
    const hit = itemAwarePick(this.world, THREE, this.renderer.camera, CONFIG.editor.doorClickCells);
    if (!hit) return false;
    const voxel = this.world.get(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!isLightVoxel(voxel)) return false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.lightModal.open({
      name: lightBaseDef(voxel.type)?.name ?? 'Light',
      mode: lightMode(voxel),
      flag: voxel.lightFlag ?? '',
    }, (change) => {
      let touched = false;
      if ('mode' in change) touched = setLightMode(this.world, voxel, change.mode) || touched;
      if ('flag' in change && change.flag !== (voxel.lightFlag ?? '')) {
        if (change.flag) voxel.lightFlag = change.flag;
        else delete voxel.lightFlag;
        touched = true;
      }
      if (touched) this._markDirty();
    });
    return true;
  }

  /** LMB on a wall-switch decal: open its flag wiring. The switch is a decal
   *  on the face the pick ray came in through.
   *  @returns {boolean} true when a switch was hit (the click is consumed) */
  _clickSwitch() {
    const hit = itemAwarePick(this.world, THREE, this.renderer.camera, CONFIG.editor.doorClickCells);
    if (!hit) return false;
    const face = faceFromNormal(hit.normal);
    const decal = face ? this.world.decalAt(hit.cell[0], hit.cell[1], hit.cell[2], face) : null;
    if (!isSwitchDecal(decal)) return false;
    this._openSwitchModal(decal);
    return true;
  }

  /** Open the wiring modal for a placed switch decal (clicked, or fresh off
   *  the decal tool). */
  _openSwitchModal(decal) {
    if (document.pointerLockElement) document.exitPointerLock();
    this.switchModal.open({ flag: decal.flag ?? '', startOn: !!decal.startOn }, (change) => {
      if ('flag' in change) {
        const flag = (change.flag ?? '').trim();
        if (flag === (decal.flag ?? '')) return;
        if (flag) decal.flag = flag;
        else delete decal.flag;
        this._markDirty();
      }
      if ('startOn' in change) {
        if (!!decal.startOn === !!change.startOn) return;
        if (change.startOn) decal.startOn = true;
        else delete decal.startOn;
        this._markDirty();
      }
    });
  }

  /** Mob spawn beacon under the crosshair, or null. Spawns live in air cells,
   *  so the block raycast can't find them — instead test each spawn's marker
   *  centre against the aim ray (perpendicular distance), capped at the door
   *  click range and at the first solid hit so beacons behind walls don't
   *  respond. */
  _spawnUnderCrosshair() {
    const cam = this.renderer.camera;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const solid = itemAwarePick(this.world, THREE, this.renderer.camera, CONFIG.editor.doorClickCells);
    const limit = solid ? solid.dist * CELL_SIZE : CONFIG.editor.doorClickCells * CELL_SIZE;
    let best = null;
    let bestT = Infinity;
    this.world.forEachMobSpawn((s) => {
      const cx = s.x * CELL_SIZE + CELL_SIZE / 2 - cam.position.x;
      const cy = s.y * CELL_SIZE + CELL_SIZE / 2 - cam.position.y;
      const cz = s.z * CELL_SIZE + CELL_SIZE / 2 - cam.position.z;
      const t = cx * dir.x + cy * dir.y + cz * dir.z; // along-ray distance
      if (t < 0 || t > limit || t > bestT) return;
      const px = cx - dir.x * t;
      const py = cy - dir.y * t;
      const pz = cz - dir.z * t;
      if (Math.hypot(px, py, pz) > CELL_SIZE * 0.9) return; // off the beacon
      best = s;
      bestT = t;
    });
    return best;
  }

  /** LMB on a mob spawn beacon: open its spawner settings (loot pool,
   *  respawn timer, character sprites). Changes land directly on the spawn
   *  record.
   *  @returns {boolean} true when a beacon was hit (the click is consumed) */
  _clickMobSpawn() {
    const spawn = this._spawnUnderCrosshair();
    if (!spawn) return false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.mobModal.open({
      typeName: getMob(spawn.type)?.name ?? spawn.type,
      loot: spawn.loot ? [...spawn.loot] : null,
      delay: spawn.delay ? [...spawn.delay] : null,
      skins: spawn.skins ? [...spawn.skins] : null,
    }, (change) => {
      if ('loot' in change) {
        if (change.loot) spawn.loot = [...change.loot];
        else delete spawn.loot;
        this._markDirty();
      }
      if ('delay' in change) {
        if (change.delay) spawn.delay = [...change.delay];
        else delete spawn.delay;
        this._markDirty();
      }
      if ('skins' in change) {
        if (change.skins?.length) spawn.skins = [...change.skins];
        else delete spawn.skins;
        this._markDirty();
      }
    });
    return true;
  }

  /** LMB on a placed object (F2 catalogue): open its search-loot settings —
   *  whether searching it grants loot, the pool, and the restock timer.
   *  Changes land directly on the placement record. Equip items stay out:
   *  they ARE loot, not containers.
   *  @returns {boolean} true when an object was hit (the click is consumed) */
  _clickObject() {
    if (this.prefabSession) return false;
    const hit = itemAwarePick(this.world, THREE, this.renderer.camera, CONFIG.editor.doorClickCells);
    if (!hit) return false;
    const item = this.world.itemAt(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!item || !isItemId(item.itemId)) return false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.objectModal.open({
      name: getItem(item.itemId)?.name ?? item.itemId,
      loot: item.loot ? { pool: item.loot.pool ? [...item.loot.pool] : null, reset: item.loot.reset ?? null } : null,
      storage: !!item.storage,
    }, (change) => {
      if ('loot' in change) {
        if (change.loot) item.loot = { pool: change.loot.pool ? [...change.loot.pool] : null, reset: change.loot.reset ?? null };
        else delete item.loot;
        this._markDirty();
      }
      if ('storage' in change) {
        if (change.storage) item.storage = true;
        else delete item.storage;
        this._markDirty();
      }
    });
    return true;
  }

  /** Remove the splash camera nearest to the editor view (Shift+F8). */
  async deleteNearestSplashCam() {
    if (this.prefabSession) return;
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
    this._markDirty();
    this.ui.toast('Splash camera removed', 1400);
    const manifest = await this.persistence.readSplash();
    if (manifest?.entries?.some((e) => e.cam === best.id)) {
      manifest.entries = manifest.entries.filter((e) => e.cam !== best.id);
      await this.persistence.writeSplash(manifest);
    }
    const worldPath = this.worldBrowser.currentPath;
    if (worldPath) await this.persistence.saveWorld(worldPath);
  }

  /** Empty the world in place. `silent` skips the toast for callers that
   *  report the larger action themselves (newWorld). */
  clearWorld({ silent = false } = {}) {
    this.world.clear();
    this.history.clear();
    this._syncHistoryUI();
    this.renderer.clearChunks();
    this.itemRenderer.clear();
    this._refreshItemLights();
    this._markDirty();
    if (!silent) this.ui.toast('World cleared');
  }

  undo() {
    const cmd = this.history.undo();
    if (cmd) this.ui.toast(`Undo: ${cmd.description}`, 700);
  }

  redo() {
    const cmd = this.history.redo();
    if (cmd) this.ui.toast(`Redo: ${cmd.description}`, 700);
  }

  /** Push the undo/redo timeline into the sidebar widget. */
  _syncHistoryUI() {
    this.ui.setHistory(this.history.timeline(), (delta) => this.jumpHistory(delta));
  }

  /** Timeline click: undo (delta < 0) or redo (delta > 0) that many steps. */
  jumpHistory(delta) {
    let last = null;
    for (let i = 0; i < Math.abs(delta); i++) {
      const cmd = delta < 0 ? this.history.undo() : this.history.redo();
      if (!cmd) break;
      last = cmd;
    }
    if (!last) return;
    const verb = delta < 0 ? 'Undo' : 'Redo';
    const n = Math.abs(delta);
    if (n === 1) {
      this.ui.toast(`${verb}: ${last.description}`, 900);
    } else {
      const { past } = this.history.timeline();
      const dest = past.length ? past[past.length - 1] : 'the original state';
      this.ui.toast(`${verb} ×${n} — now at: ${dest}`, 1400);
    }
  }

  /** F1 / sidebar "Help": the keyboard reference overlay. */
  toggleHelp() {
    if (this.mode !== 'edit') return;
    const shown = this.ui.toggleHelp();
    if (shown && document.pointerLockElement === this.webgl.domElement) document.exitPointerLock();
  }

  /** F4 / sidebar "NPCs & quests": modal overlay, world editor only. */
  toggleNpcEditor() {
    if (this.mode !== 'edit') return;
    const opened = this.npcQuestEditor.toggle();
    if (opened && document.pointerLockElement === this.webgl.domElement) document.exitPointerLock();
  }

  /** F5 / sidebar "Test run", with the mode guards the shortcut applies. */
  requestTestMode() {
    if (this.prefabSession) {
      Notice.warn('Go back to the world first (F6) — test runs happen there');
      return;
    }
    if (this.mode !== 'item' && this.mode !== 'equip') this.toggleTestMode();
  }

  /** Toggle the polaroid/bloom post pipeline at runtime (P). */
  togglePostFX() {
    const on = this.renderer.togglePostFX();
    this.ui.toast(`Polaroid filter: ${on ? 'on' : 'off'}`, 900);
  }

  /** Middle-click: aim the selection at the block or item under the crosshair.
   *  A mob spawn beacon copies the whole spawner instead — type plus its
   *  settings (loot pool, respawn timer) — into the mob tool. */
  pickBlock() {
    const spawn = this._spawnUnderCrosshair();
    if (spawn) {
      const mobTool = this.tools.get('mob');
      mobTool?.copyFrom(spawn);
      this.tools.activate('mob');
      const extras = [
        spawn.loot ? (spawn.loot.length ? `loot ×${spawn.loot.length}` : 'no loot') : 'default loot',
        spawn.delay ? `${spawn.delay[0]}–${spawn.delay[1]} s` : null,
      ].filter(Boolean).join(', ');
      this.ui.toast(`Copied spawner: ${getMob(spawn.type)?.name ?? spawn.type} (${extras})`, 1400);
      return;
    }
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
    // A light caught dark picks as its lit id, never the hidden phase.
    const id = getBlock(voxel.type)?.lightOn ?? voxel.type;
    this.state.set('blockId', id);
    this.state.set('size', voxel.size);
    this.state.set('blockRotation', voxel.rotation ?? 0);
    this.state.set('blockVariant', voxel.variant ?? null);
    this.ui.toast(`Picked: ${getBlock(id).name}`, 900);
  }

  // --- item registry / rendering ---

  _saveItem(item) {
    registerItem(item);
    this._markDirty();
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
    const decalItems = listDecalIds()
      .filter((id) => !getDecal(id).hidden)
      .map((id) => ({ id, name: getDecal(id).name }));
    this.inventory.updateDecalItems(buildDecalSwatchList(decalItems));
  }

  /** Remove a custom decal (drawn / text sign) from the registry, the
   *  inventory and the world. Placements are stripped first, so no saved
   *  map ends up referencing an unknown id. Built-in decals stay. */
  _deleteCustomDecal(id) {
    const decal = getDecal(id);
    if (!decal || (!decal.pixelSpec && !decal.textSpec)) return;
    const doomed = [];
    this.world.forEachDecal((d) => { if (d.decalId === id) doomed.push(d); });
    for (const d of doomed) this.world.removeDecal(d.cell[0], d.cell[1], d.cell[2], d.face);
    unregisterRuntimeTile(decal.tile);
    unregisterDecal(id);
    if (this.state.get('decalId') === id) this.state.set('decalId', null);
    if (doomed.length) this._markDirty();
    this.rebuildAtlas();
    this._refreshDecalItems();
    this.decalCatalogue.refresh();
    this.ui.toast(`Deleted "${decal.name}"${doomed.length ? ` (${doomed.length} placed)` : ''}`);
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
    this._markDirty();
    this.itemRenderer.rebuildAll();
    this._refreshInventoryObjects();
    this.catalogue.refresh();
    this._refreshItemLights();
    if (this.state.get('itemId') === id) this.state.set('itemId', null);
    this.ui.toast(`Deleted "${item.name}"${placed ? ` (${placed} placed)` : ''}`);
  }

  /** A registry id free in *both* catalogues — world placements look an id up
   *  in the object registry first and the equipment registry second, so the
   *  two share one id space. `preferred` (an imported file's id) is kept when
   *  it is free, otherwise the name is slugified and numbered. */
  _freeItemId(preferred, name) {
    const taken = (id) => isItemId(id) || isEquipId(id);
    if (preferred && !taken(preferred)) return preferred;
    const base = slugifyName(name ?? preferred ?? 'item');
    let id = base;
    let n = 2;
    while (taken(id)) id = `${base}_${n++}`;
    return id;
  }

  /** Catalogue transfer, object → equipment: copy a placeable object into the
   *  items catalogue as a pickable quest item (the sculpture carries over 1:1;
   *  kind, grip and stats are tuned afterwards in F3). The object stays put —
   *  this copies rather than moves. */
  _objectToEquip(id) {
    const src = getItem(id);
    if (!src) return;
    const { item, dropped, lightLost } = objectToEquip(src);
    item.id = this._freeItemId(null, src.name);
    registerEquipItem(item);
    this._markDirty();
    this._refreshInventoryEquip();
    // Show the result where it landed (open first, so closing this one does
    // not grab the pointer back mid-handoff).
    this.openEquipCatalogue();
    this.catalogue.hide();
    const notes = [];
    if (dropped) notes.push(`${dropped} voxels cropped to the 32-cell build volume`);
    if (lightLost) notes.push('light dropped (items carry no light)');
    this.ui.toast(
      `Copied "${item.name}" to the items catalogue as a quest item${notes.length ? ` — ${notes.join(', ')}` : ''}`,
      notes.length ? 3600 : 2600,
    );
  }

  /** Import an item file into the catalogue (handles id collisions). */
  _importItem(text) {
    const { item, errors } = deserializeItem(text);
    if (!item) {
      this.ui.toast(errors[0] ?? 'Import failed', 2400);
      return;
    }
    item.id = this._freeItemId(item.id, item.name);
    registerItem(item);
    this._markDirty();
    this.itemRenderer.rebuildAll();
    this._refreshInventoryObjects();
    this.catalogue.refresh();
    this.ui.toast(`Imported "${item.name}"`);
  }

  // --- equipment registry (F3 equippable items) ---

  /** Register + persist an equippable item saved from the F3 editor. */
  _saveEquipItem(item) {
    registerEquipItem(item);
    this._markDirty();
    this.equipCatalogue.refresh();
    this._refreshInventoryEquip();
    this.ui.toast(`Saved "${item.name}" to the items catalogue`);
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

  /** F4 "Mark area": close the quest panel and paint a visit objective's
   *  area on the world — LMB toggles the aimed voxel's top face in/out of the
   *  set (shown as a yellow translucent overlay), RMB finishes and hands the
   *  cell list back to the panel. */
  _beginQuestAreaPick(cells, cb) {
    this._questAreaPick = { cells: cells.map((c) => [...c]), cb };
    this._areaMarker().setCells(this._questAreaPick.cells);
    this.npcQuestEditor.close(); // onClose re-locks the pointer for aiming
    Notice.info('LMB toggles the aimed block’s top face in/out of the area — RMB finishes', 3200);
  }

  _areaMarker() {
    return this._questAreaMarker ??= new QuestAreaMarker({ THREE, scene: this.renderer.scene });
  }

  /** One click of the area paint mode (hooked into mousedown while active). */
  _stepQuestAreaPick(button) {
    const pick = this._questAreaPick;
    if (button === 0) {
      const origin = worldToCell(this.renderer.camera.position.toArray());
      const dir = this.renderer.camera.getWorldDirection(new THREE.Vector3());
      const hit = raycastVoxel(this.world, origin, [dir.x, dir.y, dir.z]);
      if (!hit) return;
      const [x, y, z] = hit.cell;
      const i = pick.cells.findIndex((c) => c[0] === x && c[1] === y && c[2] === z);
      if (i >= 0) pick.cells.splice(i, 1);
      else pick.cells.push([x, y, z]);
      this._areaMarker().setCells(pick.cells);
      return; // stay in paint mode
    }
    // Any other button finishes the session with what's painted so far.
    this._questAreaPick = null;
    this._areaMarker().clear();
    pick.cb(pick.cells);
    Notice.info(`Visit area: ${pick.cells.length} top face${pick.cells.length === 1 ? '' : 's'} marked`);
    if (document.pointerLockElement) document.exitPointerLock();
    this.npcQuestEditor.open();
  }

  /** Refresh the E inventory's Equippable Items section from the registry. */
  _refreshInventoryEquip() {
    this.inventory.updateEquipItems(
      listEquipItems().map((it) => ({ id: it.id, name: it.name, canvas: buildItemSwatch(it) })),
    );
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
    this._markDirty();
    this.itemRenderer.rebuildAll();
    this.equipCatalogue.refresh();
    this._refreshInventoryEquip();
    this._refreshItemLights();
    if (this.state.get('itemId') === id) this.state.set('itemId', null);
    this.ui.toast(`Deleted "${item.name}"${placed ? ` (${placed} placed)` : ''}`);
  }

  /** Catalogue transfer, equipment → object: copy an equippable item into the
   *  object catalogue as a placeable, blocking prop. The sculpture carries
   *  over 1:1 into the smallest whole-cell footprint that holds it; kind,
   *  grip, stats and the weapon/ammo/armor profile have no object equivalent
   *  and are dropped. The item stays put — this copies rather than moves. */
  _equipToObject(id) {
    const src = getEquipItem(id);
    if (!src) return;
    const { item } = equipToObject(src);
    item.id = this._freeItemId(null, src.name);
    registerItem(item);
    this._markDirty();
    this.itemRenderer.rebuildAll();
    this._refreshInventoryObjects();
    this.openCatalogue(); // shows the result where it landed (see _objectToEquip)
    this.equipCatalogue.hide();
    this.ui.toast(`Copied "${item.name}" to the object catalogue — F2 to adjust its shape or add a light`, 3000);
  }

  /** Import an equippable item file into the catalogue (handles id collisions). */
  _importEquipItem(text) {
    const { item, errors } = deserializeEquipItem(text);
    if (!item) {
      this.ui.toast(errors[0] ?? 'Import failed', 2400);
      return;
    }
    item.id = this._freeItemId(item.id, item.name);
    registerEquipItem(item);
    this._markDirty();
    this.equipCatalogue.refresh();
    this._refreshInventoryEquip();
    this.ui.toast(`Imported "${item.name}"`);
  }

  openEquipCatalogue() {
    this.equipCatalogue.refresh();
    this.equipCatalogue.show();
    if (document.pointerLockElement) document.exitPointerLock();
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
    this.doorMarker.setVisible(false);
    this.controls.keys.clear();
    this.controls.velocity.set(0, 0, 0);

    const cell = this._testSpawnCell();
    this.walk.spawnAt(cell[0], cell[1], cell[2], cam.rotation.y);

    this._openedDoors = new Set();
    this._testPrompt = null;
    this.ui.setPrompt(null);

    // Live signals for the playtest: a fresh flag store wired to the world's
    // reaction carriers, so flipping a switch really drives lights and door
    // locks. Door locks are snapshotted first — binding locks every
    // flag-gated door (its flag starts down) and the exit restore must put
    // back what the author had.
    this._testDoorLocks = new Map();
    this.world.forEachVoxel((v) => {
      if (isDoorVoxel(v) && v.unlockFlag) this._testDoorLocks.set(v, isDoorLocked(v));
    });
    this._testFlags = new GameFlags();
    seedSwitchFlags(this.world, this._testFlags);
    this._unbindTestReactions = bindWorldReactions(this.world, this._testFlags);

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
    // Unwind the test-run signals the same way: locks back to the authored
    // snapshot, lights back to their authored mode, switches back to OFF.
    this._unbindTestReactions?.();
    this._unbindTestReactions = null;
    this._testFlags = null;
    for (const [voxel, locked] of this._testDoorLocks ?? []) setDoorLocked(voxel, locked);
    this._testDoorLocks = null;
    this.world.forEachVoxel((v) => {
      if (!isLightVoxel(v)) return;
      delete v.lightPowered;
      syncLightType(this.world, v);
    });
    this.world.forEachDecal((d) => setSwitchArt(this.world, d, false));
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

  /** What E would act on under the crosshair in a test run: a door voxel
   *  ({door}), a wired wall switch ({switch}), or null. Mirrors the game's
   *  aim: the primary ray treats OPEN doors as air (their footprint fills
   *  the whole doorway and would otherwise swallow everything beyond it),
   *  so a second ray runs only when the first found nothing — that one hits
   *  the open leaf so it can be closed again. */
  _testPickTarget() {
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
      if (isDoorVoxel(voxel)) return { door: voxel };
      // A wall switch is a decal on the face the ray came in through.
      const face = faceFromNormal(hit.normal);
      const decal = face ? this.world.decalAt(hit.cell[0], hit.cell[1], hit.cell[2], face) : null;
      if (isSwitchDecal(decal)) return { switch: decal };
      // The first ray hit something solid that isn't interactive — the
      // open-door pass would only see through it.
      return null;
    }
    return null;
  }

  /** Per-frame while test-running: show/hide the "press E" prompt for whatever
   *  the crosshair is on. The DOM is touched only when the text changes. */
  _updateTestPrompt() {
    const target = this._testPickTarget();
    const text = !target ? null
      : target.switch ? `Press <kbd>E</kbd> to flip the switch ${isSwitchOn(target.switch) ? 'off' : 'on'}`
      : isDoorLocked(target.door) ? 'The door is locked'
      : `Press <kbd>E</kbd> to ${isOpenDoor(target.door) ? 'close' : 'open'} the door`;
    if (text === this._testPrompt) return;
    this._testPrompt = text;
    this.ui.setPrompt(text);
  }

  /** E in a test run: act on the aimed object (doors and wall switches). */
  _testInteract() {
    const target = this._testPickTarget();
    if (!target) return;
    if (target.switch) {
      // Flips the transient test-run flag store — bound lights and door
      // locks (and the rocker art) react live; exitTestMode unwinds it all.
      // An unwired switch still clicks its rocker.
      flipSwitch(this.world, this._testFlags, target.switch);
      this._updateTestPrompt();
      return;
    }
    if (!canToggle(target.door)) return;
    // Remembered so exitTestMode can undo it — a playtest leaves no trace.
    if (!toggleDoor(this.world, target.door)) return;
    if (this._openedDoors.has(target.door)) this._openedDoors.delete(target.door);
    else this._openedDoors.add(target.door);
    this._updateTestPrompt();
  }

  // --- item editor mode (F2) ---

  toggleItemEditor() {
    if (this.mode === 'edit') this.enterItemEditor();
    else if (this.mode === 'item') this.exitItemEditor();
  }

  enterItemEditor() {
    if (this.mode !== 'edit' || this.prefabSession) return;
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
    this.doorMarker.setVisible(false);
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
    if (this.mode !== 'edit' || this.prefabSession) return;
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
    this.doorMarker.setVisible(false);
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

  /** Feet-cell to spawn the player at: the editor camera's cell (so F5 drops
   *  the test run in right where the author was looking from), nudged up
   *  until the standing AABB fits. */
  _testSpawnCell() {
    const cam = this.renderer.camera;
    const cell = [
      Math.floor(cam.position.x / CELL_SIZE),
      Math.floor(cam.position.y / CELL_SIZE),
      Math.floor(cam.position.z / CELL_SIZE),
    ];
    let feet = this.walk.feetAt(cell[0], cell[1], cell[2]);
    while (!this.walk.canStand(feet[0], feet[1], feet[2])) {
      cell[1]++;
      feet = this.walk.feetAt(cell[0], cell[1], cell[2]);
    }
    return cell;
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
    // Built-in quest items and repair materials register first; an authored
    // def under the same id in the world file wins.
    registerBuiltinQuestItems();
    registerBuiltinMaterials();

    // File driven: the world file on disk (served by server.mjs) is the
    // single source of truth; the world baked into this build is the
    // fallback for a fresh checkout.
    const serverText = await this.persistence.readServerWorld();
    if (serverText) {
      // The bundle registers its objects; make them placeable.
      if (this._adoptRestored('World file', this.persistence.parse(serverText))) {
        this._refreshInventoryObjects();
        this._refreshInventoryEquip();
      }
    } else {
      const bundled = this.persistence.loadBundled();
      if (bundled.world && this._adoptRestored('Bundled map', bundled)) {
        this._refreshInventoryObjects();
        this._refreshInventoryEquip();
      }
      if (!this.persistence.serverAvailable) {
        Notice.warn('No server reachable — edits stay in memory; use Export to keep a copy');
      }
    }

    // Which library world is open survives reloads in map/editor.json.
    const editorState = await this.persistence.readEditorState();
    this.worldBrowser.adoptCurrentPath(editorState?.currentPath ?? null);

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
    this.doc.removeEventListener('visibilitychange', this._onVisibility);
    this._flushAutosave();
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
      // A tool holding a drag (pulling a prefab wall) owns the mouse: the view
      // must not turn under the gesture.
      else if (this.tools.active?.dragging) this.tools.active.onMouseMove(dx, dy);
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
      // A pending F4 "Mark area" owns the mouse: LMB paints top faces, any
      // other button finishes and reopens the quest panel.
      if (this._questAreaPick) {
        this._stepQuestAreaPick(button);
        return;
      }
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
      // Same for doors: LMB opens their settings, Shift+LMB builds as usual.
      if (button === 0 && !shiftKey && (this._clickDoor() || this._clickLight() || this._clickSwitch() || this._clickMobSpawn() || this._clickObject())) return;
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
      // Prefab in hand: R spins the whole building in quarter turns.
      if (this.state.get('prefabId')) {
        const rot = ((this.state.get('prefabRotation') ?? 0) + 1) % 4;
        this.state.set('prefabRotation', rot);
        this.ui.toast(`Prefab rotation: ${rot * 90}°`, 700);
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
    // F / Shift+F mirror the prefab in hand across the world x / z plane, so
    // the twin apartment block next door faces the other way. Only a prefab
    // flips — nothing else in hand has a mirror image.
    const flipPrefab = (axis) => editorOnly(() => {
      if (!this.state.get('prefabId')) return;
      const next = flipPlacement(
        { turns: this.state.get('prefabRotation') ?? 0, mirror: !!this.state.get('prefabMirror') },
        axis,
      );
      this.state.set('prefabRotation', next.turns);
      this.state.set('prefabMirror', next.mirror);
      this.ui.toast(`Prefab flipped on ${axis.toUpperCase()} — ${next.mirror ? 'mirrored' : 'original'} · ${next.turns * 90}°`, 700);
    });
    sub('prefab.flip.x', flipPrefab('x'));
    sub('prefab.flip.z', flipPrefab('z'));
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
    sub('help.toggle', editorOnly(() => this.toggleHelp()));
    sub('save', editorOnly(() => (this.prefabSession ? this.savePrefab() : this.save())));
    sub('undo', editorOnly(() => this.undo()));
    sub('redo', editorOnly(() => this.redo()));
    sub('item.toggle', () => this.toggleItemEditor());
    sub('equip.toggle', () => this.toggleEquipEditor());
    sub('npc.toggle', () => this.toggleNpcEditor());
    sub('test.toggle', () => this.requestTestMode());
    sub('prefab.toggle', () => this.togglePrefabBrowser());
    sub('prefab.paste', editorOnly(() => this.openPrefabBrowser()));
    // Sidebar shortcuts — same entry points the buttons use.
    sub('worlds.toggle', editorOnly(() => this.toggleWorldBrowser()));
    sub('world.new', editorOnly(() => this.ui.armNew()));
    sub('world.load', editorOnly(() => this.ui.pickFile()));
    sub('world.export', editorOnly(() => this.exportMap()));
    sub('items.catalogue', editorOnly(() => {
      if (this.inventory.isOpen) return; // I is a plain letter; the grid owns it
      this.openCatalogue();
    }));
    sub('sidebar.toggle', () => this.ui.toggleSidebar());
    sub('splash.capture', editorOnly(() => this.captureSplashCam()));
    sub('splash.delete', editorOnly(() => this.deleteNearestSplashCam()));
  }

  /** Refresh the ring after the available tool set changes (prefab session). */
  _syncToolRing() {
    this.toolRing.setTools(this.tools.list().map((t) => ({ id: t.id, name: t.name })));
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
      if (t.id !== 'prefab') this.state.set('prefabId', null);
      this.ui.setTool(t.name);
      this.ui.toast(`Tool: ${t.name}`, 700);
      // Picking the Prefab tool empty-handed opens the library to choose from.
      if (t.id === 'prefab' && !this.state.get('prefabId')) this.openPrefabBrowser();
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
      this.doorMarker.update(dt);
    } else if (this.mode === 'test') {
      this.walk.update(dt);
      this._updateTestPrompt();
    }
    // Blinking lights strobe in the editor too; the periodic rescan picks up
    // newly placed/removed lamps without an explicit hook.
    if (this.mode === 'edit' || this.mode === 'test') {
      this.blinkers.update(dt, 1);
      this.renderer.setLampLights(this.blinkers.lampLights);
    }
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
      // Inspector: polled here rather than hooked into every mutation — four
      // reads at 2.5 Hz are cheaper than keeping a dozen call sites honest.
      this.ui.setWorld(this.worldBrowser.currentPath, this._dirty);
      this.ui.setStats({
        voxels: this.world.count,
        objects: this.world.items.size,
        mobs: this.world.mobSpawns.size,
        npcs: this.world.npcSpawns.size,
      });
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
      prefabs: this.prefabs,
      prefabBrowser: this.prefabBrowser,
      prefabPanel: this.prefabPanel,
    };
    // live accessor: main.js snapshots this object once, but mode changes
    // at runtime, so expose it as a getter rather than a frozen primitive.
    Object.defineProperty(handle, 'mode', { enumerable: true, get: () => this.mode });
    Object.defineProperty(handle, 'prefabSession', { enumerable: true, get: () => this.prefabSession });
    return handle;
  }
}
