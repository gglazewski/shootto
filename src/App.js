// App.js — composition root: wires engine + editor together.
//
// Owns construction, input dispatch, persistence, restore, and the game loop.
// Replaces the old monolithic main.js `boot()` while keeping a stable
// debug/test handle (window.__voxelgame) with the fields the e2e suite uses.

import * as THREE from '../vendor/three.module.js';
import { World } from './engine/World.js';
import { Renderer } from './engine/Renderer.js';
import { CELL_SIZE } from './engine/Space.js';
import { listBlockIds, getBlock, SIZE } from './engine/VoxelTypes.js';
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
import { microCellSizeFor, lightLevelForMeters, slugifyName, deserializeItem, rotateMicroPoint } from './engine/ItemTypes.js';
import { createAtlasTexture } from './textures/AtlasTexture.three.js';
import { FlyControls } from './editor/FlyControls.js';
import { WalkControls } from './editor/WalkControls.js';
import { SelectionGhost } from './editor/SelectionGhost.js';
import { SpawnMarker } from './editor/SpawnMarker.js';
import { MobMarker } from './editor/MobMarker.js';
import { Toolbar } from './editor/Toolbar.js';
import { Inventory } from './editor/Inventory.js';
import { UI } from './editor/UI.js';
import { buildSwatchList } from './editor/Swatches.js';
import { EditorState } from './editor/EditorState.js';
import { History } from './editor/History.js';
import { ToolRegistry } from './editor/ToolRegistry.js';
import { BuildTool } from './editor/tools/BuildTool.js';
import { SquareTool } from './editor/tools/SquareTool.js';
import { SpawnTool } from './editor/tools/SpawnTool.js';
import { MobTool } from './editor/tools/MobTool.js';
import { ItemTool } from './editor/tools/ItemTool.js';
import { ItemEditor } from './editor/items/ItemEditor.js';
import { ItemCatalogue } from './editor/items/ItemCatalogue.js';
import { EquipmentEditor } from './editor/items/EquipmentEditor.js';
import { EquipCatalogue } from './editor/items/EquipCatalogue.js';
import { ItemRenderer } from './editor/ItemRenderer.js';
import { buildItemSwatch } from './editor/items/itemSwatch.js';
import { itemAwarePick, collisionWorld } from './editor/itemPick.js';
import { InputDispatcher } from './editor/Input.js';
import { ToolRing } from './editor/ToolRing.js';
import { Notice, onNotice } from './editor/Notice.js';
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
    this.webgl = new THREE.WebGLRenderer({ antialias: true });
    this.container.appendChild(this.webgl.domElement);
    const { texture, tileIndexFor, atlas } = createAtlasTexture(THREE);
    this.renderer = new Renderer({ THREE, webgl: this.webgl, world: this.world, atlasTexture: texture, tileIndexFor, atlas });

    // --- editor state / history ---
    this.state = new EditorState({ blockId: 'grass', size: SIZE.SMALL, itemId: null, itemRotation: 0 });
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
    this.ghost = new SelectionGhost({ THREE, scene: this.renderer.scene });
    this.spawnMarker = new SpawnMarker({ THREE, scene: this.renderer.scene, world: this.world });
    this.mobMarker = new MobMarker({ THREE, scene: this.renderer.scene, world: this.world });

    // --- UI ---
    const items = listBlockIds().map((id) => ({ id, name: getBlock(id).name }));
    this.toolbar = new Toolbar({ container: this.doc.querySelector('#toolbar'), items: buildSwatchList(items) });
    this.inventory = new Inventory({ container: this.doc.querySelector('#inventory'), items: buildSwatchList(items) });
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
    this.tools.register(new ItemTool(ctx));
    this.tool = this.tools.get('build'); // back-compat alias (tests / debug)
    this.tools.activate('build');

    this.toolRing = new ToolRing({ doc });
    this.toolRing.setTools(this.tools.list().map((t) => ({ id: t.id, name: t.name })));

    // --- state -> UI sync ---
    this.state.on(({ field }) => {
      if (field === 'blockId') {
        this.state.set('itemId', null);
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
          const it = getItem(id) ?? getEquipItem(id);
          this.toolbar.selectItem(id);
          this.ui.setSelection(`Item: ${it?.name ?? id}`, it?.size ?? 'small');
          this.tools.activate('item');
        } else {
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
        this.state.set('blockId', null);
        return;
      }
      if (slot.kind === 'item') this.state.set('itemId', slot.id);
      else this.state.set('blockId', slot.id);
    };
    this.inventory.onSelect = (id) => this.state.set('blockId', id);
    this.inventory.onSelectItem = (id) => this.state.set('itemId', id);
    this.inventory.onSelectEquip = (id) => this.state.set('itemId', id);
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
    };

    // initial HUD state
    this.ui.setSelection(this.state.get('blockId'), this.state.get('size'));
    this.ui.setTool(this.tools.active.name);

    // item registry from browser storage
    this._loadItemRegistry();
    this._loadEquipRegistry();
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
    this.state.set('blockId', voxel.type);
    this.state.set('size', voxel.size);
    this.ui.toast(`Picked: ${getBlock(voxel.type).name}`, 900);
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
    const text = this.persistence.readEquipRegistry();
    if (text && deserializeEquipRegistry(text).length) {
      Notice.info('Loaded saved item(s) for the items editor');
    }
    this._refreshInventoryEquip();
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
    this.controls.keys.clear();
    this.controls.velocity.set(0, 0, 0);

    const cell = this._testSpawnCell();
    this.walk.spawnAt(cell[0], cell[1], cell[2], ((this.world.spawnYaw ?? 0) * Math.PI) / 180);

    this.mode = 'test';
    this.doc.body.classList.add('test-mode');
    this.ui.toast('Test run — F5 to exit', 2200);
    if (this.webgl.domElement.requestPointerLock) this.webgl.domElement.requestPointerLock();
  }

  exitTestMode() {
    this.mode = 'edit';
    this.walk.keys.clear();
    this.walk.velocity.set(0, 0, 0);
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

  /** Replace world contents with the voxels/items of another world, then reload. */
  replaceWorldVoxels(loaded) {
    this.world.clear();
    this.history.clear();
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

  async restore() {
    // 1. Author's in-progress browser save wins (fast, offline, works from file://).
    const saved = this.persistence.readSaved();
    if (saved) {
      const { world: loaded, errors } = this.persistence.parse(saved);
      if (!errors.length) {
        this.replaceWorldVoxels(loaded);
      } else {
        Notice.warn(`Saved map had ${errors.length} problem(s) — starting fresh`);
      }
    } else {
      // 2. Next, the world file on disk (served by server.mjs), so edits the
      //    editor wrote to the repo are picked up by other machines/deploys.
      const serverText = await this.persistence.readServerWorld();
      if (serverText) {
        const { world: loaded, errors } = this.persistence.parse(serverText);
        if (!errors.length) {
          this.replaceWorldVoxels(loaded);
          // The bundle registered its objects; make them placeable.
          this._refreshInventoryObjects();
        } else {
          Notice.warn(`Server map had ${errors.length} problem(s) — starting fresh`);
        }
      } else {
        // 3. Finally, the world baked into the build for deployed visitors.
        const bundled = this.persistence.loadBundled();
        if (bundled.world) {
          if (!bundled.errors.length) {
            this.replaceWorldVoxels(bundled.world);
          } else {
            Notice.warn(`Bundled map had ${bundled.errors.length} problem(s) — starting fresh`);
          }
        }
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
    sub('mousedown', ({ button, x, y }) => {
      if (this.mode === 'item') {
        this.itemEditor.onMouseDown({ button, x, y });
        return;
      }
      if (this.mode === 'equip') {
        this.equipmentEditor.onMouseDown({ button, x, y });
        return;
      }
      if (this.toolRing.open) return;
      // Tools only edit in the world editor — test run is walk-only.
      if (this.mode !== 'edit') return;
      if (!this.controls.locked) return;
      if (button === 1) {
        // Middle-click: pick the block/item under the crosshair.
        this.pickBlock();
        return;
      }
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
    sub('item.rotate', editorOnly(() => {
      // With the Spawn tool, R rotates the player's facing at the spawn point.
      if (this.tools.active?.id === 'spawn' && this.world.spawn) {
        this.world.spawnYaw = ((this.world.spawnYaw ?? 0) + 90) % 360;
        this.ui.toast(`Spawn direction: ${this.world.spawnYaw}°`, 700);
        return;
      }
      if (!this.state.get('itemId')) return;
      const rot = (this.state.get('itemRotation') + 90) % 360;
      this.state.set('itemRotation', rot);
      this.ui.toast(`Rotation: ${rot}°`, 700);
    }));
    sub('inventory.toggle', editorOnly(() => {
      const opened = this.inventory.toggle();
      // Free the mouse so the player can click a block in the grid.
      if (opened && document.pointerLockElement === this.webgl.domElement) document.exitPointerLock();
    }));
    sub('mob.cycle', editorOnly(() => {
      if (this.tools.active?.id === 'mob') this.tools.active.cycleType();
    }));
    sub('help.toggle', editorOnly(() => {
      const shown = this.ui.toggleHelp();
      if (shown && document.pointerLockElement === this.webgl.domElement) document.exitPointerLock();
    }));
    sub('save', editorOnly(() => this.save()));
    sub('undo', editorOnly(() => this.undo()));
    sub('redo', editorOnly(() => this.redo()));
    sub('item.toggle', () => this.toggleItemEditor());
    sub('equip.toggle', () => this.toggleEquipEditor());
    sub('test.toggle', () => {
      if (this.mode !== 'item' && this.mode !== 'equip') this.toggleTestMode();
    });
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
    } else if (this.mode === 'test') {
      this.walk.update(dt);
    } else if (this.mode === 'item') {
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
