// NpcQuestEditor.js — the F4 panel: author NPCs and their questlines.
//
// A modal overlay with two tabs working directly against the NpcRegistry and
// QuestRegistry:
//   NPCs   — define characters: id, display name, skin (drawn character
//            sheet), height, the first-meeting chit-chat, the return-visit
//            greeting, and lore topics the player can ask about.
//   Quests — per NPC giver, an ordered list of quest tiers; each tier has a
//            title, an objective (kill N / collect N), the conversations
//            (offer / progress / turn-in / epilogue) and a reward.
//
// The panel builds its own DOM into document.body (styles live in
// index.html). Every mutation calls onChange() so the App can persist the
// registries and refresh anything derived (markers, tool state).

import { MOB_SKINS } from '../../game/mobSprites.js';
import { listMobs } from '../../engine/mobTypes.js';
import { listAmmoTypes } from '../../engine/AmmoTypes.js';
import {
  listNpcs, getNpc, registerNpc, removeNpc,
} from '../../engine/NpcRegistry.js';
import {
  getQuestline, setQuestline, normalizeQuest,
} from '../../engine/QuestRegistry.js';
import { listEquipItems } from '../../engine/EquipmentRegistry.js';
import { buildItemSwatch } from '../items/itemSwatch.js';

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

    this.root = el(doc, 'div', 'npcq-overlay');
    this.root.id = 'npcq-editor';
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
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
    this._render();
    this.root.classList.add('open');
  }

  close() {
    this.root.classList.remove('open');
    this.onClose?.();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
    return this.isOpen;
  }

  dispose() {
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
        this.tab = id;
        this._render();
      });
      tabs.appendChild(b);
    }
    const close = el(doc, 'button', 'npcq-close', '✕');
    close.addEventListener('click', () => this.close());
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

  /** Multi-select grid of equip-registry items (swatch + name): used for the
   *  reward item grants and the collect objective's item ids. Ids that are
   *  selected but no longer registered keep a placeholder card so editing a
   *  tier never silently drops them.
   *  @param {HTMLElement} parent
   *  @param {string[]} selected  currently picked item ids
   *  @param {string} hint  the line above the grid
   *  @returns {{el: HTMLElement, value: () => string[]}} */
  _itemPicker(parent, selected, hint) {
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
    const dialogTa = this._textarea(existing?.dialog, 6);
    form.appendChild(dialogTa);
    const greetIn = this._row(form, 'Greeting', this._input(existing?.greeting ?? ''));
    greetIn.placeholder = 'opens every later talk — "Hello again." when empty';
    form.appendChild(el(doc, 'div', 'npcq-hint',
      'Lore topics — blocks separated by a blank line; block’s first row is the player’s question, the rest is the answer:'));
    const topicsTa = this._textarea(null, 8);
    topicsTa.value = topicsToText(existing?.topics);
    topicsTa.placeholder = 'What happened here?\nNobody rightly knows, love.\nOne day the sirens went...\n\nWho are you?\nJust an old woman minding her tea.';
    form.appendChild(topicsTa);

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
      this.giverId = giverSel.value;
      this.tierIndex = 0;
      this._render();
    });
    side.appendChild(giverSel);

    const tiers = getQuestline(this.giverId);
    if (this.tierIndex >= tiers.length) this.tierIndex = Math.max(0, tiers.length - 1);
    tiers.forEach((q, i) => {
      const entry = el(doc, 'button', `npcq-entry${i === this.tierIndex && !this._newTier ? ' active' : ''}`, `${i + 1}. ${q.title}`);
      entry.addEventListener('click', () => {
        this._newTier = false;
        this.tierIndex = i;
        this._render();
      });
      side.appendChild(entry);
    });
    const add = el(doc, 'button', `npcq-entry npcq-add${this._newTier ? ' active' : ''}`, '+ Add tier');
    add.addEventListener('click', () => {
      this._newTier = true;
      this._render();
    });
    side.appendChild(add);

    const quest = this._newTier ? null : tiers[this.tierIndex] ?? null;
    const isLast = this._newTier || this.tierIndex === tiers.length - 1;

    const titleIn = this._row(form, 'Title', this._input(quest?.title ?? ''));
    const o = quest?.objective ?? {};
    const typeSel = this._row(form, 'Objective', this._select(
      [{ value: 'kill', label: 'Kill mobs' }, { value: 'collect', label: 'Collect pickups' }],
      o.type ?? 'kill',
    ));
    const targetSel = this._row(form, 'Kill target', this._select(
      [{ value: 'any', label: 'Any mob' }, ...listMobs().map((m) => ({ value: m.id, label: m.name }))],
      o.target ?? 'any',
    ));
    const spawnWrap = el(doc, 'div', 'npcq-spawn');
    const spawnLabel = el(doc, 'span', 'npcq-spawn-label',
      o.spawnCell ? `cell ${o.spawnCell.join(', ')}` : 'none — kills count anywhere');
    const pickBtn = el(doc, 'button', '', 'Select spawn');
    pickBtn.title = 'Saves this tier, then click a block in the world — the pack spawns there when the quest is accepted';
    const clearSpawn = el(doc, 'button', '', 'Clear');
    spawnWrap.append(spawnLabel, pickBtn, clearSpawn);
    this._row(form, 'Slay spawn', spawnWrap);
    const kindsIn = this._row(form, 'Collect kinds', this._input((o.kinds ?? []).join(', ')));
    kindsIn.placeholder = 'ammo, armor — empty = any pickup';
    const idsPicker = this._itemPicker(form, o.ids ?? [],
      'Collect items — pick the exact items to fetch; any pick overrides the kinds above:');
    const countIn = this._row(form, 'Count', this._input(o.count ?? 3, 'number'));
    const nounIn = this._row(form, 'Noun (HUD)', this._input(o.noun ?? ''));
    nounIn.placeholder = 'zombies / supplies…';

    const syncObjective = () => {
      const kill = typeSel.value === 'kill';
      targetSel.parentElement.style.display = kill ? '' : 'none';
      spawnWrap.parentElement.style.display = kill ? '' : 'none';
      kindsIn.parentElement.style.display = kill ? 'none' : '';
      idsPicker.el.style.display = kill ? 'none' : '';
    };
    typeSel.addEventListener('change', syncObjective);
    syncObjective();

    const offerPromptIn = this._row(form, 'Offer reply', this._input(quest?.offerPrompt ?? ''));
    offerPromptIn.placeholder = 'the player’s reply that opens the pitch — "Do you need help?" when empty';
    form.appendChild(el(doc, 'div', 'npcq-hint', 'Offer — the pitch; the player then picks "I’ll do it" to accept:'));
    const offerTa = this._textarea(quest?.offer, 3);
    form.appendChild(offerTa);
    const progressIn = this._row(form, 'Progress line', this._input(quest?.progressLine ?? 'How goes it? {n} of {count} so far.'));
    progressIn.placeholder = 'may use {n} and {count}';
    const turninPromptIn = this._row(form, 'Turn-in reply', this._input(quest?.turninPrompt ?? ''));
    turninPromptIn.placeholder = 'the player’s reply that hands the job in — "It’s done." when empty';
    form.appendChild(el(doc, 'div', 'npcq-hint', 'Turn-in — played when the job is handed in; picking the reply pays the reward:'));
    const readyTa = this._textarea(quest?.ready, 3);
    form.appendChild(readyTa);
    let epilogueTa = null;
    if (isLast) {
      form.appendChild(el(doc, 'div', 'npcq-hint', 'Epilogue (last tier only) — idle talk once the questline is finished:'));
      epilogueTa = this._textarea(quest?.epilogue, 2);
      form.appendChild(epilogueTa);
    }

    const r = quest?.reward ?? {};
    const healthIn = this._row(form, 'Reward: health', this._input(r.health ?? 0, 'number'));
    const armorIn = this._row(form, 'Reward: armor', this._input(r.armor ?? 0, 'number'));
    const ammoSel = this._row(form, 'Reward: ammo', this._select(
      [{ value: '', label: 'None' }, ...listAmmoTypes().map((a) => ({ value: a.id, label: a.name }))],
      r.ammo?.type ?? '',
    ));
    const ammoAmountIn = this._row(form, 'Ammo amount', this._input(r.ammo?.amount ?? 0, 'number'));
    const rewardItems = this._itemPicker(form, r.items ?? [],
      'Reward items — pick any number; they fly from the giver at turn-in:');

    const buttons = el(doc, 'div', 'npcq-buttons');
    const save = el(doc, 'button', 'primary', this._newTier ? 'Add tier' : 'Save tier');
    /** Build the tier from the form and store it. `extra.spawnCell` (when the
     *  key is present) overrides the kept spawn point. @returns quest|null */
    const commit = (extra = {}) => {
      const built = normalizeQuest({
        id: quest?.id ?? `${this.giverId}-${tiers.length + 1}`,
        title: titleIn.value,
        objective: {
          type: typeSel.value,
          target: targetSel.value,
          kinds: splitLines(kindsIn.value.replaceAll(',', '\n')),
          ids: idsPicker.value(),
          count: countIn.value,
          noun: nounIn.value,
          spawnCell: 'spawnCell' in extra ? extra.spawnCell : quest?.objective?.spawnCell ?? null,
        },
        offer: splitLines(offerTa.value),
        offerPrompt: offerPromptIn.value,
        progressLine: progressIn.value,
        ready: splitLines(readyTa.value),
        turninPrompt: turninPromptIn.value,
        epilogue: epilogueTa ? splitLines(epilogueTa.value) : quest?.epilogue,
        reward: {
          health: healthIn.value,
          armor: armorIn.value,
          ammo: { type: ammoSel.value, amount: ammoAmountIn.value },
          items: rewardItems.value(),
        },
      }, this.giverId);
      if (!built) return null;
      const next = [...tiers];
      if (this._newTier) next.push(built);
      else next[this.tierIndex] = built;
      setQuestline(this.giverId, next);
      if (this._newTier) this.tierIndex = next.length - 1;
      this._newTier = false;
      this.onChange();
      this._render();
      return built;
    };
    save.addEventListener('click', () => commit());
    // "Select spawn": save the tier as-is, hand the mouse to the world (the
    // App closes the panel), and write the picked cell into the saved tier.
    pickBtn.addEventListener('click', () => {
      if (!this.onPickSpawn || !commit()) return;
      const giver = this.giverId;
      const index = this.tierIndex;
      this.onPickSpawn((cell) => {
        const line = getQuestline(giver);
        if (!line[index]) return;
        line[index] = { ...line[index], objective: { ...line[index].objective, spawnCell: cell } };
        setQuestline(giver, line);
        this.onChange();
        this._render();
      });
    });
    clearSpawn.addEventListener('click', () => commit({ spawnCell: null }));
    buttons.appendChild(save);
    if (quest) {
      const del = el(doc, 'button', 'danger', 'Delete tier');
      del.addEventListener('click', () => {
        const next = tiers.filter((_, i) => i !== this.tierIndex);
        setQuestline(this.giverId, next);
        this.tierIndex = Math.max(0, this.tierIndex - 1);
        this.onChange();
        this._render();
      });
      buttons.appendChild(del);
    }
    form.appendChild(buttons);
  }
}
