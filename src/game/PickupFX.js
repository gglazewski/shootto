// PickupFX.js — a picked-up item floating to the player.
//
// When the player picks up an equippable item (E / mobile PICK), it doesn't
// vanish into the inventory instantly. This spawns a world-space mini mesh of
// the item at its resting spot that arcs up and floats to the player's chest
// over a short flight, swelling mid-flight and shrinking as it is absorbed.
// The pickup is only granted when the flight completes (GameApp's callback),
// so the "got it" lands at the moment the item reaches the player.
//
// The flying mesh uses the same map-less lit material as placed items and
// re-samples the LightField at its current cell every frame, so it stays lit
// like the world it flies through (dark in caves, warm near torches).

import { createItemGeometry } from '../editor/ItemGeometry.three.js';
import { microCellSizeFor, MICRO_GRID } from '../engine/ItemTypes.js';
import { CELL_SIZE } from '../engine/Space.js';

const FLIGHT_TIME = 0.5;    // seconds from resting spot to the player
const ARC_HEIGHT = 0.3;     // meters the item lifts above the straight line
const SPIN = Math.PI * 1.4; // total yaw (radians) over the flight
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class PickupFX {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Scene} deps.scene
   * @param {import('three').Camera} deps.camera  the flight target tracks this
   * @param {object} [deps.lightField]  LightField to shade the flying item with
   * @param {import('three').Material} [deps.material]  map-less lit material
   *   (Renderer.itemMaterial)
   */
  constructor({ THREE, scene, camera, lightField = null, material = null }) {
    this.THREE = THREE;
    this.scene = scene;
    this.camera = camera;
    this.lightField = lightField;
    this.material = material;
    this._group = null;
    this._lightAttr = null;
    this._start = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._onArrive = null;
    this._yaw = 0;
    this._t = 0;
  }

  /** True while an item is flying to the player. */
  get active() {
    return !!this._group;
  }

  /** Fly a copy of `def` from `from` (world position) to the player's chest.
   *  `yaw` is the placement rotation (radians) the item rested at; `onArrive`
   *  fires once the item reaches the player. Replaces any flight in progress. */
  fly(def, from, yaw = 0, onArrive = null) {
    this.clear();
    const T = this.THREE;
    const c = microCellSizeFor(def.size ?? 'small');
    const geo = createItemGeometry(T, def.microVoxels ?? [], { lightField: this.lightField });
    this._lightAttr = geo.getAttribute('light');
    if (!this._lightAttr) {
      const count = geo.attributes.position.count;
      this._lightAttr = new T.BufferAttribute(new Float32Array(count * 2), 2);
      geo.setAttribute('light', this._lightAttr);
    }

    this._group = new T.Group();
    const mesh = new T.Mesh(geo, this.material ?? new T.MeshBasicMaterial({ vertexColors: true }));
    // Centre the item's micro grid on the group origin, then scale to meters.
    const half = (MICRO_GRID * c) / 2;
    mesh.scale.setScalar(c);
    mesh.position.set(-half, -half, -half);
    this._group.add(mesh);
    this._group.rotation.y = yaw;
    this._group.position.copy(from);
    this.scene.add(this._group);

    this._start.copy(from);
    this._onArrive = onArrive;
    this._yaw = yaw;
    this._t = 0;
  }

  /** Advance the flight. The target re-tracks the camera each frame so the item
   *  follows the player if they move mid-flight. @param {number} dt seconds */
  update(dt) {
    if (!this._group) return;
    this._t += dt;
    const u = Math.min(1, this._t / FLIGHT_TIME);
    const e = easeInOutCubic(u);

    // Target: chest height just in front of the camera.
    this.camera.getWorldDirection(this._dir);
    this._target.copy(this.camera.position).addScaledVector(this._dir, 0.7);
    this._target.y -= 0.22;

    const g = this._group;
    g.position.x = this._start.x + (this._target.x - this._start.x) * e;
    g.position.z = this._start.z + (this._target.z - this._start.z) * e;
    g.position.y = this._start.y + (this._target.y - this._start.y) * e + Math.sin(u * Math.PI) * ARC_HEIGHT;
    g.rotation.y = this._yaw + u * SPIN;
    // Breathe: swell mid-flight, shrink back as it is absorbed.
    g.scale.setScalar(1 + 0.3 * Math.sin(u * Math.PI));

    if (this.lightField) this._relight();

    if (u >= 1) {
      const cb = this._onArrive;
      this.clear();
      cb?.();
    }
  }

  /** Re-sample the light field at the item's current cell (one lookup, cheap). */
  _relight() {
    const p = this._group.position;
    const cx = Math.floor(p.x / CELL_SIZE);
    const cy = Math.floor(p.y / CELL_SIZE);
    const cz = Math.floor(p.z / CELL_SIZE);
    const sky = this.lightField.skyAt(cx, cy, cz) / 15;
    const block = this.lightField.blockAt(cx, cy, cz) / 15;
    const arr = this._lightAttr.array;
    for (let i = 0; i < arr.length; i += 2) {
      arr[i] = sky;
      arr[i + 1] = block;
    }
    this._lightAttr.needsUpdate = true;
  }

  /** Drop the flying item (dispose geometry). Safe to call anytime. */
  clear() {
    if (!this._group) return;
    this.scene.remove(this._group);
    this._group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material !== this.material) o.material.dispose();
    });
    this._group = null;
    this._lightAttr = null;
    this._onArrive = null;
  }
}
