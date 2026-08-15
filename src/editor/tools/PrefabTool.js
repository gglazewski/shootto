// PrefabTool.js — stamp prefabs from the library into the world.
//
// Active when a prefab is selected (state.prefabId, chosen in the Prefab
// browser). A translucent full-mesh preview of the building follows the aim,
// centered on the crosshair and standing on the clicked face; R spins it in
// quarter turns, F / Shift+F flip it across the world x / z plane (the
// mirrored twin of an apartment block, not an upside-down one). LMB stamps
// the prefab as ONE undoable history entry —
// occupied cells keep their existing content (the skipped count is reported).
// RMB puts the prefab away.
//
// The same tool serves inside a prefab session (Shift+F6 opens the library in
// paste mode), so a prefab can be built out of prefabs; there it also warns
// when the paste lands outside the build volume, which would refuse to save.
//
// The preview reuses the chunk mesher on a throwaway World, so it looks
// exactly like the pasted result — same textures, same AO — at zero cost to
// the live chunk pipeline (one static mesh per prefab+placement, rebuilt only
// when the selection, rotation or flip changes).

import { Tool } from '../Tool.js';
import { Notice } from '../Notice.js';
import { pastePrefabCommand } from '../commands.js';
import { itemAwarePick } from '../itemPick.js';
import { contentBounds } from '../prefabResize.js';
import { World } from '../../engine/World.js';
import { buildChunkMesh } from '../../engine/ChunkMeshBuilder.js';
import { stampPrefab, rotatedDims, countBlocked } from '../../engine/PrefabStamp.js';
import { CELL_SIZE } from '../../engine/Space.js';

const FREE_COLOR = 0x55dd99;
const BLOCKED_COLOR = 0xffaa44;

export class PrefabTool extends Tool {
  constructor(ctx) {
    super({ id: 'prefab', name: 'Prefab', ctx });
    this.lastAction = '';
    this._preview = null; // THREE.Group for the current prefab+rotation
    this._previewKey = '';
    this._box = null; // bounds LineSegments (child of preview)
    this._blockedAt = ''; // cache key of the last collision check
    this._blockedCount = 0;
  }

  /** The selected prefab (resolved through the library cache), or null. */
  get prefab() {
    const id = this.ctx.state.get('prefabId');
    return id ? this.ctx.prefabs?.cached(id) : null;
  }

  /** Quarter turns CCW (R cycles). */
  get turns() {
    return (this.ctx.state.get('prefabRotation') ?? 0) & 3;
  }

  /** Whether the prefab is stamped as its mirror image (F / Shift+F). */
  get mirror() {
    return !!this.ctx.state.get('prefabMirror');
  }

  pick() {
    return itemAwarePick(this.ctx.world, this.ctx.THREE, this.ctx.camera);
  }

  /** World cell of the prefab's min corner. The CONTENT footprint (not the
   *  build volume, which may be mostly air) centers on the aimed cell, base
   *  resting on the clicked face — top faces stack on top; side faces grow
   *  sideways from the wall. */
  placementOffset(hit) {
    const [W, , D] = rotatedDims(this.prefab.dims, this.turns);
    // Content extents in rotated prefab coords (cached by _buildPreview).
    const box = this._contentBox ?? { minX: 0, maxX: W - 1, minZ: 0, maxZ: D - 1 };
    const cw = box.maxX - box.minX + 1;
    const cd = box.maxZ - box.minZ + 1;
    const [cx, cy, cz] = hit.cell;
    const [nx, ny, nz] = hit.normal;
    if (ny !== 0) {
      const y = ny > 0 ? cy + 1 : cy - this.prefab.dims[1];
      return [cx - box.minX - Math.floor(cw / 2), y, cz - box.minZ - Math.floor(cd / 2)];
    }
    // Side hit: the content's near wall sits against the clicked face.
    const x = nx > 0 ? cx + 1 - box.minX : nx < 0 ? cx - box.maxX - 1 : cx - box.minX - Math.floor(cw / 2);
    const z = nz > 0 ? cz + 1 - box.minZ : nz < 0 ? cz - box.maxZ - 1 : cz - box.minZ - Math.floor(cd / 2);
    return [x, hit.cell[1], z];
  }

  onMouseDown(button) {
    if (button === 2) {
      this.ctx.state.set('prefabId', null);
      return;
    }
    if (button !== 0) return;
    const prefab = this.prefab;
    if (!prefab) return;
    const hit = this.pick();
    if (!hit) return;
    const offset = this.placementOffset(hit);
    const cmd = pastePrefabCommand(this.ctx.world, prefab, offset, this.turns, () => this.ctx.onItemChange?.(), this.mirror);
    if (cmd.do()) {
      this.ctx.history.push(cmd);
      this._blockedAt = ''; // world changed under the ghost — re-check
      this.lastAction = `Pasted ${prefab.name}`;
      if (cmd.skipped > 0) Notice.warn(`Pasted ${prefab.name} — ${cmd.skipped} blocked cell(s) kept their content`);
      else Notice.info(`Pasted ${prefab.name}`);
      this._warnIfOutsideVolume();
    } else {
      Notice.warn('Nothing pasted — the area is fully blocked');
    }
  }

  /** Inside a prefab session the paste can land half outside the build
   *  volume, where saving would refuse it. Say so now, while the aim is still
   *  fresh, instead of at Save time. */
  _warnIfOutsideVolume() {
    const session = this.ctx.prefab?.session?.();
    if (!session) return;
    const b = contentBounds(this.ctx.world);
    if (!b) return;
    const out = b.min.some((n) => n < 0) || b.max.some((n, i) => n >= session.dims[i]);
    if (out) Notice.warn(`Content sticks out of the ${session.dims.join('×')} volume — grow the size or move it inside`);
  }

  update() {
    this._updatePreview();
  }

  cancel() {
    this.hide();
  }

  hide() {
    if (this._preview) this._preview.visible = false;
    this.ctx.ghost.hide();
  }

  onDeactivate() {
    this._disposePreview();
  }

  // --- preview mesh ---

  _updatePreview() {
    const prefab = this.prefab;
    this.ctx.ghost.hide();
    if (!prefab) {
      this.hide();
      return;
    }
    const key = `${prefab.id}/${this.turns}/${this.mirror ? 'm' : ''}`;
    if (key !== this._previewKey) {
      this._disposePreview();
      this._buildPreview(prefab, this.turns, this.mirror);
      this._previewKey = key;
    }
    const hit = this.pick();
    if (!hit || !this._preview) {
      this.hide();
      return;
    }
    const [x, y, z] = this.placementOffset(hit);
    this._preview.visible = true;
    this._preview.position.set(x * CELL_SIZE, y * CELL_SIZE, z * CELL_SIZE);

    // Tint the bounds box by collision state (checked only when the anchor moves).
    const at = `${x},${y},${z}`;
    if (at !== this._blockedAt) {
      this._blockedAt = at;
      this._blockedCount = countBlocked(this.ctx.world, prefab, [x, y, z], this.turns, this.mirror);
      this._box?.material.color.setHex(this._blockedCount ? BLOCKED_COLOR : FREE_COLOR);
    }
  }

  /** Mesh the prefab once via the chunk mesher on a throwaway world. */
  _buildPreview(prefab, turns, mirror = false) {
    const T = this.ctx.THREE;
    const temp = new World();
    stampPrefab(temp, prefab, [0, 0, 0], turns, mirror);
    const [W, H, D] = rotatedDims(prefab.dims, turns);
    const span = Math.max(W, H, D);

    // Content extents (rotated coords) — the anchor math centers on these.
    let box = null;
    temp.forEachVoxel((v) => {
      const [x, , z] = v.anchor;
      if (!box) box = { minX: x, maxX: x, minZ: z, maxZ: z };
      box.minX = Math.min(box.minX, x);
      box.maxX = Math.max(box.maxX, x);
      box.minZ = Math.min(box.minZ, z);
      box.maxZ = Math.max(box.maxZ, z);
    });
    temp.forEachItem((it) => {
      const [x, , z] = it.anchor;
      if (!box) box = { minX: x, maxX: x, minZ: z, maxZ: z };
      box.minX = Math.min(box.minX, x);
      box.maxX = Math.max(box.maxX, x);
      box.minZ = Math.min(box.minZ, z);
      box.maxZ = Math.max(box.maxZ, z);
    });
    this._contentBox = box;

    const group = new T.Group();
    group.name = 'prefab-preview';

    // No light field -> full bright; the ghost must read clearly, not photoreal.
    const data = buildChunkMesh(temp, null, [0, 0, 0], span, this.ctx.tileIndexFor, this.ctx.atlas);
    for (const d of [data, data.transparent]) {
      if (!d || !d.indices?.length) continue;
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(d.positions, 3));
      geo.setAttribute('normal', new T.BufferAttribute(d.normals, 3));
      geo.setAttribute('uv', new T.BufferAttribute(d.uvs, 2));
      geo.setAttribute('color', new T.BufferAttribute(d.colors, 3));
      geo.setIndex(new T.BufferAttribute(d.indices, 1));
      const mat = new T.MeshBasicMaterial({
        map: this.ctx.atlasTexture,
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      });
      group.add(new T.Mesh(geo, mat));
    }

    // Footprint outline so even an airy prefab shows its full claim.
    const boxGeo = new T.BufferGeometry();
    const w = W * CELL_SIZE;
    const h = H * CELL_SIZE;
    const d2 = D * CELL_SIZE;
    const c = [
      [0, 0, 0], [w, 0, 0], [w, 0, d2], [0, 0, d2],
      [0, h, 0], [w, h, 0], [w, h, d2], [0, h, d2],
    ];
    const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    boxGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(edges.flatMap((i) => c[i])), 3));
    this._box = new T.LineSegments(boxGeo, new T.LineBasicMaterial({ color: FREE_COLOR }));
    group.add(this._box);

    group.visible = false;
    this.ctx.scene.add(group);
    this._preview = group;
    this._blockedAt = '';
  }

  _disposePreview() {
    if (!this._preview) return;
    this.ctx.scene.remove(this._preview);
    this._preview.traverse((o) => {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    });
    this._preview = null;
    this._box = null;
    this._previewKey = '';
    this._blockedAt = '';
  }
}
