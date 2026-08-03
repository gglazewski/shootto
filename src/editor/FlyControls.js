// FlyControls.js — pointer-lock FPS fly camera.
//
// WASD moves on the camera's horizontal plane, Space/Shift go up/down and
// Shift sprints. Scroll changes movement speed. Pointer lock is requested via
// domElement. The math helpers (applyLook, moveInPlane) are exported so they
// can be unit tested without a DOM.

const PITCH_LIMIT = Math.PI / 2 - 0.01;

export function clampPitch(p) {
  return Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p));
}

/** Adjust yaw/pitch from raw mouse deltas and return them. */
export function applyLook(yaw, pitch, dx, dy, sensitivity) {
  yaw -= dx * sensitivity;
  pitch = clampPitch(pitch - dy * sensitivity);
  return { yaw, pitch };
}

export class FlyControls {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Camera} deps.camera
   * @param {HTMLElement} deps.domElement
   * @param {{sensitivity?:number, speed?:number, accel?:number, sprint?:number, minSpeed?:number, maxSpeed?:number}} deps.opts
   */
  constructor({ THREE, camera, domElement, opts = {} }) {
    this.THREE = THREE;
    this.camera = camera;
    this.domElement = domElement;
    this.sensitivity = opts.sensitivity ?? 0.0022;
    this.speed = opts.speed ?? 6;
    this.accel = opts.accel ?? 14;
    this.sprint = opts.sprint ?? 4;
    this.minSpeed = opts.minSpeed ?? 0.5;
    this.maxSpeed = opts.maxSpeed ?? 40;

    this.yaw = 0;
    this.pitch = 0;
    this.locked = false;
    this.enabled = true; // false while in the item editor (no pointer lock)
    this.velocity = new THREE.Vector3();

    this.keys = new Set();
    this._bound = this._onLockChange.bind(this);

    this.camera.rotation.order = 'YXZ';
  }

  connect() {
    document.addEventListener('pointerlockchange', this._bound);
    this.domElement.addEventListener('mousedown', this._requestLock);
  }

  disconnect() {
    document.removeEventListener('pointerlockchange', this._bound);
    this.domElement.removeEventListener('mousedown', this._requestLock);
  }

  _requestLock = () => {
    if (!this.enabled) return;
    if (!this.locked && this.domElement.requestPointerLock) {
      this.domElement.requestPointerLock();
    }
  };

  _onLockChange() {
    this.locked = document.pointerLockElement === this.domElement;
    if (this.locked) {
      // sync once on lock so an externally-moved camera (e.g. frameCamera)
      // becomes the base orientation for mouse look
      this.yaw = this.camera.rotation.y;
      this.pitch = this.camera.rotation.x;
    }
  }

  /**
   * Call each frame with seconds since last frame.
   * @param {number} dt
   */
  update(dt) {
    const k = this.keys;
    // forward is camera yaw only (fly on the horizontal plane)
    const forward = new this.THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new this.THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const target = new this.THREE.Vector3();
    if (k.has('KeyW') || k.has('ArrowUp')) target.add(forward);
    if (k.has('KeyS') || k.has('ArrowDown')) target.sub(forward);
    if (k.has('KeyD') || k.has('ArrowRight')) target.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) target.sub(right);
    if (k.has('Space')) target.y += 1;
    if (k.has('KeyC')) target.y -= 1;

    const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? this.speed * this.sprint : this.speed;
    target.normalize().multiplyScalar(speed);

    // smooth toward target velocity
    const t = Math.min(1, dt * this.accel);
    this.velocity.lerp(target, t);

    this.camera.position.addScaledVector(this.velocity, dt);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  /** @param {number} dx raw mousemove deltaX */
  /** @param {number} dy raw mousemove deltaY */
  onMouseMove(dx, dy) {
    if (!this.locked) return;
    const l = applyLook(this.yaw, this.pitch, dx, dy, this.sensitivity);
    this.yaw = l.yaw;
    this.pitch = l.pitch;
  }

  onKeyDown(code) {
    this.keys.add(code);
  }

  onKeyUp(code) {
    this.keys.delete(code);
  }

  onWheel(deltaY) {
    const factor = deltaY > 0 ? 1 / 1.25 : 1.25;
    this.speed = Math.max(this.minSpeed, Math.min(this.maxSpeed, this.speed * factor));
    return this.speed;
  }
}
