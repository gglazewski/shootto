// WorldBrowser.js — the editor's world library: a tree browser over the
// server's map/worlds/ directory for saving, loading and organizing worlds
// (campaign levels, splash-screen scenes, sandboxes).
//
// The modal shows the library as an indented tree. Folders collapse/expand
// and act as save targets (the selected folder receives "Save here" and new
// folders); worlds load on click and can be renamed inline, moved by
// drag-and-drop onto a folder (or the heading for the root), and deleted with
// the same two-step confirm the catalogues use. All filesystem work happens
// through injected callbacks, so this class is DOM-only and server-agnostic.

import { closeX } from './closeX.js';

/** Group a flat /api/worlds listing into a nested tree for rendering.
 *  @param {Array<{path:string,type:string,size?:number,mtime?:number}>} entries
 *  @returns {Array} nodes: {name, path, type, children?} sorted folders-first */
export function treeify(entries) {
  const root = { children: new Map() };
  const nodeFor = (path, type) => {
    const parts = path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLeaf = i === parts.length - 1;
      if (!cur.children.has(name)) {
        cur.children.set(name, {
          name,
          path: parts.slice(0, i + 1).join('/'),
          type: isLeaf ? type : 'folder',
          children: new Map(),
        });
      }
      cur = cur.children.get(name);
    }
    return cur;
  };
  for (const e of entries) {
    const node = nodeFor(e.path, e.type);
    if (e.type === 'world') Object.assign(node, { size: e.size, mtime: e.mtime });
  }
  const finish = (node) => {
    const kids = [...node.children.values()].map(finish);
    kids.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
    return { ...node, children: kids };
  };
  return finish(root).children;
}

export class WorldBrowser {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} deps.container  the modal root (#world-browser)
   * @param {object} deps.callbacks
   *   { list(): Promise<entries|null>, load(path), save(path): Promise<bool>,
   *     remove(path): Promise<bool>, move(from,to): Promise<bool>,
   *     mkdir(path): Promise<bool>, saveState(state): Promise<bool> }
   */
  constructor({ doc = document, container, callbacks }) {
    this.doc = doc;
    this.container = container;
    this.cb = callbacks;
    this.onClose = null;
    // Which library world is open survives reloads via the editor-state file
    // (map/editor.json) — restored in App.restore(); F8 splash capture and
    // "Save here" depend on it.
    this._currentPath = null;
    this._selectedFolder = ''; // '' = root
    this._collapsed = new Set();
    this._entries = [];

    const panel = container.querySelector('.panel');
    panel.innerHTML = '';

    this.head = doc.createElement('h2');
    this.head.textContent = 'World Catalogue';
    this.count = doc.createElement('span');
    this.count.className = 'cat-count';
    this.head.appendChild(this.count);
    panel.appendChild(this.head);
    panel.appendChild(closeX(doc, () => this.hide()));
    // Dropping a world on the heading moves it to the root.
    this._dropTarget(this.head, '');

    const bar = doc.createElement('div');
    bar.className = 'cat-bar';
    this.nameInput = doc.createElement('input');
    this.nameInput.className = 'cat-search';
    this.nameInput.placeholder = 'world name…';
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._saveAs();
    });
    bar.appendChild(this.nameInput);
    this._mkBtn(bar, 'Save here', () => this._saveAs(), 'Save the current world into the selected folder');
    this._mkBtn(bar, 'New folder', () => this._newFolder(), 'Create a folder inside the selected one');
    panel.appendChild(bar);

    this.status = doc.createElement('div');
    this.status.className = 'wb-status';
    panel.appendChild(this.status);

    this.tree = doc.createElement('div');
    this.tree.className = 'wb-tree';
    panel.appendChild(this.tree);

    this.empty = doc.createElement('div');
    this.empty.className = 'inv-hint';
    panel.appendChild(this.empty);

    const close = doc.createElement('button');
    close.className = 'cat-btn cat-close';
    close.textContent = 'Close';
    close.addEventListener('click', () => this.hide());
    panel.appendChild(close);

    container.addEventListener('click', (e) => {
      if (e.target === container) this.hide();
    });

    this._onKey = (e) => {
      if (!this.isOpen || /^F\d+$/.test(e.key)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      }
      e.stopPropagation(); // the editor underneath must not see shortcuts
    };

    this.hide();
  }

  _mkBtn(parent, label, fn, title = '') {
    const b = this.doc.createElement('button');
    b.className = 'cat-btn';
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', fn);
    parent.appendChild(b);
    return b;
  }

  async refresh() {
    const entries = await this.cb.list();
    this._serverless = entries == null;
    this._entries = entries ?? [];
    this._render();
  }

  show() {
    this.container.classList.add('open');
    this.doc.addEventListener('keydown', this._onKey, true);
    this.refresh();
  }

  hide() {
    const wasOpen = this.isOpen;
    this.container.classList.remove('open');
    this.doc.removeEventListener('keydown', this._onKey, true);
    if (wasOpen && this.onClose) this.onClose();
  }

  toggle() {
    if (this.isOpen) this.hide();
    else this.show();
  }

  get isOpen() {
    return this.container.classList.contains('open');
  }

  /** Library path of the world currently open in the editor, or null. */
  get currentPath() {
    return this._currentPath;
  }

  set currentPath(path) {
    this._currentPath = path;
    // Persisted file-side (map/editor.json) so reloads remember the open
    // world without any browser storage.
    this.cb.saveState?.({ currentPath: path ?? null });
  }

  /** Restore the remembered path from the editor-state file without
   *  writing it back (used by App.restore). */
  adoptCurrentPath(path) {
    this._currentPath = path ?? null;
  }

  // --- actions ---

  /** Destination folder for saves/new folders: the selected folder (if it
   *  still exists), else the root. */
  _destFolder() {
    const sel = this._selectedFolder;
    if (!sel) return '';
    return this._entries.some((e) => e.type === 'folder' && e.path === sel) ? sel : '';
  }

  async _saveAs() {
    const name = this._cleanName(this.nameInput.value);
    if (!name) return;
    const folder = this._destFolder();
    const path = `${folder ? folder + '/' : ''}${name}.json`;
    if (await this.cb.save(path)) {
      this.currentPath = path;
      this.nameInput.value = '';
      this.refresh();
    }
  }

  async _newFolder() {
    const name = this._cleanName(this.nameInput.value);
    if (!name) return;
    const folder = this._destFolder();
    if (await this.cb.mkdir(`${folder ? folder + '/' : ''}${name}`)) {
      this.nameInput.value = '';
      this.refresh();
    }
  }

  /** Strip a typed name down to a safe library segment. */
  _cleanName(raw) {
    return (raw ?? '').trim().replace(/\.json$/i, '').replace(/[\\/:]/g, '-').replace(/^\.+/, '');
  }

  async _move(from, toFolder) {
    const name = from.split('/').pop();
    const to = `${toFolder ? toFolder + '/' : ''}${name}`;
    if (to === from) return;
    if (await this.cb.move(from, to)) {
      if (this.currentPath === from) this.currentPath = to;
      else if (this.currentPath?.startsWith(from + '/')) {
        this.currentPath = to + this.currentPath.slice(from.length);
      }
      this.refresh();
    }
  }

  async _rename(node, newName) {
    const name = this._cleanName(newName);
    if (!name) return this._render();
    const dir = node.path.split('/').slice(0, -1).join('/');
    const leaf = node.type === 'world' ? `${name}.json` : name;
    const to = `${dir ? dir + '/' : ''}${leaf}`;
    if (to !== node.path && await this.cb.move(node.path, to)) {
      if (this.currentPath === node.path) this.currentPath = to;
      else if (this.currentPath?.startsWith(node.path + '/')) {
        this.currentPath = to + this.currentPath.slice(node.path.length);
      }
    }
    this.refresh();
  }

  _dropTarget(el, folderPath) {
    el.addEventListener('dragover', (e) => {
      if (this._dragging == null) return;
      e.preventDefault();
      el.classList.add('wb-drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('wb-drop'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('wb-drop');
      if (this._dragging == null) return;
      e.preventDefault();
      const from = this._dragging;
      this._dragging = null;
      // No moving a folder into itself or its own subtree.
      if (folderPath === from || folderPath.startsWith(from + '/')) return;
      this._move(from, folderPath);
    });
  }

  // --- rendering ---

  _render() {
    this.tree.innerHTML = '';
    const worlds = this._entries.filter((e) => e.type === 'world');
    this.count.textContent = `${worlds.length}`;
    this.status.textContent = this.currentPath
      ? `Current world: worlds/${this.currentPath}`
      : 'Current world is not saved in the library yet';

    if (this._serverless) {
      this.empty.textContent = 'World library needs the dev server — run `npm run server` and open http://localhost:4173';
    } else if (!this._entries.length) {
      this.empty.textContent = 'No worlds yet — name one above and press “Save here”';
    }
    this.empty.style.display = this._entries.length ? 'none' : '';

    const renderLevel = (nodes, depth, parent) => {
      for (const node of nodes) {
        parent.appendChild(this._row(node, depth));
        if (node.type === 'folder' && !this._collapsed.has(node.path)) {
          renderLevel(node.children, depth + 1, parent);
        }
      }
    };
    renderLevel(treeify(this._entries), 0, this.tree);
  }

  _row(node, depth) {
    const doc = this.doc;
    const row = doc.createElement('div');
    row.className = `wb-row wb-${node.type}`;
    row.style.paddingLeft = `${10 + depth * 18}px`;
    if (node.type === 'world' && node.path === this.currentPath) row.classList.add('current');
    if (node.type === 'folder' && node.path === this._destFolder() && this._selectedFolder) {
      row.classList.add('selected');
    }

    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      this._dragging = node.path;
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => { this._dragging = null; });
    if (node.type === 'folder') this._dropTarget(row, node.path);

    const label = doc.createElement('span');
    label.className = 'wb-name';
    label.textContent = node.type === 'folder'
      ? `${this._collapsed.has(node.path) ? '▸' : '▾'} ${node.name}`
      : node.name.replace(/\.json$/, '');
    row.appendChild(label);

    if (node.type === 'world') {
      const meta = doc.createElement('span');
      meta.className = 'wb-meta';
      meta.textContent = node.mtime ? new Date(node.mtime).toLocaleDateString() : '';
      row.appendChild(meta);
    }

    const actions = doc.createElement('span');
    actions.className = 'wb-actions';
    if (node.type === 'world') {
      this._mkBtn(actions, 'Load', (e) => {
        e.stopPropagation();
        this.currentPath = node.path;
        this.cb.load(node.path);
        this.hide();
      });
      this._mkBtn(actions, 'Save', async (e) => {
        e.stopPropagation();
        if (await this.cb.save(node.path)) {
          this.currentPath = node.path;
          this.refresh();
        }
      }, 'Overwrite this world with the one open in the editor');
    }
    this._mkBtn(actions, 'Ren', (e) => {
      e.stopPropagation();
      this._startRename(row, label, node);
    }, 'Rename');

    let armed = null;
    const del = this._mkBtn(actions, 'Del', async (e) => {
      e.stopPropagation();
      if (armed) {
        clearTimeout(armed);
        armed = null;
        if (await this.cb.remove(node.path)) {
          if (this.currentPath === node.path || this.currentPath?.startsWith(node.path + '/')) {
            this.currentPath = null;
          }
          this.refresh();
        }
        return;
      }
      del.textContent = 'Sure?';
      del.classList.add('armed');
      armed = setTimeout(() => {
        armed = null;
        del.textContent = 'Del';
        del.classList.remove('armed');
      }, 2500);
    });
    del.classList.add('danger');
    row.appendChild(actions);

    row.addEventListener('click', () => {
      if (node.type === 'folder') {
        // First click selects as save target; clicking the selected folder
        // toggles collapse, so both gestures stay one-click.
        if (this._selectedFolder === node.path) {
          if (this._collapsed.has(node.path)) this._collapsed.delete(node.path);
          else this._collapsed.add(node.path);
        }
        this._selectedFolder = node.path;
        this._render();
      } else {
        this.currentPath = node.path;
        this.cb.load(node.path);
        this.hide();
      }
    });
    return row;
  }

  _startRename(row, label, node) {
    const input = this.doc.createElement('input');
    input.className = 'cat-search wb-rename';
    input.value = node.type === 'world' ? node.name.replace(/\.json$/, '') : node.name;
    label.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const done = (commit) => {
      if (finished) return; // Enter commits, then the removal blurs — once only
      finished = true;
      if (commit && input.value.trim()) this._rename(node, input.value);
      else this._render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      else if (e.key === 'Escape') done(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => done(false));
    input.addEventListener('click', (e) => e.stopPropagation());
  }
}
