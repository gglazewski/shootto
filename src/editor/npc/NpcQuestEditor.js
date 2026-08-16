// NpcQuestEditor.js — the F4 panel: author NPCs and their questlines.
//
// A modal overlay with two tabs working directly against the NpcRegistry and
// QuestRegistry:
//   NPCs   — define characters in collapsible sections: identity, the
//            first-meeting chit-chat + greeting, lore topics, an optional
//            small-talk dialogue tree, and services (repair, craft).
//   Quests — per NPC giver, an ordered chain of quest tiers. The sidebar
//            draws the chain (how each tier starts: offered in dialogue or
//            auto-started) with reorder controls. The form proper is:
//            an always-visible header (tier tag, the title field, and the
//            FLOW strip — start/end segmented controls inline in the run
//            preview), then collapsible sections below (Objectives,
//            Dialogue, Rewards, Flags), and a sticky footer (Save / Delete)
//            that never scrolls away. Section collapses are pure DOM
//            toggles — no re-render, so typed text survives them — while
//            structural changes re-render off a whole-tier draft that
//            _syncDraft keeps fed from every field.
//
// The panel builds its own DOM into document.body (styles live in
// index.html). Every mutation calls onChange() so the App can persist the
// registries and refresh anything derived (markers, tool state).

import { MOB_SKINS } from '../../game/mobSprites.js';
import { listMobs } from '../../engine/mobTypes.js';
import { listAmmoTypes } from '../../engine/AmmoTypes.js';
import {
  listNpcs, getNpc, registerNpc, removeNpc, NPC_SERVICE_TYPES,
} from '../../engine/NpcRegistry.js';
import {
  getQuestline, setQuestline, normalizeQuest,
} from '../../engine/QuestRegistry.js';
import { listEquipItems } from '../../engine/EquipmentRegistry.js';
import { buildItemSwatch } from '../items/itemSwatch.js';
import { DialogueGraphEditor } from './DialogueGraphEditor.js';

/** textarea (one entry per line) -> string[] */
function splitLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Topics textarea -> [{label, lines}]. Blocks are separated by blank lines;
 *  a block's first line is the player's question, the rest is the answer. */
function splitTopics(text) {
  return String(text ?? '')
    .split(/\n\s*\n/)
    .map((block) => {
      const ls = splitLines(block);
      return ls.length >= 2 ? { label: ls[0], lines: ls.slice(1) } : null;
    })
    .filter(Boolean);
}

/** [{label, lines}] -> the textarea text splitTopics parses back. */
function topicsToText(topics) {
  return (topics ?? []).map((t) => [t.label, ...t.lines].join('\n')).join('\n\n');
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class NpcQuestEditor {
  /**
   * @param {object} deps
   * @param {Document} deps.doc
   * @param {() => void} deps.onChange  fired after any registry mutation
   */
  constructor({ doc, onChange }) {
    this.doc = doc;
    this.onChange = onChange ?? (() => {});
    this.tab = 'npcs'; // 'npcs' | 'quests'
    this.npcId = listNpcs()[0]?.id ?? null; // NPC selected in the NPCs tab
    this.giverId = this.npcId; // giver selected in the Quests tab
    this.tierIndex = 0;
    this.onClose = null;
    /** Set by the App: called with a receiver fn; the next world click hands
     *  it the picked cell (slay-pack spawn point selection). */
    this.onPickSpawn = null;
    /** Set by the App: called with (cells, receiver); the App enters area
     *  paint mode (LMB toggles top faces, RMB finishes) and hands the final
     *  cell list back (visit objective area selection). */
    this.onPickArea = null;
    /** Working copy of the selected tier's objectives — structural edits
     *  (add/remove/type switch) re-render the form without touching the
     *  registry until Save. Keyed so switching tiers re-seeds it. */
    this._draftObjectives = [];
    this._draftFor = null;
    /** Working copy of the whole tier form (scalars, rewards, flags) — see
     *  _syncDraft; same draftFor key as the objectives above. */
    this._draftTier = null;
    /** Live field refs _syncDraft reads (Quests tab only, per render). */
    this._f = null;
    /** Ids of the collapsible sections standing open (per tab). */
    this._open = new Set(['objectives', 'dialogue']);
    this._openTab = 'quests';
    /** Unsaved edits in the tier form (see _markDirty / _confirmDiscard). */
    this._dirty = false;

    this.root = el(doc, 'div', 'npcq-overlay');
    this.root.id = 'npcq-editor';
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root && this._confirmDiscard()) this.close();
    });
    // While the panel is open it owns the keyboard (same convention as
    // DoorModal): capture-phase stop so fly keys and tool shortcuts never
    // reach the editor, no matter what inside the panel holds focus — a
    // clicked tab or Save button must not let W fly the camera. Typing still
    // lands in the fields (stopPropagation doesn't cancel the default
    // action); Escape and F4 close the panel.
    this._onKey = (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape' || e.key === 'F4') {
        e.preventDefault();
        if (this._confirmDiscard()) this.close();
      }
      e.stopPropagation();
    };
    this.panel = el(doc, 'div', 'npcq-panel');
    this.root.appendChild(this.panel);
    doc.body.appendChild(this.root);
    this._render();
  }

  // --- open/close ---

  get isOpen() {
    return this.root.classList.contains('open');
  }

  open() {
    this._dirty = false;
    // The panel is built at App start, when the registry still holds the
    // built-in roster — a world load may swap it since. Revalidate the
    // selection: land on the first listed NPC instead of a stale id (or a
    // blank "new character" form).
    const npcs = listNpcs();
    if (!npcs.some((n) => n.id === this.npcId)) this.npcId = npcs[0]?.id ?? null;
    if (!npcs.some((n) => n.id === this.giverId)) this.giverId = this.npcId;
    this._render();
    this.root.classList.add('open');
    this.doc.addEventListener('keydown', this._onKey, true);
  }

  close() {
    this.doc.removeEventListener('keydown', this._onKey, true);
    this.root.classList.remove('open');
    this.onClose?.();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
    return this.isOpen;
  }

  dispose() {
    this.doc.removeEventListener('keydown', this._onKey, true);
    this.root.remove();
  }

  // --- rendering ---

  _render() {
    const doc = this.doc;
    this.panel.textContent = '';

    const head = el(doc, 'div', 'npcq-head');
    const title = el(doc, 'div', 'npcq-title', 'NPC & Quest Editor');
    const tabs = el(doc, 'div', 'npcq-tabs');
    for (const [id, label] of [['npcs', 'NPCs'], ['quests', 'Quests']]) {
      const b = el(doc, 'button', this.tab === id ? 'active' : '', label);
      b.addEventListener('click', () => {
        if (this.tab === id || !this._confirmDiscard()) return;
        this.tab = id;
        this._render();
      });
      tabs.appendChild(b);
    }
    const close = el(doc, 'button', 'npcq-close', '✕');
    close.addEventListener('click', () => {
      if (this._confirmDiscard()) this.close();
    });
    head.append(title, tabs, close);
    this.panel.appendChild(head);

    const body = el(doc, 'div', 'npcq-body');
    this.panel.appendChild(body);
    // Which collapsible sections stand open (ids from _section calls). The
    // set survives re-renders (Save must not snap the form shut) and is
    // reseeded only when the tab itself changes.
    if (this._openTab !== this.tab) {
      this._openTab = this.tab;
      this._open = this.tab === 'npcs'
        ? new Set(['identity'])
        : new Set(['objectives', 'dialogue']);
    }
    if (this.tab === 'npcs') this._renderNpcs(body);
    else this._renderQuests(body);
  }

  _row(parent, label, control) {
    const row = el(this.doc, 'div', 'npcq-row');
    row.appendChild(el(this.doc, 'label', 'npcq-label', label));
    row.appendChild(control);
    parent.appendChild(row);
    return control;
  }

  _input(value, type = 'text') {
    const input = el(this.doc, 'input');
    input.type = type;
    input.value = value ?? '';
    if (type === 'number') input.step = 'any';
    return input;
  }

  _select(options, value) {
    const select = el(this.doc, 'select');
    for (const o of options) {
      const opt = el(this.doc, 'option', '', o.label);
      opt.value = o.value;
      select.appendChild(opt);
    }
    select.value = value ?? options[0]?.value ?? '';
    return select;
  }

  _textarea(linesArr, rows = 4) {
    const ta = el(this.doc, 'textarea');
    ta.rows = rows;
    ta.value = (linesArr ?? []).join('\n');
    return ta;
  }

  /** Flag unsaved edits in the tier form; Save (or a pick commit) clears it. */
  _markDirty() {
    this._dirty = true;
    this._saveBtn?.classList.add('dirty');
  }

  /** True when it's safe to navigate away from the tier form — asks the
   *  author when unsaved edits would be lost. */
  _confirmDiscard() {
    if (!this._dirty) return true;
    const ok = this.doc.defaultView?.confirm('Discard unsaved changes to this quest tier?') ?? true;
    if (ok) this._dirty = false;
    return ok;
  }

  /** Titled form section box — collapsible: the title row is a toggle that
   *  hides the section body with a mere class flip (NO re-render, so typed
   *  text survives). Open-state is remembered per section id across renders
   *  (this._open); the default set is seeded per tab on render.
   *  @returns {HTMLElement} the section BODY — append fields here */
  _section(parent, id, title, hint) {
    const doc = this.doc;
    const sec = el(doc, 'div', 'npcq-section');
    const head = el(doc, 'button', 'npcq-section-head');
    head.type = 'button';
    head.appendChild(el(doc, 'span', 'npcq-chev', '▸'));
    head.appendChild(el(doc, 'span', 'npcq-section-title', title));
    const badge = el(doc, 'span', 'npcq-section-badge');
    head.appendChild(badge);
    head.addEventListener('click', () => {
      const collapsed = sec.classList.toggle('collapsed');
      if (collapsed) this._open.delete(id);
      else this._open.add(id);
    });
    if (!this._open.has(id)) sec.classList.add('collapsed');
    sec.appendChild(head);
    const body = el(doc, 'div', 'npcq-section-body');
    if (hint) body.appendChild(el(doc, 'div', 'npcq-hint', hint));
    sec.appendChild(body);
    parent.appendChild(sec);
    return body;
  }

  /** The always-visible action bar under a form: Save (and Delete when there
   *  is something to delete) never scroll away. */
  _foot(parent) {
    const foot = el(this.doc, 'div', 'npcq-foot');
    parent.appendChild(foot);
    return foot;
  }

  /** Segmented switch — a radio group styled as adjoining buttons.
   *  @returns {{el: HTMLElement, value: () => string}} */
  _segmented(options, value, onChange) {
    const wrap = el(this.doc, 'div', 'npcq-seg');
    let current = value;
    for (const o of options) {
      const b = el(this.doc, 'button', current === o.value ? 'active' : '', o.label);
      if (o.title) b.title = o.title;
      b.addEventListener('click', () => {
        if (current === o.value) return;
        current = o.value;
        for (const child of wrap.children) child.classList.toggle('active', child === b);
        onChange?.(current);
      });
      wrap.appendChild(b);
    }
    return { el: wrap, value: () => current };
  }

  /** Copy every form field back into the tier draft, so a structural
   *  re-render (add/remove objective, type switch) or a later commit sees
   *  exactly what's on screen — nothing typed gets dropped. */
  _syncDraft() {
    for (const b of this._objBlocks ?? []) {
      const o = b.o;
      o.type = b.typeSel.value;
      if (b.targetSel) o.target = b.targetSel.value;
      if (b.kindsIn) o.kinds = splitLines(b.kindsIn.value.replaceAll(',', '\n'));
      if (b.idsPicker) o.ids = b.idsPicker.value();
      if (b.countIn) o.count = b.countIn.value;
      if (b.nounIn) o.noun = b.nounIn.value;
    }
    // The dialogue trees ride the same draft so structural re-renders
    // (add/remove objective) keep their unsaved edits too.
    if (this._aboutEd) this._draftAbout = this._aboutEd.snapshot();
    if (this._debriefEd) this._draftDebrief = this._debriefEd.snapshot();
    // The scalar fields (only present while the Quests tab is rendered).
    const f = this._f;
    if (!f || !this._draftTier) return;
    const d = this._draftTier;
    d.title = f.titleIn.value;
    d.autoAccept = f.startSeg.value() === 'auto';
    d.autoComplete = f.endSeg.value() === 'auto';
    d.offerPrompt = f.offerPromptIn.value;
    d.offer = f.offerTa.value;
    d.progressLine = f.progressIn.value;
    d.turninPrompt = f.turninPromptIn.value;
    d.ready = f.readyTa.value;
    if (f.epilogueTa) d.epilogue = f.epilogueTa.value;
    d.startReward = {
      health: f.sHealthIn.value, armor: f.sArmorIn.value,
      ammoType: f.sAmmoSel.value, ammoAmount: f.sAmmoAmountIn.value,
      items: f.startItems.value(),
    };
    d.reward = {
      health: f.healthIn.value, armor: f.armorIn.value,
      ammoType: f.ammoSel.value, ammoAmount: f.ammoAmountIn.value,
      items: f.rewardItems.value(),
    };
    d.acceptFlags = f.acceptFlagsIn.value;
    d.completeFlags = f.completeFlagsIn.value;
  }

  /** One objective's editor block: type selector plus the fields that type
   *  needs. Field values sync back into the draft object `o` via _syncDraft;
   *  structural changes re-render the whole form.
   *  @returns {object} the field record _syncDraft and commit read */
  _renderObjective(parent, o, i, doCommit) {
    const doc = this.doc;
    const box = el(doc, 'div', 'npcq-objective');
    parent.appendChild(box);
    const head = el(doc, 'div', 'npcq-obj-head');
    box.appendChild(head);
    head.appendChild(el(doc, 'span', 'npcq-obj-n', `#${i + 1}`));
    const typeSel = this._select([
      { value: 'kill', label: 'Kill mobs' },
      { value: 'collect', label: 'Collect pickups' },
      { value: 'visit', label: 'Visit an area' },
    ], o.type ?? 'kill');
    head.appendChild(typeSel);
    typeSel.addEventListener('change', () => {
      this._syncDraft(); // reads the new type off the selector
      this._render();
    });
    if (this._draftObjectives.length > 1) {
      const rm = el(doc, 'button', 'npcq-obj-remove', '✕');
      rm.title = 'Remove this objective';
      rm.addEventListener('click', () => {
        this._markDirty();
        this._syncDraft();
        this._draftObjectives.splice(i, 1);
        this._render();
      });
      head.appendChild(rm);
    }

    const block = { o, typeSel };
    const type = o.type ?? 'kill';
    if (type === 'kill') {
      block.targetSel = this._row(box, 'Target', this._select(
        [{ value: 'any', label: 'Any mob' }, ...listMobs().map((m) => ({ value: m.id, label: m.name }))],
        o.target ?? 'any',
      ));
      const spawnWrap = el(doc, 'div', 'npcq-spawn');
      const spawnLabel = el(doc, 'span', 'npcq-spawn-label',
        o.spawnCell ? `cell ${o.spawnCell.join(', ')}` : 'none — kills count anywhere');
      const pickBtn = el(doc, 'button', '', 'Select spawn');
      pickBtn.title = 'Saves this tier, then click a block in the world — the pack spawns there when the quest starts';
      const clearBtn = el(doc, 'button', '', 'Clear');
      spawnWrap.append(spawnLabel, pickBtn, clearBtn);
      this._row(box, 'Slay spawn', spawnWrap);
      pickBtn.addEventListener('click', () => {
        if (!this.onPickSpawn || !doCommit()) return;
        this.onPickSpawn(this._writeObjective(i, (obj, cell) => ({ ...obj, spawnCell: cell })));
      });
      clearBtn.addEventListener('click', () => {
        o.spawnCell = null;
        doCommit();
      });
    } else if (type === 'collect') {
      block.kindsIn = this._row(box, 'Kinds', this._input((o.kinds ?? []).join(', ')));
      block.kindsIn.placeholder = 'ammo, armor — empty = any pickup';
      block.idsPicker = this._itemPicker(box, o.ids ?? [],
        'Exact items to fetch — any pick overrides the kinds above:', () => this._markDirty());
    } else {
      // visit: the area is painted in the world (top faces, yellow overlay).
      const areaWrap = el(doc, 'div', 'npcq-spawn');
      const n = (o.cells ?? []).length;
      const areaLabel = el(doc, 'span', 'npcq-spawn-label',
        n ? `${n} top face${n === 1 ? '' : 's'} marked` : 'no area marked yet');
      const markBtn = el(doc, 'button', '', 'Mark area');
      markBtn.title = 'Saves this tier, then paint voxel top faces in the world — LMB toggles a face, RMB finishes';
      const clearBtn = el(doc, 'button', '', 'Clear');
      areaWrap.append(areaLabel, markBtn, clearBtn);
      this._row(box, 'Area', areaWrap);
      markBtn.addEventListener('click', () => {
        if (!this.onPickArea || !doCommit()) return;
        this.onPickArea([...(o.cells ?? [])], this._writeObjective(i, (obj, cells) => ({ ...obj, cells })));
      });
      clearBtn.addEventListener('click', () => {
        o.cells = [];
        doCommit();
      });
    }
    if (type !== 'visit') {
      block.countIn = this._row(box, 'Count', this._input(o.count ?? 3, 'number'));
    }
    block.nounIn = this._row(box, 'Noun (HUD)', this._input(o.noun ?? ''));
    block.nounIn.placeholder = type === 'visit' ? 'cellar reached…' : 'zombies / supplies…';
    return block;
  }

  /** Receiver factory for the App's world-pick modes: writes the picked value
   *  into objective `i` of the saved tier (commit ran right before the pick
   *  started), then re-renders off the registry. */
  _writeObjective(i, apply) {
    const giver = this.giverId;
    const index = this.tierIndex;
    return (value) => {
      const line = getQuestline(giver);
      if (!line[index]) return;
      const objectives = line[index].objectives.map((obj, j) => (j === i ? apply(obj, value) : obj));
      line[index] = { ...line[index], objectives };
      setQuestline(giver, line);
      this._draftFor = null; // draft re-seeds from the updated registry
      this.onChange();
      this._render();
    };
  }

  /** Multi-select grid of equip-registry items (swatch + name): used for the
   *  reward item grants and the collect objective's item ids. Ids that are
   *  selected but no longer registered keep a placeholder card so editing a
   *  tier never silently drops them.
   *  @param {HTMLElement} parent
   *  @param {string[]} selected  currently picked item ids
   *  @param {string} hint  the line above the grid
   *  @param {() => void} [onToggle]  fired when a pick is toggled
   *  @returns {{el: HTMLElement, value: () => string[]}} */
  _itemPicker(parent, selected, hint, onToggle) {
    const doc = this.doc;
    const chosen = new Set(selected ?? []);
    const known = listEquipItems();
    const missing = [...chosen]
      .filter((id) => !known.some((i) => i.id === id))
      .map((id) => ({ id, name: id, missing: true }));
    const cards = [...known, ...missing];

    const wrap = el(doc, 'div', 'npcq-picker');
    wrap.appendChild(el(doc, 'div', 'npcq-hint', hint));
    parent.appendChild(wrap);
    // No cards means the registry is empty *and* nothing was picked before.
    if (!cards.length) {
      wrap.appendChild(el(doc, 'div', 'npcq-hint', 'No items in the equipment registry yet — build one with F3.'));
      return { el: wrap, value: () => [] };
    }
    const grid = el(doc, 'div', 'npcq-items');
    for (const item of cards) {
      const card = el(doc, 'button', `npcq-item${chosen.has(item.id) ? ' active' : ''}${item.missing ? ' missing' : ''}`);
      card.title = item.missing ? `${item.id} — no longer in the registry` : item.id;
      if (item.missing) card.appendChild(el(doc, 'div', 'npcq-item-gap', '?'));
      else card.appendChild(buildItemSwatch(item, 40));
      card.appendChild(el(doc, 'span', 'npcq-item-name', item.name ?? item.id));
      card.addEventListener('click', () => {
        if (chosen.has(item.id)) chosen.delete(item.id);
        else chosen.add(item.id);
        card.classList.toggle('active', chosen.has(item.id));
        onToggle?.();
      });
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
    return { el: wrap, value: () => [...chosen] };
  }

  // --- NPCs tab ---

  _renderNpcs(body) {
    const doc = this.doc;
    const list = el(doc, 'div', 'npcq-list');
    const form = el(doc, 'div', 'npcq-form');
    body.append(list, form);
    const scroll = el(doc, 'div', 'npcq-scroll');
    form.appendChild(scroll);
    // Any typing in the form area flags the NPC dirty for the discard guard.
    scroll.addEventListener('input', () => this._markDirty());

    for (const def of listNpcs()) {
      const entry = el(doc, 'button', `npcq-entry${def.id === this.npcId ? ' active' : ''}`, `${def.name} (${def.id})`);
      entry.addEventListener('click', () => {
        this.npcId = def.id;
        this._render();
      });
      list.appendChild(entry);
    }
    const add = el(doc, 'button', 'npcq-entry npcq-add', '+ New NPC');
    add.addEventListener('click', () => {
      this.npcId = null;
      this._render();
    });
    list.appendChild(add);

    const existing = this.npcId ? getNpc(this.npcId) : null;

    // --- Identity ---
    const secId = this._section(scroll, 'identity', existing ? `Identity — ${existing.name}` : 'Identity — new character');
    const idIn = this._row(secId, 'Id', this._input(existing?.id ?? ''));
    idIn.placeholder = 'lowercase-with-dashes';
    idIn.disabled = !!existing; // ids are identity — placed spawns reference them
    const nameIn = this._row(secId, 'Name', this._input(existing?.name ?? ''));
    const skinSel = this._row(secId, 'Skin', this._select(MOB_SKINS.map((s) => ({ value: s, label: s })), existing?.skin));
    const heightIn = this._row(secId, 'Height (m)', this._input(existing?.height ?? 1.65, 'number'));

    // --- First meeting ---
    const secMeet = this._section(scroll, 'meet', 'First meeting',
      'Chit-chat — one line per row, played when the player first talks to this character:');
    const dialogTa = this._textarea(existing?.dialog, 8);
    secMeet.appendChild(dialogTa);
    const greetIn = this._row(secMeet, 'Greeting', this._input(existing?.greeting ?? ''));
    greetIn.placeholder = 'opens every later talk — "Hello again." when empty';

    // --- Lore topics ---
    const secTopics = this._section(scroll, 'topics', 'Lore topics',
      'Blocks separated by a blank line; block’s first row is the player’s question, the rest is the answer:');
    const topicsTa = this._textarea(null, 10);
    topicsTa.value = topicsToText(existing?.topics);
    topicsTa.placeholder = 'What happened here?\nNobody rightly knows, love.\nOne day the sirens went...\n\nWho are you?\nJust an old woman minding her tea.';
    secTopics.appendChild(topicsTa);

    // --- Small talk ---
    const secChat = this._section(scroll, 'chat', 'Small talk',
      'An optional branching conversation the player can open from the talk menu:');
    const chatPromptIn = this._row(secChat, 'Player asks', this._input(existing?.chat?.prompt ?? ''));
    chatPromptIn.placeholder = '“Can we talk?” when empty';
    const chatEd = new DialogueGraphEditor({ doc, graph: existing?.chat ?? null });
    secChat.appendChild(chatEd.el);

    // --- Services ---
    const secSvc = this._section(scroll, 'services', 'Services',
      'Repair restores worn melee weapons; craft opens the NPC’s workbench (bench-quality crafting — no homemade wear). ' +
      'The signal gates the talk option: a game flag name ' +
      '(raised e.g. by a quest on accept/complete, "!name" inverts), blank = always offered:');
    const svc = (type) => (existing?.services ?? []).find((s) => s.type === type) ?? null;
    const existingRepair = svc('repair');
    const repairChk = this._input('', 'checkbox');
    repairChk.checked = !!existingRepair;
    this._row(secSvc, 'Offers repair', repairChk);
    const repairLabelIn = this._row(secSvc, 'Player asks', this._input(existingRepair?.label ?? ''));
    repairLabelIn.placeholder = `“${NPC_SERVICE_TYPES.repair.label}” when empty`;
    const repairFlagIn = this._row(secSvc, 'Signal', this._input(existingRepair?.flag ?? ''));
    repairFlagIn.placeholder = 'e.g. workshop-open — blank = always';

    const existingCraft = svc('craft');
    const craftChk = this._input('', 'checkbox');
    craftChk.checked = !!existingCraft;
    this._row(secSvc, 'Offers crafting', craftChk);
    const craftLabelIn = this._row(secSvc, 'Player asks', this._input(existingCraft?.label ?? ''));
    craftLabelIn.placeholder = `“${NPC_SERVICE_TYPES.craft.label}” when empty`;
    const craftFlagIn = this._row(secSvc, 'Signal', this._input(existingCraft?.flag ?? ''));
    craftFlagIn.placeholder = 'e.g. workshop-open — blank = always';

    const foot = this._foot(form);
    const save = el(doc, 'button', 'primary', existing ? 'Save NPC' : 'Create NPC');
    save.addEventListener('click', () => {
      const def = registerNpc({
        id: existing?.id ?? idIn.value.trim(),
        name: nameIn.value,
        skin: skinSel.value,
        height: heightIn.value,
        dialog: splitLines(dialogTa.value),
        greeting: greetIn.value,
        topics: splitTopics(topicsTa.value),
        chat: (() => {
          const g = chatEd.value();
          return g ? { ...g, prompt: chatPromptIn.value } : null;
        })(),
        services: [
          ...(repairChk.checked ? [{ type: 'repair', label: repairLabelIn.value, flag: repairFlagIn.value }] : []),
          ...(craftChk.checked ? [{ type: 'craft', label: craftLabelIn.value, flag: craftFlagIn.value }] : []),
        ],
      });
      if (!def) {
        idIn.classList.add('invalid');
        return;
      }
      this.npcId = def.id;
      this.giverId ??= def.id;
      this.onChange();
      this._render();
    });
    foot.appendChild(save);
    if (existing) {
      const del = el(doc, 'button', 'danger', 'Delete NPC');
      del.addEventListener('click', () => {
        const ok = doc.defaultView?.confirm(
          `Delete NPC "${existing.name}"? Its questline and any placed spawns go with it.`) ?? true;
        if (!ok) return;
        removeNpc(existing.id);
        setQuestline(existing.id, []); // its questline goes with it
        this.npcId = listNpcs()[0]?.id ?? null;
        if (this.giverId === existing.id) this.giverId = this.npcId;
        this.onChange();
        this._render();
      });
      foot.appendChild(del);
    }
  }

  // --- Quests tab ---

  /** Terse "what to do" line for a tier card in the chain list. */
  static _tierSummary(q) {
    return (q.objectives ?? []).map((o) => {
      if (o.type === 'collect') return `collect ${o.count}`;
      if (o.type === 'visit') return 'visit area';
      return `kill ${o.count}`;
    }).join(' · ');
  }

  /** The chain sidebar: one card per tier, with a connector label above each
   *  spelling out how it begins (offered in dialogue vs auto-started), and
   *  move up/down controls on the selected card. */
  _renderTierList(side, tiers) {
    const doc = this.doc;
    tiers.forEach((q, i) => {
      const auto = !!q.autoAccept;
      const chained = auto && !!tiers[i - 1]?.autoComplete;
      const label = i === 0
        ? (auto ? '▶ starts at game start' : '▶ offered in dialogue')
        : chained ? '⚡ chains instantly'
          : auto ? '⚡ auto-starts after turn-in'
            : '↓ offered in dialogue';
      side.appendChild(el(doc, 'div', `npcq-link${auto ? ' auto' : ''}`, label));

      const active = i === this.tierIndex && !this._newTier;
      const card = el(doc, 'div', `npcq-tier${active ? ' active' : ''}`);
      card.appendChild(el(doc, 'div', 'npcq-tier-title', `${i + 1}. ${q.title}`));
      const meta = el(doc, 'div', 'npcq-tier-meta');
      meta.appendChild(el(doc, 'span', '', NpcQuestEditor._tierSummary(q)));
      if (q.autoComplete) {
        const flag = el(doc, 'span', 'npcq-tier-flag', '⚡ instant');
        flag.title = 'Completes in the field — no turn-in conversation';
        meta.appendChild(flag);
      }
      card.appendChild(meta);
      if (active && tiers.length > 1) {
        const actions = el(doc, 'div', 'npcq-tier-actions');
        for (const [text, delta, tip] of [['↑ up', -1, 'Move earlier in the chain'], ['↓ down', 1, 'Move later in the chain']]) {
          const b = el(doc, 'button', 'npcq-mini', text);
          b.title = tip;
          b.disabled = i + delta < 0 || i + delta >= tiers.length;
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            this._moveTier(i, delta);
          });
          actions.appendChild(b);
        }
        card.appendChild(actions);
      }
      card.addEventListener('click', () => {
        if (active || !this._confirmDiscard()) return;
        this._newTier = false;
        this.tierIndex = i;
        this._render();
      });
      side.appendChild(card);
    });
  }

  /** Swap a tier with its neighbor; the selection follows the moved tier. */
  _moveTier(i, delta) {
    const tiers = getQuestline(this.giverId);
    const j = i + delta;
    if (j < 0 || j >= tiers.length || !this._confirmDiscard()) return;
    const next = [...tiers];
    [next[i], next[j]] = [next[j], next[i]];
    setQuestline(this.giverId, next);
    this.tierIndex = j;
    this._draftFor = null; // the slot under the cursor changed — reseed
    this.onChange();
    this._render();
  }

  /** First unused `${giver}-N` tier id — deletions leave gaps, so scan. */
  _freshTierId(tiers) {
    let n = tiers.length + 1;
    while (tiers.some((t) => t.id === `${this.giverId}-${n}`)) n += 1;
    return `${this.giverId}-${n}`;
  }

  _renderQuests(body) {
    const doc = this.doc;
    const npcs = listNpcs();
    if (!npcs.length) {
      body.appendChild(el(doc, 'div', 'npcq-hint', 'Create an NPC first — quests need a giver.'));
      return;
    }
    if (!npcs.some((n) => n.id === this.giverId)) this.giverId = npcs[0].id;

    const side = el(doc, 'div', 'npcq-list');
    const form = el(doc, 'div', 'npcq-form');
    body.append(side, form);

    const giverSel = this._select(npcs.map((n) => ({ value: n.id, label: n.name })), this.giverId);
    giverSel.className = 'npcq-giver';
    giverSel.addEventListener('change', () => {
      if (!this._confirmDiscard()) {
        giverSel.value = this.giverId; // put the selection back
        return;
      }
      this.giverId = giverSel.value;
      this.tierIndex = 0;
      this._newTier = false;
      this._render();
    });
    side.appendChild(giverSel);

    const tiers = getQuestline(this.giverId);
    if (this.tierIndex >= tiers.length) this.tierIndex = Math.max(0, tiers.length - 1);
    this._renderTierList(side, tiers);
    const add = el(doc, 'button', `npcq-entry npcq-add${this._newTier ? ' active' : ''}`, '+ Add tier');
    add.addEventListener('click', () => {
      if (this._newTier || !this._confirmDiscard()) return;
      this._newTier = true;
      this._render();
    });
    side.appendChild(add);

    const quest = this._newTier ? null : tiers[this.tierIndex] ?? null;
    const isLast = this._newTier || this.tierIndex === tiers.length - 1;

    // --- the whole-tier draft ---
    // The draft is a working copy of EVERYTHING the form edits: scalar fields
    // too, not just objectives — so a structural re-render (add/remove
    // objective, type switch) or a section collapse never drops typed text.
    // Switching tiers/givers re-seeds it from the registry.
    const draftKey = `${this.giverId}:${this._newTier ? 'new' : this.tierIndex}`;
    if (this._draftFor !== draftKey) {
      this._draftFor = draftKey;
      this._draftObjectives = quest?.objectives?.length
        ? JSON.parse(JSON.stringify(quest.objectives))
        : [{ type: 'kill', target: 'any', count: 3, noun: '' }];
      this._draftAbout = quest?.about ? JSON.parse(JSON.stringify(quest.about)) : null;
      this._draftDebrief = quest?.debrief ? JSON.parse(JSON.stringify(quest.debrief)) : null;
      const r = (x) => ({ health: x?.health ?? 0, armor: x?.armor ?? 0, ammoType: x?.ammo?.type ?? '', ammoAmount: x?.ammo?.amount ?? 0, items: [...(x?.items ?? [])] });
      this._draftTier = {
        title: quest?.title ?? '',
        autoAccept: !!quest?.autoAccept,
        autoComplete: !!quest?.autoComplete,
        offer: (quest?.offer ?? []).join('\n'),
        offerPrompt: quest?.offerPrompt ?? '',
        progressLine: quest?.progressLine ?? 'How goes it? {n} of {count} so far.',
        ready: (quest?.ready ?? []).join('\n'),
        turninPrompt: quest?.turninPrompt ?? '',
        epilogue: (quest?.epilogue ?? []).join('\n'),
        startReward: r(quest?.startReward),
        reward: r(quest?.reward),
        acceptFlags: (quest?.flags?.accept ?? []).join(', '),
        completeFlags: (quest?.flags?.complete ?? []).join(', '),
      };
    }
    const d = this._draftTier;
    // Field refs _syncDraft reads back into the draft before re-renders.
    this._f = {};

    // --- header: title + flow, always visible ---
    const head = el(doc, 'div', 'npcq-formhead');
    form.appendChild(head);
    head.appendChild(el(doc, 'div', 'npcq-tier-tag', this._newTier ? `NEW — becomes #${tiers.length + 1}` : `TIER ${this.tierIndex + 1} / ${tiers.length}`));
    const titleIn = this._input(d.title);
    titleIn.className = 'npcq-title-input';
    titleIn.placeholder = 'quest title — shown in the HUD quest log';
    head.appendChild(titleIn);
    const flowBar = el(doc, 'div', 'npcq-flowbar');
    head.appendChild(flowBar);
    const startSeg = this._segmented([
      { value: 'talk', label: 'Offered in dialogue', title: 'The giver pitches it; the player accepts in conversation' },
      { value: 'auto', label: 'Starts by itself', title: 'Begins the moment it unlocks (previous tier done, or game start) — the offer conversation never plays' },
    ], d.autoAccept ? 'auto' : 'talk', () => applyFlow(true));
    const endSeg = this._segmented([
      { value: 'talk', label: 'Turned in', title: 'The player returns to hand the job in; the reward is paid in conversation' },
      { value: 'auto', label: 'On the spot', title: 'Finishes in the field the moment every objective is met — reward granted immediately, no turn-in conversation' },
    ], d.autoComplete ? 'auto' : 'talk', () => applyFlow(true));
    const chipEl = (text, isAuto) => el(doc, 'span', `npcq-chip${isAuto ? ' auto' : ''}`, text);
    const arrowEl = () => el(doc, 'span', 'npcq-flow-arrow', '→');
    const first = this._newTier ? tiers.length === 0 : this.tierIndex === 0;
    flowBar.append(
      chipEl(first ? 'game start' : 'previous tier done'),
      arrowEl(),
      startSeg.el,
      arrowEl(),
      chipEl('objectives'),
      arrowEl(),
      endSeg.el,
      arrowEl(),
      chipEl('reward'),
    );
    head.appendChild(el(doc, 'div', 'npcq-hint',
      'Chain tip: "On the spot" followed by a tier that "Starts by itself" plays as one continuous story beat.'));

    const scroll = el(doc, 'div', 'npcq-scroll');
    form.appendChild(scroll);
    // Any typing in the form area makes the tier dirty; Save (or a pick-flow
    // commit) clears it, and navigation asks before discarding.
    scroll.addEventListener('input', () => this._markDirty());

    /** Late-bound so objective-block handlers can call the commit defined
     *  below (clicks happen long after this render pass). */
    const doCommit = () => commit();

    // --- objectives (multi-goal) ---
    const objSec = this._section(scroll, 'objectives', 'Objectives',
      'The quest is fulfilled only when ALL of them are met.');
    const objWrap = el(doc, 'div', 'npcq-objectives');
    objSec.appendChild(objWrap);
    const objBadge = objSec.closest('.npcq-section').querySelector('.npcq-section-badge');
    this._objBlocks = [];
    this._draftObjectives.forEach((o, i) => {
      this._objBlocks.push(this._renderObjective(objWrap, o, i, doCommit));
    });
    objBadge.textContent = `${this._draftObjectives.length} goal${this._draftObjectives.length === 1 ? '' : 's'}`;
    const addObj = el(doc, 'button', 'npcq-entry npcq-add', '+ Add objective');
    addObj.addEventListener('click', () => {
      this._markDirty();
      this._syncDraft();
      this._draftObjectives.push({ type: 'kill', target: 'any', count: 3, noun: '' });
      this._render();
    });
    objWrap.appendChild(addObj);

    // --- dialogue ---
    const secDlg = this._section(scroll, 'dialogue', 'Dialogue');
    const offerGroup = el(doc, 'div', 'npcq-subgroup');
    secDlg.appendChild(offerGroup);
    offerGroup.appendChild(el(doc, 'div', 'npcq-subtitle', 'Offer'));
    offerGroup.appendChild(el(doc, 'div', 'npcq-skipnote',
      'Never plays — this tier starts by itself. The lines are kept in case you switch back.'));
    const offerPromptIn = this._row(offerGroup, 'Player asks', this._input(d.offerPrompt));
    offerPromptIn.placeholder = '"Do you need help?" when empty';
    offerGroup.appendChild(el(doc, 'div', 'npcq-hint',
      'The giver’s pitch — one line per row; the player then picks "I’ll do it" to accept:'));
    const offerTa = this._textarea(null, 5);
    offerTa.value = d.offer;
    offerGroup.appendChild(offerTa);

    const progressIn = this._row(secDlg, 'Progress line', this._input(d.progressLine));
    progressIn.placeholder = 'mid-quest talk — may use {n} and {count}';

    const aboutGroup = el(doc, 'div', 'npcq-subgroup');
    secDlg.appendChild(aboutGroup);
    aboutGroup.appendChild(el(doc, 'div', 'npcq-subtitle', 'About the quest — dialogue tree'));
    aboutGroup.appendChild(el(doc, 'div', 'npcq-hint',
      'Optional. While the quest is active, “About …” plays this branching, replayable conversation instead of the single progress line. Lines may use {n} and {count}.'));
    this._aboutEd = new DialogueGraphEditor({
      doc,
      graph: this._draftAbout,
      onDirty: () => this._markDirty(),
    });
    aboutGroup.appendChild(this._aboutEd.el);

    const turninGroup = el(doc, 'div', 'npcq-subgroup');
    secDlg.appendChild(turninGroup);
    turninGroup.appendChild(el(doc, 'div', 'npcq-subtitle', 'Turn-in'));
    turninGroup.appendChild(el(doc, 'div', 'npcq-skipnote',
      'Never plays — this tier completes on the spot. The lines are kept in case you switch back.'));
    const turninPromptIn = this._row(turninGroup, 'Player reports', this._input(d.turninPrompt));
    turninPromptIn.placeholder = '"It’s done." when empty';
    turninGroup.appendChild(el(doc, 'div', 'npcq-hint',
      'The giver’s thanks — picking the report line pays the reward:'));
    const readyTa = this._textarea(null, 5);
    readyTa.value = d.ready;
    turninGroup.appendChild(readyTa);
    turninGroup.appendChild(el(doc, 'div', 'npcq-hint',
      'Debrief — optional dialogue tree: when authored, it plays instead of the thanks lines above once the job is handed in — the giver can ask what happened and the player picks their account of it. The reward is already paid when it starts.'));
    this._debriefEd = new DialogueGraphEditor({
      doc,
      graph: this._draftDebrief,
      onDirty: () => this._markDirty(),
    });
    turninGroup.appendChild(this._debriefEd.el);

    let epilogueTa = null;
    if (isLast) {
      secDlg.appendChild(el(doc, 'div', 'npcq-hint',
        'Epilogue (last tier only) — idle talk once the whole questline is finished:'));
      epilogueTa = this._textarea(null, 3);
      epilogueTa.value = d.epilogue;
      secDlg.appendChild(epilogueTa);
    }

    // --- rewards (starting gear + completion reward) ---
    const secReward = this._section(scroll, 'rewards', 'Rewards');
    const startGroup = el(doc, 'div', 'npcq-subgroup');
    secReward.appendChild(startGroup);
    startGroup.appendChild(el(doc, 'div', 'npcq-subtitle', 'Starting gear'));
    startGroup.appendChild(el(doc, 'div', 'npcq-hint',
      'Handed over the moment the quest starts — accepted in dialogue or auto-started. Equip the player for the job (say, a baseball bat to go scout the area).'));
    const startGrid = el(doc, 'div', 'npcq-reward-grid');
    startGroup.appendChild(startGrid);
    const sHealthIn = this._row(startGrid, 'Health', this._input(d.startReward.health, 'number'));
    const sArmorIn = this._row(startGrid, 'Armor', this._input(d.startReward.armor, 'number'));
    const sAmmoSel = this._row(startGrid, 'Ammo', this._select(
      [{ value: '', label: 'None' }, ...listAmmoTypes().map((a) => ({ value: a.id, label: a.name }))],
      d.startReward.ammoType,
    ));
    const sAmmoAmountIn = this._row(startGrid, 'Rounds', this._input(d.startReward.ammoAmount, 'number'));
    const startItems = this._itemPicker(startGroup, d.startReward.items,
      'Starting items — they fly over from the giver the moment the quest begins:', () => this._markDirty());

    const rewardGroup = el(doc, 'div', 'npcq-subgroup');
    secReward.appendChild(rewardGroup);
    rewardGroup.appendChild(el(doc, 'div', 'npcq-subtitle', 'Completion reward'));
    const rewardHint = el(doc, 'div', 'npcq-hint', '');
    rewardGroup.appendChild(rewardHint);
    const rewardGrid = el(doc, 'div', 'npcq-reward-grid');
    rewardGroup.appendChild(rewardGrid);
    const healthIn = this._row(rewardGrid, 'Health', this._input(d.reward.health, 'number'));
    const armorIn = this._row(rewardGrid, 'Armor', this._input(d.reward.armor, 'number'));
    const ammoSel = this._row(rewardGrid, 'Ammo', this._select(
      [{ value: '', label: 'None' }, ...listAmmoTypes().map((a) => ({ value: a.id, label: a.name }))],
      d.reward.ammoType,
    ));
    const ammoAmountIn = this._row(rewardGrid, 'Rounds', this._input(d.reward.ammoAmount, 'number'));
    const rewardItems = this._itemPicker(rewardGroup, d.reward.items,
      'Item grants — pick any number; they fly over from the giver:', () => this._markDirty());

    // --- flags (action/reaction) ---
    const secFlags = this._section(scroll, 'flags', 'Flags',
      'Game flags this tier raises — anything listening reacts (a door whose “Unlocks when flag” names one clicks open). Comma-separate several; prefix ! to clear a flag instead.');
    const acceptFlagsIn = this._row(secFlags, 'On accept', this._input(d.acceptFlags));
    acceptFlagsIn.placeholder = 'e.g. cellar-open';
    const completeFlagsIn = this._row(secFlags, 'On complete', this._input(d.completeFlags));
    completeFlagsIn.placeholder = 'e.g. bridge-down, !cellar-open';

    // Field refs for _syncDraft (everything above, minus the pickers which
    // expose .value() instead of .value).
    this._f = {
      titleIn, startSeg, endSeg, offerPromptIn, offerTa, progressIn,
      turninPromptIn, readyTa, epilogueTa,
      sHealthIn, sArmorIn, sAmmoSel, sAmmoAmountIn, startItems,
      healthIn, armorIn, ammoSel, ammoAmountIn, rewardItems,
      acceptFlagsIn, completeFlagsIn,
    };

    /** Dim the conversations the chosen flow skips; a user-driven change
     *  also marks the tier dirty. */
    const applyFlow = (fromUser) => {
      if (fromUser) this._markDirty();
      const startAuto = startSeg.value() === 'auto';
      const endAuto = endSeg.value() === 'auto';
      offerGroup.classList.toggle('npcq-dim', startAuto);
      turninGroup.classList.toggle('npcq-dim', endAuto);
      rewardHint.textContent = endAuto
        ? 'Granted in the field the moment the last objective is met.'
        : 'Paid by the giver at turn-in.';
    };
    applyFlow(false);

    const foot = this._foot(form);
    const save = el(doc, 'button', `primary${this._dirty ? ' dirty' : ''}`, this._newTier ? 'Add tier' : 'Save tier');
    this._saveBtn = save;
    /** Build the tier from the draft (synced first) and store it.
     *  @returns quest|null */
    const commit = () => {
      this._syncDraft();
      const dd = this._draftTier;
      const built = normalizeQuest({
        id: quest?.id ?? this._freshTierId(tiers),
        title: dd.title,
        objectives: this._draftObjectives,
        autoAccept: dd.autoAccept,
        autoComplete: dd.autoComplete,
        offer: splitLines(dd.offer),
        offerPrompt: dd.offerPrompt,
        progressLine: dd.progressLine,
        ready: splitLines(dd.ready),
        turninPrompt: dd.turninPrompt,
        epilogue: epilogueTa ? splitLines(dd.epilogue) : quest?.epilogue,
        about: this._aboutEd.value(),
        debrief: this._debriefEd.value(),
        startReward: {
          health: dd.startReward.health,
          armor: dd.startReward.armor,
          ammo: { type: dd.startReward.ammoType, amount: dd.startReward.ammoAmount },
          items: dd.startReward.items,
        },
        reward: {
          health: dd.reward.health,
          armor: dd.reward.armor,
          ammo: { type: dd.reward.ammoType, amount: dd.reward.ammoAmount },
          items: dd.reward.items,
        },
        flags: { accept: dd.acceptFlags, complete: dd.completeFlags },
      }, this.giverId);
      if (!built) return null;
      const next = [...tiers];
      if (this._newTier) next.push(built);
      else next[this.tierIndex] = built;
      setQuestline(this.giverId, next);
      if (this._newTier) this.tierIndex = next.length - 1;
      this._newTier = false;
      this._dirty = false;
      this._draftFor = null; // re-seed the draft from the stored, normalized tier
      this.onChange();
      this._render();
      return built;
    };
    save.addEventListener('click', () => commit());
    foot.appendChild(save);
    if (quest) {
      const del = el(doc, 'button', 'danger', 'Delete tier');
      del.addEventListener('click', () => {
        if (!(doc.defaultView?.confirm(`Delete tier ${this.tierIndex + 1} — "${quest.title}"?`) ?? true)) return;
        const next = tiers.filter((_, i) => i !== this.tierIndex);
        setQuestline(this.giverId, next);
        this.tierIndex = Math.max(0, this.tierIndex - 1);
        this._dirty = false;
        this._draftFor = null; // another tier slides into this slot — reseed
        this.onChange();
        this._render();
      });
      foot.appendChild(del);
    }
  }
}
