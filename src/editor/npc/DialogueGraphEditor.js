// DialogueGraphEditor.js — embedded editor for a DialogueGraph (branching
// conversation, see engine/DialogueGraph.js). Used twice by the F4 panel:
// a quest tier's "about the quest" tree and an NPC's small-talk tree.
//
// The graph is a pannable canvas map: nodes are boxes joined by reply arrows
// (▶ marks the start node, ⏎ stubs mark replies that end the conversation).
// Drag the background to pan, the wheel zooms, nodes drag to rearrange, a
// double-click on empty space adds a node. Clicking a node opens its card
// below the map: what the NPC says, then the player's replies, each pointing
// at another node or ending the conversation. Node positions persist with
// the graph (`pos`); the runtime ignores them. The component keeps its own
// draft; the host reads it back with value() (a normalized graph or null) or
// snapshot() (raw draft, survives host re-renders).

import { normalizeDialogueGraph } from '../../engine/DialogueGraph.js';

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const END_VALUE = '';
const NODE_W = 150;
const NODE_H = 54;
const CANVAS_H = 300;

export class DialogueGraphEditor {
  /**
   * @param {object} deps
   * @param {Document} deps.doc
   * @param {object|null} [deps.graph]  starting graph ({start, nodes} shape,
   *   normalized or a raw snapshot) — deep-copied into the draft
   * @param {() => void} [deps.onDirty]  fired on any edit
   */
  constructor({ doc, graph, onDirty }) {
    this.doc = doc;
    this.onDirty = onDirty ?? (() => {});
    /** Ordered draft: [{id, say, choices: [{label,next}], x, y}]. */
    this.nodes = graph
      ? Object.entries(graph.nodes ?? {}).map(([id, n]) => ({
        id,
        say: [...(n.say ?? [])],
        choices: (n.choices ?? []).map((c) => ({ label: c.label ?? '', next: c.next ?? null })),
        x: Number.isFinite(n.pos?.[0]) ? n.pos[0] : null,
        y: Number.isFinite(n.pos?.[1]) ? n.pos[1] : null,
      }))
      : [];
    this.start = graph?.start && this.nodes.some((n) => n.id === graph.start)
      ? graph.start
      : this.nodes[0]?.id ?? null;
    this.sel = this.start;
    this.panX = 16;
    this.panY = 16;
    this.zoom = 1;
    this._drag = null; // {mode:'pan'|'node', ...}
    this._autoLayout();
    this.el = el(doc, 'div', 'npcq-graph');
    this._render();
  }

  /** The draft as a stored-shape graph (may hold empty nodes mid-edit) —
   *  what a host squirrels away across its own re-renders. */
  snapshot() {
    this._sync();
    return this.nodes.length
      ? {
        start: this.start,
        nodes: Object.fromEntries(this.nodes.map((n) => [n.id, {
          say: n.say,
          choices: n.choices,
          pos: [Math.round(n.x), Math.round(n.y)],
        }])),
      }
      : null;
  }

  /** The finished graph for the registry: normalized, or null when empty. */
  value() {
    return normalizeDialogueGraph(this.snapshot());
  }

  /** Copy the live card fields back into the draft objects. */
  _sync() {
    const f = this._fields;
    if (!f) return;
    f.node.say = f.sayTa.value.split('\n').map((l) => l.trim()).filter(Boolean);
    f.node.choices = f.choiceRows.map((r) => ({
      label: r.labelIn.value,
      next: r.nextSel.value === END_VALUE ? null : r.nextSel.value,
    }));
  }

  /** First unused `nN` node id. */
  _freshId() {
    let n = this.nodes.length + 1;
    while (this.nodes.some((node) => node.id === `n${n}`)) n += 1;
    return `n${n}`;
  }

  _touch() {
    this.onDirty();
  }

  _byId(id) {
    return this.nodes.find((n) => n.id === id) ?? null;
  }

  /** Place nodes that carry no stored position: BFS columns from the start
   *  node (depth → column, arrival order → row), unreachable ones after. */
  _autoLayout() {
    if (this.nodes.every((n) => n.x != null && n.y != null)) return;
    const depth = new Map();
    const queue = this.start ? [[this.start, 0]] : [];
    while (queue.length) {
      const [id, d] = queue.shift();
      if (depth.has(id)) continue;
      depth.set(id, d);
      for (const c of this._byId(id)?.choices ?? []) {
        if (c.next && !depth.has(c.next)) queue.push([c.next, d + 1]);
      }
    }
    const overflow = depth.size ? Math.max(...depth.values()) + 1 : 0;
    const rows = new Map(); // column -> next free row
    for (const node of this.nodes) {
      const d = depth.get(node.id) ?? overflow;
      const row = rows.get(d) ?? 0;
      rows.set(d, row + 1);
      if (node.x == null || node.y == null) {
        node.x = 20 + d * (NODE_W + 70);
        node.y = 20 + row * (NODE_H + 46);
      }
    }
  }

  // --- DOM scaffold ---

  _render() {
    const doc = this.doc;
    this.el.textContent = '';
    this._fields = null;

    const bar = el(doc, 'div', 'npcq-graph-bar');
    const add = el(doc, 'button', 'npcq-mini', '+ node');
    add.addEventListener('click', () => this._addNode());
    bar.appendChild(add);
    bar.appendChild(el(doc, 'span', 'npcq-hint',
      'drag to pan · wheel zooms · drag a node to move it · double-click empty space for a new node'));
    this.el.appendChild(bar);

    this.canvas = el(doc, 'canvas', 'npcq-graph-canvas');
    this._bindCanvas(this.canvas);
    this.el.appendChild(this.canvas);

    this.card = el(doc, 'div');
    this.el.appendChild(this.card);
    this._renderCard();
    this._scheduleDraw();
  }

  _addNode(wx = null, wy = null) {
    this._sync();
    const id = this._freshId();
    const selNode = this._byId(this.sel);
    this.nodes.push({
      id,
      say: [],
      choices: [],
      x: wx ?? (selNode ? selNode.x + NODE_W + 70 : 20),
      y: wy ?? (selNode ? selNode.y : 20),
    });
    this.start ??= id;
    this.sel = id;
    this._touch();
    this._renderCard();
    this._scheduleDraw();
  }

  // --- canvas: input ---

  /** Mouse event -> world coordinates (pan/zoom undone). */
  _world(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - this.panX) / this.zoom,
      y: (e.clientY - rect.top - this.panY) / this.zoom,
    };
  }

  _hit(w) {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (w.x >= n.x && w.x <= n.x + NODE_W && w.y >= n.y && w.y <= n.y + NODE_H) return n;
    }
    return null;
  }

  _bindCanvas(canvas) {
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const w = this._world(e);
      const node = this._hit(w);
      if (node) {
        if (node.id !== this.sel) {
          this._sync();
          this.sel = node.id;
          this._renderCard();
        }
        this._drag = { mode: 'node', node, dx: w.x - node.x, dy: w.y - node.y, moved: false };
      } else {
        this._drag = { mode: 'pan', px: e.clientX, py: e.clientY };
      }
      const move = (ev) => this._onDragMove(ev);
      const up = () => {
        this.doc.removeEventListener('mousemove', move, true);
        this.doc.removeEventListener('mouseup', up, true);
        if (this._drag?.mode === 'node' && this._drag.moved) this._touch();
        this._drag = null;
        this._scheduleDraw();
      };
      this.doc.addEventListener('mousemove', move, true);
      this.doc.addEventListener('mouseup', up, true);
      this._scheduleDraw();
    });
    canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const w = this._world(e);
      if (!this._hit(w)) this._addNode(w.x - NODE_W / 2, w.y - NODE_H / 2);
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = Math.min(2.5, Math.max(0.4, this.zoom * factor));
      // Keep the point under the cursor anchored while zooming.
      this.panX = mx - ((mx - this.panX) / this.zoom) * next;
      this.panY = my - ((my - this.panY) / this.zoom) * next;
      this.zoom = next;
      this._scheduleDraw();
    }, { passive: false });
  }

  _onDragMove(e) {
    const d = this._drag;
    if (!d) return;
    if (d.mode === 'pan') {
      this.panX += e.clientX - d.px;
      this.panY += e.clientY - d.py;
      d.px = e.clientX;
      d.py = e.clientY;
    } else {
      const w = this._world(e);
      d.node.x = w.x - d.dx;
      d.node.y = w.y - d.dy;
      d.moved = true;
    }
    this._scheduleDraw();
  }

  // --- canvas: drawing ---

  /** Draw on the next frame — by then the panel is visible and the canvas
   *  has a real width (the F4 overlay is display:none while building). */
  _scheduleDraw() {
    const raf = this.doc.defaultView?.requestAnimationFrame;
    if (raf) raf(() => this._draw());
    else this._draw();
  }

  _draw() {
    const canvas = this.canvas;
    if (!canvas?.isConnected) return;
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return; // test DOMs have no 2d context — the map is cosmetic
    const dpr = this.doc.defaultView?.devicePixelRatio || 1;
    const w = canvas.clientWidth || 720;
    const h = CANVAS_H;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Dotted paper background, drifting with the pan.
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    const grid = 26 * this.zoom;
    if (grid > 7) {
      for (let gx = this.panX % grid; gx < w; gx += grid) {
        for (let gy = this.panY % grid; gy < h; gy += grid) {
          ctx.fillRect(gx, gy, 1, 1);
        }
      }
    }

    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);
    for (const node of this.nodes) this._drawEdges(ctx, node);
    for (const node of this.nodes) this._drawNode(ctx, node);
    ctx.restore();

    if (!this.nodes.length) {
      ctx.fillStyle = '#67718a';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No conversation yet — double-click to add the first node.', w / 2, h / 2);
      ctx.textAlign = 'left';
    }
  }

  /** Out port for choice i of n on a node's right edge. */
  _outPort(node, i, n) {
    return { x: node.x + NODE_W, y: node.y + (NODE_H * (i + 1)) / (n + 1) };
  }

  _drawEdges(ctx, node) {
    const n = node.choices.length;
    node.choices.forEach((choice, i) => {
      const from = this._outPort(node, i, n);
      const target = choice.next ? this._byId(choice.next) : null;
      ctx.strokeStyle = target ? '#4d5a70' : '#3a4252';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 1.4;
      if (target) {
        const to = { x: target.x, y: target.y + NODE_H / 2 };
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        if (target === node) {
          // Self-loop: swing out right and back into the left edge.
          ctx.bezierCurveTo(from.x + 70, from.y - 8, to.x - 70, to.y - NODE_H, to.x, to.y);
        } else {
          const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
          ctx.bezierCurveTo(from.x + dx, from.y, to.x - dx, to.y, to.x, to.y);
        }
        ctx.stroke();
        this._arrowhead(ctx, to.x, to.y, target === node ? Math.PI / 3 : 0);
      } else {
        // End stub: a short line into a ⏎ chip.
        const to = { x: from.x + 34, y: from.y };
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        ctx.strokeRect(to.x, to.y - 7, 14, 14);
        ctx.font = '9px sans-serif';
        ctx.fillText('⏎', to.x + 3, to.y + 3.5);
      }
      const label = choice.label.length > 20 ? `${choice.label.slice(0, 20)}…` : choice.label;
      if (label) {
        ctx.font = '10px sans-serif';
        ctx.fillStyle = '#8fa0b8';
        ctx.fillText(label, from.x + 6, from.y - 4);
      }
    });
  }

  _arrowhead(ctx, x, y, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-7, -4);
    ctx.lineTo(-7, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  _drawNode(ctx, node) {
    const selected = node.id === this.sel;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(node.x, node.y, NODE_W, NODE_H, 7);
    else ctx.rect(node.x, node.y, NODE_W, NODE_H);
    ctx.fillStyle = selected ? 'rgba(24,34,29,0.98)' : 'rgba(20,24,30,0.96)';
    ctx.fill();
    ctx.strokeStyle = selected ? '#55dd99' : '#3a3f47';
    ctx.lineWidth = selected ? 1.6 : 1;
    ctx.stroke();

    ctx.font = 'bold 10px sans-serif';
    ctx.fillStyle = node.id === this.start ? '#e8b45c' : '#8a93a4';
    ctx.fillText(`${node.id === this.start ? '▶ ' : ''}${node.id}`, node.x + 8, node.y + 14);

    const first = node.say[0] ?? '';
    ctx.font = '11px sans-serif';
    ctx.fillStyle = selected ? '#fff' : '#cdd3dd';
    const peek = first.length > 24 ? `${first.slice(0, 24)}…` : (first || '(nothing said)');
    ctx.fillText(peek, node.x + 8, node.y + 30);

    ctx.font = '9px sans-serif';
    ctx.fillStyle = '#67718a';
    const n = node.choices.length;
    ctx.fillText(n ? `${n} repl${n === 1 ? 'y' : 'ies'}` : 'ends → talk menu', node.x + 8, node.y + 45);
  }

  // --- the selected node's card ---

  _renderCard() {
    const doc = this.doc;
    this.card.textContent = '';
    this._fields = null;
    const node = this._byId(this.sel) ?? this.nodes[0];
    if (!node) return;
    this.sel = node.id;

    const card = el(doc, 'div', 'npcq-graph-node');
    this.card.appendChild(card);

    const head = el(doc, 'div', 'npcq-graph-nodehead');
    card.appendChild(head);
    head.appendChild(el(doc, 'span', 'npcq-graph-nodeid',
      `${node.id === this.start ? '▶ ' : ''}${node.id}`));
    if (node.id !== this.start) {
      const mkStart = el(doc, 'button', 'npcq-mini', '▶ make start');
      mkStart.title = 'The conversation opens with this node';
      mkStart.addEventListener('click', () => {
        this._sync();
        this.start = node.id;
        this._touch();
        this._renderCard();
        this._scheduleDraw();
      });
      head.appendChild(mkStart);
    }
    const del = el(doc, 'button', 'npcq-obj-remove', '✕');
    del.title = 'Delete this node — replies pointing here will end the conversation instead';
    del.addEventListener('click', () => {
      this._sync();
      this.nodes = this.nodes.filter((n) => n !== node);
      for (const n of this.nodes) {
        n.choices = n.choices.map((c) => (c.next === node.id ? { ...c, next: null } : c));
      }
      if (this.start === node.id) this.start = this.nodes[0]?.id ?? null;
      this.sel = this.start;
      this._touch();
      this._renderCard();
      this._scheduleDraw();
    });
    head.appendChild(del);

    card.appendChild(el(doc, 'div', 'npcq-hint', 'The NPC says — one line per row:'));
    const sayTa = el(doc, 'textarea');
    sayTa.rows = 4;
    sayTa.value = node.say.join('\n');
    sayTa.addEventListener('input', () => {
      this._sync();
      this._scheduleDraw(); // the map previews the first line
    });
    card.appendChild(sayTa);

    card.appendChild(el(doc, 'div', 'npcq-hint', 'Then the player picks a reply:'));
    const field = { node, sayTa, choiceRows: [] };
    this._fields = field;
    const nextOptions = () => [
      { value: END_VALUE, label: '⏎ end — back to the talk menu' },
      ...this.nodes.map((n) => ({ value: n.id, label: `→ ${n.id}` })),
    ];
    node.choices.forEach((choice, i) => {
      const row = el(doc, 'div', 'npcq-choice');
      const labelIn = el(doc, 'input');
      labelIn.type = 'text';
      labelIn.value = choice.label;
      labelIn.placeholder = 'the player’s reply';
      labelIn.addEventListener('input', () => {
        this._sync();
        this._scheduleDraw();
      });
      const nextSel = el(doc, 'select');
      for (const o of nextOptions()) {
        const opt = el(doc, 'option', '', o.label);
        opt.value = o.value;
        nextSel.appendChild(opt);
      }
      nextSel.value = choice.next && this._byId(choice.next) ? choice.next : END_VALUE;
      nextSel.addEventListener('change', () => {
        this._sync();
        this._touch();
        this._scheduleDraw();
      });
      const rm = el(doc, 'button', 'npcq-obj-remove', '✕');
      rm.title = 'Remove this reply';
      rm.addEventListener('click', () => {
        this._sync();
        node.choices.splice(i, 1);
        this._touch();
        this._renderCard();
        this._scheduleDraw();
      });
      row.append(labelIn, nextSel, rm);
      card.appendChild(row);
      field.choiceRows.push({ labelIn, nextSel });
    });
    if (!node.choices.length) {
      card.appendChild(el(doc, 'div', 'npcq-hint',
        'No replies — after its lines this node returns to the talk menu.'));
    }
    const addChoice = el(doc, 'button', 'npcq-entry npcq-add', '+ player reply');
    addChoice.addEventListener('click', () => {
      this._sync();
      node.choices.push({ label: '', next: null });
      this._touch();
      this._renderCard();
      this._scheduleDraw();
    });
    card.appendChild(addChoice);
  }
}
