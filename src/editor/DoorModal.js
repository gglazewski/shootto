// DoorModal.js — per-door settings, opened by clicking a door in the editor.
//
// Three settings, mirroring what Doors.js stores on the voxel:
//   - locked / unlocked (a locked door refuses to open, for anyone)
//   - an unlock flag: name a game flag and the door starts locked, opening
//     up only once something in the game raises the flag (a quest accepting
//     or completing — see game/Reactions.js)
//   - how it opens: which jamb it hinges on and which side of the wall the
//     leaf swings to.
//
// The opening is picked from four plan-view thumbnails drawn the way an
// architectural floor plan draws a door — wall, leaf, quarter arc — so the
// choice is read rather than decoded from axis names. The plans are drawn in
// world orientation, north (-Z) up and east (+X) right, matching the arc
// gizmos DoorMarker paints in the world itself.
//
// DOM-only; the caller applies the choice to the voxel and re-meshes.

import { closeX } from './closeX.js';

const NS = 'http://www.w3.org/2000/svg';

/** Compass name of a world direction, for the option captions. */
const COMPASS = { pz: 'south', nz: 'north', px: 'east', nx: 'west' };

/**
 * The four ways a door on this axis can open, as {hinge, swing} plus the
 * plan-drawing vectors. `alongX` = the closed leaf stands along x (door
 * rotations 0 and 2), otherwise it stands along z (rotations 1 and 3).
 *
 * Screen convention for the plans: +x right, +z down.
 */
export function doorOpenings(alongX) {
  const out = [];
  for (const hinge of ['left', 'right']) {
    for (const swing of alongX ? ['pz', 'nz'] : ['px', 'nx']) {
      // Leaf axis on screen, and the direction the leaf swings to.
      const u = alongX ? [1, 0] : [0, 1];
      const n = alongX ? [0, swing === 'pz' ? 1 : -1] : [swing === 'px' ? 1 : -1, 0];
      // 'left' hinges on the low end of the leaf's axis, 'right' on the high.
      const sign = hinge === 'left' ? -1 : 1;
      out.push({
        hinge,
        swing,
        u,
        n,
        sign,
        // Which side of the opening the hinge sits on, in compass terms.
        hingeSide: COMPASS[axisFace(u, sign)],
        swingSide: COMPASS[swing],
      });
    }
  }
  return out;
}

function axisFace([ux, uz], sign) {
  if (ux) return sign > 0 ? 'px' : 'nx';
  return sign > 0 ? 'pz' : 'nz';
}

/**
 * Plan-view door symbol as an SVG element: wall stubs, the closed leaf, the
 * open leaf and the quarter arc between them.
 */
export function planIcon(doc, opening, size = 62) {
  const c = size / 2;
  const half = size * 0.32; // half the opening width
  const wall = size * 0.5; // wall stub reaches the edge
  const { u, n, sign } = opening;
  const at = (t, s = 0) => [c + u[0] * t + n[0] * s, c + u[1] * t + n[1] * s];

  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'door-plan');

  const line = (a, b, cls) => {
    const el = doc.createElementNS(NS, 'line');
    el.setAttribute('x1', a[0]); el.setAttribute('y1', a[1]);
    el.setAttribute('x2', b[0]); el.setAttribute('y2', b[1]);
    el.setAttribute('class', cls);
    svg.appendChild(el);
  };

  // Wall on both sides of the opening.
  line(at(-wall), at(-half), 'dp-wall');
  line(at(half), at(wall), 'dp-wall');

  const hinge = at(half * sign);
  const closed = at(-half * sign);
  const open = [hinge[0] + n[0] * half * 2, hinge[1] + n[1] * half * 2];

  // Quarter arc, closed position round to open. Sweep direction follows the
  // sign of the turn in screen space (y grows downward).
  const a = [closed[0] - hinge[0], closed[1] - hinge[1]];
  const b = [open[0] - hinge[0], open[1] - hinge[1]];
  const sweep = a[0] * b[1] - a[1] * b[0] > 0 ? 1 : 0;
  const r = half * 2;
  const arc = doc.createElementNS(NS, 'path');
  arc.setAttribute('d', `M ${closed[0]} ${closed[1]} A ${r} ${r} 0 0 ${sweep} ${open[0]} ${open[1]}`);
  arc.setAttribute('class', 'dp-arc');
  svg.appendChild(arc);

  line(hinge, closed, 'dp-leaf-closed');
  line(hinge, open, 'dp-leaf-open');

  const pivot = doc.createElementNS(NS, 'circle');
  pivot.setAttribute('cx', hinge[0]); pivot.setAttribute('cy', hinge[1]);
  pivot.setAttribute('r', 2.6);
  pivot.setAttribute('class', 'dp-hinge');
  svg.appendChild(pivot);

  return svg;
}

export class DoorModal {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} deps.container  the modal root (#door-settings)
   */
  constructor({ doc = document, container }) {
    this.doc = doc;
    this.container = container;
    this.onClose = null;
    this._onApply = null;

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

  /**
   * Show the settings for one door.
   * @param {{locked: boolean, unlockFlag: string, hinge: 'left'|'right', swing: string, alongX: boolean, name: string}} state
   * @param {(change: {locked?: boolean, unlockFlag?: string, hinge?: string, swing?: string}) => void} onApply
   *   Called on every change; the modal stays open so several settings can be
   *   adjusted in one visit.
   */
  open(state, onApply) {
    this._state = { ...state };
    this._onApply = onApply;
    this._render();
    this.container.classList.add('open');
    this.doc.addEventListener('keydown', this._onKey, true);
  }

  _apply(change) {
    Object.assign(this._state, change);
    this._onApply?.(change);
    this._render();
  }

  _render() {
    const doc = this.doc;
    const s = this._state;
    this.panel.innerHTML = '';

    const head = doc.createElement('h2');
    // Door block names already read as names ("Entrance Door"), so the block's
    // own name is the clearest title; unnamed blocks fall back to "Door".
    head.textContent = s.name || 'Door';
    this.panel.appendChild(head);
    this.panel.appendChild(closeX(doc, () => this.hide()));

    // --- lock ---
    const lockRow = doc.createElement('div');
    lockRow.className = 'door-row';
    for (const locked of [false, true]) {
      const btn = doc.createElement('button');
      btn.className = 'cat-btn door-lock';
      if (s.locked === locked) btn.classList.add('active');
      if (locked) btn.classList.add('danger');
      btn.textContent = locked ? '🔒 Locked' : '🔓 Unlocked';
      btn.addEventListener('click', () => this._apply({ locked }));
      lockRow.appendChild(btn);
    }
    this.panel.appendChild(lockRow);

    const lockHint = doc.createElement('p');
    lockHint.className = 'door-hint';
    lockHint.textContent = s.locked
      ? 'Nobody can open this door — it stays shut in the game and the test run.'
      : 'Anyone can open this door with E.';
    this.panel.appendChild(lockHint);

    // --- unlock flag (action/reaction) ---
    const flagRow = doc.createElement('label');
    flagRow.className = 'door-flag';
    flagRow.append('Unlocks when flag');
    const flagIn = doc.createElement('input');
    flagIn.type = 'text';
    flagIn.placeholder = 'none';
    flagIn.value = s.unlockFlag ?? '';
    // Naming a flag locks the door too — a flag-gated door starts locked and
    // the flag is what opens it, so authoring them together keeps the marker
    // and the test run honest.
    flagIn.addEventListener('change', () => {
      const name = flagIn.value.trim();
      this._apply(name ? { unlockFlag: name, locked: true } : { unlockFlag: '' });
    });
    flagRow.appendChild(flagIn);
    this.panel.appendChild(flagRow);

    const flagHint = doc.createElement('p');
    flagHint.className = 'door-hint';
    flagHint.textContent = s.unlockFlag
      ? `Locked until the game raises “${s.unlockFlag}” — a quest can, on accept or completion (its Flags fields).`
      : 'Optional: name a flag and the door stays locked until the game raises it — a quest can, on accept or completion.';
    this.panel.appendChild(flagHint);

    // --- opening direction ---
    const sub = doc.createElement('h3');
    sub.textContent = 'Opens';
    this.panel.appendChild(sub);

    const grid = doc.createElement('div');
    grid.className = 'door-grid';
    for (const o of doorOpenings(s.alongX)) {
      const btn = doc.createElement('button');
      btn.className = 'cat-btn door-opt';
      if (o.hinge === s.hinge && o.swing === s.swing) btn.classList.add('active');
      btn.appendChild(planIcon(doc, o));
      const cap = doc.createElement('span');
      cap.textContent = `${o.swingSide} · hinge ${o.hingeSide}`;
      btn.appendChild(cap);
      btn.addEventListener('click', () => this._apply({ hinge: o.hinge, swing: o.swing }));
      grid.appendChild(btn);
    }
    this.panel.appendChild(grid);

    const planHint = doc.createElement('p');
    planHint.className = 'door-hint';
    planHint.textContent = 'Floor plan, north up. The same symbol is drawn at the door in the world.';
    this.panel.appendChild(planHint);

    const close = doc.createElement('button');
    close.className = 'cat-btn cat-close';
    close.textContent = 'Done';
    close.addEventListener('click', () => this.hide());
    this.panel.appendChild(close);
  }

  hide() {
    const wasOpen = this.isOpen;
    this.container.classList.remove('open');
    this.doc.removeEventListener('keydown', this._onKey, true);
    this._onApply = null;
    if (wasOpen && this.onClose) this.onClose();
  }

  get isOpen() {
    return this.container.classList.contains('open');
  }
}
