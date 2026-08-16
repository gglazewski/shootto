// SplashMotionModal.js — pick the menu motion of a splash camera.
//
// Opens when the author clicks a splash-cam gizmo in the world editor and
// offers the four motions the menu can play for that shot. One click picks
// and closes; Escape or the backdrop cancels. DOM-only.

import { closeX } from './closeX.js';

export const SPLASH_MOTIONS = Object.freeze([
  { id: 'orbit', label: 'Orbit', hint: 'slow circle around the framed spot' },
  { id: 'static', label: 'Static', hint: 'holds the shot with a subtle sway' },
  { id: 'zoomout', label: 'Zoom out', hint: 'starts on the shot and pulls back' },
  { id: 'zoomin', label: 'Zoom in', hint: 'pushes toward the framed spot' },
]);

export class SplashMotionModal {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} deps.container  the modal root (#splash-motion)
   */
  constructor({ doc = document, container }) {
    this.doc = doc;
    this.container = container;
    this.onClose = null;
    this._onPick = null;

    this.panel = container.querySelector('.panel');
    container.addEventListener('click', (e) => {
      if (e.target === container) this.hide();
    });
    this._onKey = (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      }
      e.stopPropagation(); // keep editor shortcuts out while open
    };
  }

  /** Show the picker for one cam. onPick(motionId) fires on choice. */
  open(cam, onPick) {
    this._onPick = onPick;
    const doc = this.doc;
    this.panel.innerHTML = '';

    const head = doc.createElement('h2');
    head.textContent = 'Splash camera motion';
    this.panel.appendChild(head);
    this.panel.appendChild(closeX(doc, () => this.hide()));

    // The old 'dolly' motion is today's zoom in.
    const current = cam.motion === 'dolly' ? 'zoomin' : (cam.motion ?? 'orbit');
    for (const m of SPLASH_MOTIONS) {
      const btn = doc.createElement('button');
      btn.className = 'cat-btn sm-option';
      if (m.id === current) btn.classList.add('active');
      const name = doc.createElement('strong');
      name.textContent = m.label;
      const hint = doc.createElement('span');
      hint.textContent = m.hint;
      btn.append(name, hint);
      btn.addEventListener('click', () => {
        const pick = this._onPick;
        this.hide();
        pick?.(m.id);
      });
      this.panel.appendChild(btn);
    }

    const close = doc.createElement('button');
    close.className = 'cat-btn cat-close';
    close.textContent = 'Cancel';
    close.addEventListener('click', () => this.hide());
    this.panel.appendChild(close);

    this.container.classList.add('open');
    this.doc.addEventListener('keydown', this._onKey, true);
  }

  hide() {
    const wasOpen = this.isOpen;
    this.container.classList.remove('open');
    this.doc.removeEventListener('keydown', this._onKey, true);
    this._onPick = null;
    if (wasOpen && this.onClose) this.onClose();
  }

  get isOpen() {
    return this.container.classList.contains('open');
  }
}
