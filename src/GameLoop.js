// GameLoop.js — requestAnimationFrame loop with a clamped delta time.
//
// Runs an onFrame(dt) callback each frame. start()/stop() make it safe to
// tear down (hot reload, tests) without leaking frames.

export class GameLoop {
  constructor({ onFrame }) {
    this.onFrame = onFrame;
    this.running = false;
    this._raf = 0;
    this._last = 0;
    this._tick = (now) => {
      const dt = Math.min(0.1, (now - this._last) / 1000);
      this._last = now;
      this.onFrame(dt, now);
      if (this.running) this._raf = requestAnimationFrame(this._tick);
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }
}
