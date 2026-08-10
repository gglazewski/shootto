// PerfStats.js — tiny toggleable performance overlay (F9 in the game).
//
// Shows FPS / frame time plus the WebGL frame's draw-call and triangle totals
// (webgl.info with manual reset, so the numbers cover every pass of the frame
// — scene plus the postfx chain), the drawing-buffer size, the loaded chunk
// count and whether the post pipeline is active. The DOM readout refreshes at
// ~4 Hz so the overlay itself costs nothing.

export class PerfStats {
  /**
   * @param {object} deps
   * @param {Document} deps.doc
   * @param {object} deps.webgl  THREE.WebGLRenderer
   * @param {object} [deps.renderer]  engine Renderer (chunk count, postfx flag)
   */
  constructor({ doc, webgl, renderer = null }) {
    this.doc = doc;
    this.webgl = webgl;
    this.renderer = renderer;
    this.visible = false;
    this.el = null;
    this._last = 0;
    this._frames = 0;
    this._accMs = 0;
    this._lastUpdate = 0;
    this._calls = 0;
    this._tris = 0;
  }

  /** Flip the overlay on/off. @returns {boolean} new visibility */
  toggle() {
    this.visible = !this.visible;
    if (this.webgl.info) this.webgl.info.autoReset = !this.visible;
    if (this.visible && !this.el) this._build();
    if (this.el) this.el.style.display = this.visible ? 'block' : 'none';
    this._last = 0;
    this._frames = 0;
    this._accMs = 0;
    this._lastUpdate = 0;
    return this.visible;
  }

  _build() {
    const el = this.doc.createElement('div');
    el.style.cssText =
      'position:fixed;top:8px;left:8px;z-index:10000;padding:6px 9px;' +
      'background:rgba(0,0,0,0.55);color:#9fe89f;font:12px monospace;' +
      'line-height:1.5;white-space:pre;pointer-events:none;border-radius:4px';
    this.doc.body.appendChild(el);
    this.el = el;
  }

  /** Call once per frame, after the render. */
  frame() {
    if (!this.visible) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this._last) {
      this._accMs += now - this._last;
      this._frames++;
    }
    this._last = now;
    const info = this.webgl.info;
    if (info) {
      this._calls = info.render.calls;
      this._tris = info.render.triangles;
      info.reset();
    }
    if (this._frames === 0 || now - this._lastUpdate < 250) return;
    const ms = this._accMs / this._frames;
    const canvas = this.webgl.domElement;
    const buf = canvas ? `${canvas.width}x${canvas.height}` : '?';
    const chunks = this.renderer?.chunks?.size ?? 0;
    this.el.textContent =
      `${(1000 / ms).toFixed(0)} fps   ${ms.toFixed(1)} ms\n` +
      `calls ${this._calls}   tris ${(this._tris / 1000).toFixed(0)}k\n` +
      `buffer ${buf}   chunks ${chunks}\n` +
      `postfx ${this.renderer?.postfxEnabled ? 'on' : 'off'}`;
    this._frames = 0;
    this._accMs = 0;
    this._lastUpdate = now;
  }
}
