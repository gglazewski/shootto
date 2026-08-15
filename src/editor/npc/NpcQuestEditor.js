// NpcQuestEditor.js — the F4 panel: author NPCs and their questlines.
//
// A modal overlay with two tabs working directly against the NpcRegistry and
// QuestRegistry:
//   NPCs   — define characters: id, display name, skin (drawn character
//            sheet), height, the first-meeting chit-chat, the return-visit
//            greeting, and lore topics the player can ask about.
//   Quests — per NPC giver, an ordered chain of quest tiers. The sidebar
//            draws the chain (how each tier starts: offered in dialogue or
//            auto-started) with reorder controls; the form groups a tier
//            into sections — title, objectives (kill / collect / visit),
//            flow & chaining (the autoAccept/autoComplete flags as start/end
//            choices), the conversations the flow keeps, and the reward.
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

  /** Titled form section box. @returns {HTMLElement} the section container */
  _section(parent, title, hint) {
    const sec = el(this.doc, 'div', 'npcq-section');
    sec.appendChild(el(this.doc, 'div', 'npcq-section-title', title));
    if (hint) sec.appendChild(el(this.doc, 'div', 'npcq-hint', hint));
    parent.appendChild(sec);
    return sec;
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

  /** Copy the objective form fields back into the draft objects, so a
   *  structural re-render (add/remove/type switch) keeps what was typed. */
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
    const idIn = this._row(form, 'Id', this._input(existing?.id ?? ''));
    idIn.placeholder = 'lowercase-with-dashes';
    idIn.disabled = !!existing; // ids are identity — placed spawns reference them
    const nameIn = this._row(form, 'Name', this._input(existing?.name ?? ''));
    const skinSel = this._row(form, 'Skin', this._select(MOB_SKINS.map((s) => ({ value: s, label: s })), existing?.skin));
    const heightIn = this._row(form, 'Height (m)', this._input(existing?.height ?? 1.65, 'number'));
    form.appendChild(el(doc, 'div', 'npcq-hint', 'Chit-chat — one line per row, played on first meeting:'));
    const dialogTa = this._textarea(existing?.dialog, 8);
    form.appendChild(dialogTa);
    const greetIn = this._row(form, 'Greeting', this._input(existing?.greeting ?? ''));
    greetIn.placeholder = 'opens every later talk — "Hello again." when empty';
    form.appendChild(el(doc, 'div', 'npcq-hint',
      'Lore topics — blocks separated by a blank line; block’s first row is the player’s question, the rest is the answer:'));
    const topicsTa = this._textarea(null, 10);
    topicsTa.value = topicsToText(existing?.topics);
    topicsTa.placeholder = 'What happened here?\nNobody rightly knows, love.\nOne day the sirens went...\n\nWho are you?\nJust an old woman minding her tea.';
    form.appendChild(topicsTa);

    form.appendChild(el(doc, 'div', 'npcq-hint',
      'Small talk — an optional branching conversation the player can open from the talk menu:'));
    const chatPromptIn = this._row(form, 'Player asks', this._input(existing?.chat?.prompt ?? ''));
    chatPromptIn.placeholder = '“Can we talk?” when empty';
    const chatEd = new DialogueGraphEditor({ doc, graph: existing?.chat ?? null });
    form.appendChild(chatEd.el);

    form.appendChild(el(doc, 'div', 'npcq-hint',
      'Services — repair restores worn melee weapons. The signal gates the talk option: a game flag name ' +
      '(raised e.g. by a quest on accept/complete, "!name" inverts), blank = always offered:'));
    const existingRepair = (existing?.services ?? []).find((s) => s.type === 'repair') ?? null;
    const repairChk = this._input('', 'checkbox');
    repairChk.checked = !!existingRepair;
    this._row(form, 'Offers repair', repairChk);
    const repairLabelIn = this._row(form, 'Player asks', this._input(existingRepair?.label ?? ''));
    repairLabelIn.placeholder = `“${NPC_SERVICE_TYPES.repair.label}” when empty`;
    const repairFlagIn = this._row(form, 'Signal', this._input(existingRepair?.flag ?? ''));
    repairFlagIn.placeholder = 'e.g. workshop-open — blank = always';

    const buttons = el(doc, 'div', 'npcq-buttons');
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
        services: repairChk.checked
          ? [{ type: 'repair', label: repairLabelIn.value, flag: repairFlagIn.value }]
          : [],
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
    buttons.appendChild(save);
    if (existing) {
      const del = el(doc, 'button', 'danger', 'Delete NPC');
      del.addEventListener('click', () => {
        removeNpc(existing.id);
        setQuestline(existing.id, []); // its questline goes with it
        this.npcId = listNpcs()[0]?.id ?? null;
        if (this.giverId === existing.id) this.giverId = this.npcId;
        this.onChange();
        this._render();
      });
      buttons.appendChild(del);
    }
    form.appendChild(buttons);
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
    // Any typing in the form makes the tier dirty; Save (or a pick-flow
    // commit) clears it, and navigation asks before discarding.
    form.addEventListener('input', () => this._markDirty());

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

    // --- the tier ---
    const secTier = this._section(form, this._newTier
      ? `New tier — becomes #${tiers.length + 1}`
      : `Tier ${this.tierIndex + 1} of ${tiers.length}`);
    const titleIn = this._row(secTier, 'Title', this._input(quest?.title ?? ''));
    titleIn.placeholder = 'shown in the HUD quest log';

    // --- objectives (multi-goal) ---
    // The draft is a working copy of the tier's objectives: field edits sync
    // back on every structural change and on Save; switching tiers re-seeds.
    const draftKey = `${this.giverId}:${this._newTier ? 'new' : this.tierIndex}`;
    if (this._draftFor !== draftKey) {
      this._draftFor = draftKey;
      this._draftObjectives = quest?.objectives?.length
        ? JSON.parse(JSON.stringify(quest.objectives))
        : [{ type: 'kill', target: 'any', count: 3, noun: '' }];
      this._draftAbout = quest?.about ? JSON.parse(JSON.stringify(quest.about)) : null;
      this._draftDebrief = quest?.debrief ? JSON.parse(JSON.stringify(quest.debrief)) : null;
    }
    /** Late-bound so objective-block handlers can call the commit defined
     *  below (clicks happen long after this render pass). */
    const doCommit = () => commit();
    const secObj = this._section(form, 'Objectives',
      'The quest is fulfilled only when ALL of them are met.');
    const objWrap = el(doc, 'div', 'npcq-objectives');
    secObj.appendChild(objWrap);
    this._objBlocks = [];
    this._draftObjectives.forEach((o, i) => {
      this._objBlocks.push(this._renderObjective(objWrap, o, i, doCommit));
    });
    const addObj = el(doc, 'button', 'npcq-entry npcq-add', '+ Add objective');
    addObj.addEventListener('click', () => {
      this._markDirty();
      this._syncDraft();
      this._draftObjectives.push({ type: 'kill', target: 'any', count: 3, noun: '' });
      this._render();
    });
    objWrap.appendChild(addObj);

    // --- flow & chaining ---
    // The autoAccept/autoComplete flags surface as start/end choices; the
    // dialogue groups below dim to match, and the strip previews the run.
    const secFlow = this._section(form, 'Flow & chaining');
    const startSeg = this._segmented([
      { value: 'talk', label: 'Offered in dialogue', title: 'The giver pitches it; the player accepts in conversation' },
      { value: 'auto', label: 'Starts by itself', title: 'Begins the moment it unlocks (previous tier done, or game start) — the offer conversation never plays' },
    ], quest?.autoAccept ? 'auto' : 'talk', () => applyFlow(true));
    this._row(secFlow, 'Starts', startSeg.el);
    const endSeg = this._segmented([
      { value: 'talk', label: 'Turned in to the giver', title: 'The player returns to hand the job in; the reward is paid in conversation' },
      { value: 'auto', label: 'Completes on the spot', title: 'Finishes in the field the moment every objective is met — reward granted immediately, no turn-in conversation' },
    ], quest?.autoComplete ? 'auto' : 'talk', () => applyFlow(true));
    this._row(secFlow, 'Ends', endSeg.el);
    const flowStrip = el(doc, 'div', 'npcq-flow');
    secFlow.appendChild(flowStrip);
    secFlow.appendChild(el(doc, 'div', 'npcq-hint',
      'Chain tip: "completes on the spot" followed by a tier that "starts by itself" plays as one continuous story beat.'));

    // --- dialogue ---
    const secDlg = this._section(form, 'Dialogue');
    const offerGroup = el(doc, 'div', 'npcq-subgroup');
    secDlg.appendChild(offerGroup);
    offerGroup.appendChild(el(doc, 'div', 'npcq-subtitle', 'Offer'));
    offerGroup.appendChild(el(doc, 'div', 'npcq-skipnote',
      'Never plays — this tier starts by itself. The lines are kept in case you switch back.'));
    const offerPromptIn = this._row(offerGroup, 'Player asks', this._input(quest?.offerPrompt ?? ''));
    offerPromptIn.placeholder = '"Do you need help?" when empty';
    offerGroup.appendChild(el(doc, 'div', 'npcq-hint',
      'The giver’s pitch — one line per row; the player then picks "I’ll do it" to accept:'));
    const offerTa = this._textarea(quest?.offer, 5);
    offerGroup.appendChild(offerTa);

    const progressIn = this._row(secDlg, 'Progress line', this._input(quest?.progressLine ?? 'How goes it? {n} of {count} so far.'));
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
    const turninPromptIn = this._row(turninGroup, 'Player reports', this._input(quest?.turninPrompt ?? ''));
    turninPromptIn.placeholder = '"It’s done." when empty';
    turninGroup.appendChild(el(doc, 'div', 'npcq-hint',
      'The giver’s thanks — picking the report line pays the reward:'));
    const readyTa = this._textarea(quest?.ready, 5);
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
      epilogueTa = this._textarea(quest?.epilogue, 3);
      secDlg.appendChild(epilogueTa);
    }

    // --- starting gear ---
    const sr = quest?.startReward ?? {};
    const secStart = this._section(form, 'Starting gear',
      'Handed over the moment the quest starts — accepted in dialogue or auto-started. Equip the player for the job (say, a baseball bat to go scout the area).');
    const startGrid = el(doc, 'div', 'npcq-reward-grid');
    secStart.appendChild(startGrid);
    const sHealthIn = this._row(startGrid, 'Health', this._input(sr.health ?? 0, 'number'));
    const sArmorIn = this._row(startGrid, 'Armor', this._input(sr.armor ?? 0, 'number'));
    const sAmmoSel = this._row(startGrid, 'Ammo', this._select(
      [{ value: '', label: 'None' }, ...listAmmoTypes().map((a) => ({ value: a.id, label: a.name }))],
      sr.ammo?.type ?? '',
    ));
    const sAmmoAmountIn = this._row(startGrid, 'Rounds', this._input(sr.ammo?.amount ?? 0, 'number'));
    const startItems = this._itemPicker(secStart, sr.items ?? [],
      'Starting items — they fly over from the giver the moment the quest begins:', () => this._markDirty());

    // --- reward ---
    const r = quest?.reward ?? {};
    const secReward = this._section(form, 'Reward');
    const rewardHint = el(doc, 'div', 'npcq-hint', '');
    secReward.appendChild(rewardHint);
    const rewardGrid = el(doc, 'div', 'npcq-reward-grid');
    secReward.appendChild(rewardGrid);
    const healthIn = this._row(rewardGrid, 'Health', this._input(r.health ?? 0, 'number'));
    const armorIn = this._row(rewardGrid, 'Armor', this._input(r.armor ?? 0, 'number'));
    const ammoSel = this._row(rewardGrid, 'Ammo', this._select(
      [{ value: '', label: 'None' }, ...listAmmoTypes().map((a) => ({ value: a.id, label: a.name }))],
      r.ammo?.type ?? '',
    ));
    const ammoAmountIn = this._row(rewardGrid, 'Rounds', this._input(r.ammo?.amount ?? 0, 'number'));
    const rewardItems = this._itemPicker(secReward, r.items ?? [],
      'Item grants — pick any number; they fly over from the giver:', () => this._markDirty());

    // --- flags (action/reaction) ---
    const secFlags = this._section(form, 'Flags',
      'Game flags this tier raises — anything listening reacts (a door whose “Unlocks when flag” names one clicks open). Comma-separate several; prefix ! to clear a flag instead.');
    const acceptFlagsIn = this._row(secFlags, 'On accept', this._input((quest?.flags?.accept ?? []).join(', ')));
    acceptFlagsIn.placeholder = 'e.g. cellar-open';
    const completeFlagsIn = this._row(secFlags, 'On complete', this._input((quest?.flags?.complete ?? []).join(', ')));
    completeFlagsIn.placeholder = 'e.g. bridge-down, !cellar-open';

    /** Dim the conversations the chosen flow skips and redraw the preview
     *  strip; a user-driven change also marks the tier dirty. */
    const chipEl = (text, isAuto) => el(doc, 'span', `npcq-chip${isAuto ? ' auto' : ''}`, text);
    const arrowEl = () => el(doc, 'span', 'npcq-flow-arrow', '→');
    const applyFlow = (fromUser) => {
      if (fromUser) this._markDirty();
      const startAuto = startSeg.value() === 'auto';
      const endAuto = endSeg.value() === 'auto';
      offerGroup.classList.toggle('npcq-dim', startAuto);
      turninGroup.classList.toggle('npcq-dim', endAuto);
      rewardHint.textContent = endAuto
        ? 'Granted in the field the moment the last objective is met.'
        : 'Paid by the giver at turn-in.';
      flowStrip.textContent = '';
      const first = this._newTier ? tiers.length === 0 : this.tierIndex === 0;
      flowStrip.append(
        chipEl(first ? 'game start' : 'previous tier done'),
        arrowEl(),
        chipEl(startAuto ? 'starts by itself' : 'offer conversation', startAuto),
        arrowEl(),
        chipEl('objectives'),
        arrowEl(),
        chipEl(endAuto ? 'completes in the field' : 'turn-in conversation', endAuto),
        arrowEl(),
        chipEl('reward'),
      );
    };
    applyFlow(false);

    const buttons = el(doc, 'div', 'npcq-buttons');
    const save = el(doc, 'button', `primary${this._dirty ? ' dirty' : ''}`, this._newTier ? 'Add tier' : 'Save tier');
    this._saveBtn = save;
    /** Build the tier from the form + the objectives draft and store it.
     *  @returns quest|null */
    const commit = () => {
      this._syncDraft();
      const built = normalizeQuest({
        id: quest?.id ?? this._freshTierId(tiers),
        title: titleIn.value,
        objectives: this._draftObjectives,
        autoAccept: startSeg.value() === 'auto',
        autoComplete: endSeg.value() === 'auto',
        offer: splitLines(offerTa.value),
        offerPrompt: offerPromptIn.value,
        progressLine: progressIn.value,
        ready: splitLines(readyTa.value),
        turninPrompt: turninPromptIn.value,
        epilogue: epilogueTa ? splitLines(epilogueTa.value) : quest?.epilogue,
        about: this._aboutEd.value(),
        debrief: this._debriefEd.value(),
        startReward: {
          health: sHealthIn.value,
          armor: sArmorIn.value,
          ammo: { type: sAmmoSel.value, amount: sAmmoAmountIn.value },
          items: startItems.value(),
        },
        reward: {
          health: healthIn.value,
          armor: armorIn.value,
          ammo: { type: ammoSel.value, amount: ammoAmountIn.value },
          items: rewardItems.value(),
        },
        flags: { accept: acceptFlagsIn.value, complete: completeFlagsIn.value },
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
    buttons.appendChild(save);
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
      buttons.appendChild(del);
    }
    form.appendChild(buttons);
  }
}
