// quests.js — tiered quest system, NPCs are the quest givers.
//
// Every NPC carries a QUESTLINE: an ordered chain of quests (tiers) that
// unlock one at a time — turning tier N in makes tier N+1 available from the
// same giver. Conversations drive the whole lifecycle, but the player is in
// charge: quests are accepted and turned in by explicitly PICKING a reply in
// the dialogue (see Dialogue.js), never by just hearing an NPC out — so a
// quest is never accepted or rewarded by accident.
//
// Quest state per giver:  available -> active -> ready -> (next tier) -> done.
// Objectives progress through game events (onKill / onCollect / onVisit) only
// while their quest is active. A quest may carry SEVERAL objectives (multi-
// goal): it goes ready only when every one of them is met, each tracked in a
// per-objective progress slot.
//
// Chains: a tier flagged `autoComplete` skips the turn-in — the moment its
// last objective lands it completes on the spot (reward included in the
// event) and the next tier, if flagged `autoAccept`, starts immediately.
// That lets areas trigger fights trigger fetches without a single dialog:
// walk into the cellar -> "Clear the cellar" starts -> last zombie falls ->
// the next chapter begins. Pure module (no three.js/DOM) so it unit tests in
// Node; GameApp owns the dialog UI, toasts, and reward granting.

import { getNpcType } from './NPC.js';
import { getQuestlines, BUILTIN_QUESTLINES } from '../engine/QuestRegistry.js';

/**
 * Objective shapes:
 *   { type: 'kill',    target: 'any'|mobTypeId, count, noun }
 *   { type: 'collect', kinds: [equipKind...] | ids: [itemId...], count, noun }
 *   { type: 'visit',   cells: [[x,y,z]...], count: 1, noun }
 * Reward shape: { health?, armor?, ammo?: { type, amount }, items?: [itemId...] }
 * — see GameApp._grantReward; a tier's optional `startReward` (same shape) is
 * granted by GameApp the moment the quest starts. `progressLine` — and the
 * lines of an authored `about` dialogue tree — may use {n} and {count}
 * placeholders.
 *
 * The quest DATA lives in the QuestRegistry (built-in granny line + whatever
 * the editor's F4 panel authors); this module is the runtime that walks it.
 */
export const QUESTLINES = BUILTIN_QUESTLINES;

/** Fill {n}/{count} placeholders in a progress line. */
function template(line, n, count) {
  return line.replace('{n}', String(n)).replace('{count}', String(count));
}

/** True when a collected equip-item def satisfies a collect objective. */
function collectMatches(objective, def) {
  if (objective.ids) return objective.ids.includes(def.id);
  if (objective.kinds) return objective.kinds.includes(def.kind);
  return true; // no filter — any pickup counts
}

/** A quest's objectives as an array — tiers authored before multi-goal
 *  quests carried a single `objective`, so both shapes walk the same path. */
export function objectivesOf(quest) {
  return quest?.objectives ?? (quest?.objective ? [quest.objective] : []);
}

/** True when the player's FEET cell counts as being on a visit objective's
 *  marked area. Marks are voxels whose top face the editor painted, so feet
 *  directly on top (dy 1) is the standard hit; dy 0 covers marks on
 *  walk-through blocks and dy 2 covers a jump or a step mid-stride. */
function visitMatches(objective, x, y, z) {
  for (const [cx, cy, cz] of objective.cells ?? []) {
    if (cx !== x || cz !== z) continue;
    const dy = y - cy;
    if (dy >= 0 && dy <= 2) return true;
  }
  return false;
}

export class QuestLog {
  /** @param {object} [questlines]  giver id -> ordered quest array; defaults
   *  to a snapshot of the QuestRegistry (built-ins + editor-authored) */
  constructor(questlines = getQuestlines()) {
    this.questlines = questlines;
    this.met = new Set(); // NPCs whose intro chit-chat has fully played
    /** @type {Map<string, {tier:number, status:string, progress:number[]}>}
     *  status: 'available' | 'active' | 'ready' | 'done'; progress holds one
     *  counter per objective of the current tier. */
    this.state = new Map();
  }

  _line(giverId) {
    let st = this.state.get(giverId);
    if (!st) {
      const has = (this.questlines[giverId]?.length ?? 0) > 0;
      st = { tier: 0, status: has ? 'available' : 'done', progress: [] };
      this.state.set(giverId, st);
    }
    return st;
  }

  /** progress counter for objective `i`, tolerant of short arrays. */
  _progress(st, i) {
    return st.progress[i] ?? 0;
  }

  /** True when every objective of `quest` is met in `st`. */
  _fulfilled(st, quest) {
    return objectivesOf(quest).every((o, i) => this._progress(st, i) >= o.count);
  }

  /** Current quest def for a giver, or null when its line is exhausted. */
  questFor(giverId) {
    const st = this._line(giverId);
    return st.status === 'done' ? null : (this.questlines[giverId]?.[st.tier] ?? null);
  }

  /** Quest status for a giver: 'available' | 'active' | 'ready' | 'done'. */
  statusFor(giverId) {
    return this._line(giverId).status;
  }

  /** True once the NPC's first-meeting chit-chat has fully played. */
  hasMet(giverId) {
    return this.met.has(giverId);
  }

  /** The intro chit-chat played through — later talks skip it. */
  markMet(giverId) {
    this.met.add(giverId);
  }

  /** Fill {n}/{count} in an arbitrary line from the giver's first unfinished
   *  objective (the one the player is presumably working on) — the stock
   *  progress nudge and authored "about" dialogue trees share this. */
  fillPlaceholders(giverId, line) {
    const quest = this.questFor(giverId);
    if (!quest) return line;
    const st = this._line(giverId);
    const objectives = objectivesOf(quest);
    let i = objectives.findIndex((o, j) => this._progress(st, j) < o.count);
    if (i === -1) i = objectives.length - 1;
    return template(line, this._progress(st, i), objectives[i]?.count ?? 1);
  }

  /** The giver's progress nudge with {n}/{count} filled in. */
  progressLineFor(giverId) {
    const quest = this.questFor(giverId);
    return quest ? this.fillPlaceholders(giverId, quest.progressLine) : null;
  }

  /** The closing chit-chat of a finished questline (last tier's epilogue). */
  epilogueFor(giverId) {
    return this.questlines[giverId]?.at(-1)?.epilogue ?? [];
  }

  /**
   * The player picked the "I'll do it" reply — the offered quest starts.
   * @returns {{accepted: object}|null}
   */
  accept(giverId) {
    const st = this._line(giverId);
    if (st.status !== 'available') return null;
    const quest = this.questFor(giverId);
    st.status = 'active';
    st.progress = objectivesOf(quest).map(() => 0);
    return { accepted: quest };
  }

  /**
   * The player picked the turn-in reply on a fulfilled quest — the giver's
   * tier advances and the reward comes back to be granted.
   * @returns {{completed: object, reward: object|null}|null}
   */
  complete(giverId) {
    const st = this._line(giverId);
    if (st.status !== 'ready') return null;
    const quest = this.questFor(giverId);
    st.tier++;
    st.progress = [];
    st.status = st.tier < this.questlines[giverId].length ? 'available' : 'done';
    return { completed: quest, reward: quest.reward ?? null };
  }

  /** Auto-start every available quest flagged `autoAccept` — chain openers at
   *  game start, and next tiers right after a turn-in. Feed the returned
   *  events to the same handler as onKill's (GameApp._questEvents).
   *  @returns {Array<{quest, accepted:true}>} */
  autoAcceptAvailable() {
    const events = [];
    for (const giverId of Object.keys(this.questlines)) {
      events.push(...this._autoAccept(giverId));
    }
    return events;
  }

  /** Accept the giver's current quest if it's available and auto-starting. */
  _autoAccept(giverId) {
    const st = this._line(giverId);
    if (st.status !== 'available' || !this.questFor(giverId)?.autoAccept) return [];
    const result = this.accept(giverId);
    return result ? [{ quest: result.accepted, accepted: true }] : [];
  }

  /** Field-complete a quest that just went ready (autoComplete tiers): the
   *  reward rides the event, and an auto-accepting next tier starts on the
   *  spot — that's the chain link. */
  _autoComplete(giverId) {
    const result = this.complete(giverId);
    if (!result) return [];
    const events = [{ quest: result.completed, completed: true, reward: result.reward }];
    events.push(...this._autoAccept(giverId));
    return events;
  }

  /** A mob died by the player's hand. @returns {Array<{quest, ready:boolean}>} */
  onKill(mobTypeId) {
    return this._advance((o) => o.type === 'kill' && (o.target === 'any' || o.target === mobTypeId));
  }

  /** The player was granted a pickup. @returns {Array<{quest, ready:boolean}>} */
  onCollect(def) {
    return this._advance((o) => o.type === 'collect' && collectMatches(o, def));
  }

  /** The player's feet entered cell (x,y,z) — fire on every feet-cell change.
   *  Meets any active visit objective whose marked area covers the cell. */
  onVisit(x, y, z) {
    return this._advance((o) => o.type === 'visit' && visitMatches(o, x, y, z));
  }

  /** True while some ACTIVE quest's collect objective matches this item def.
   *  This is the gate for kind:'quest' items: a fetch objective sits in the
   *  world unpickable (no prompt, no E) until its quest is accepted, and goes
   *  inert again the moment the objective is fulfilled. */
  wantsItem(def) {
    for (const giverId of Object.keys(this.questlines)) {
      const st = this._line(giverId);
      if (st.status !== 'active') continue;
      const quest = this.questFor(giverId);
      const hit = objectivesOf(quest).some((o, i) =>
        o.type === 'collect' && this._progress(st, i) < o.count && collectMatches(o, def));
      if (hit) return true;
    }
    return false;
  }

  /** Bump every active quest with an unmet objective the event satisfies. A
   *  quest goes ready only when ALL its objectives are met; autoComplete
   *  tiers then finish (and chain) immediately — the extra completed/accepted
   *  events ride along in the returned list, in order. */
  _advance(matches) {
    const events = [];
    for (const giverId of Object.keys(this.questlines)) {
      const st = this._line(giverId);
      if (st.status !== 'active') continue;
      const quest = this.questFor(giverId);
      if (!quest) continue;
      let bumped = false;
      objectivesOf(quest).forEach((o, i) => {
        if (this._progress(st, i) >= o.count || !matches(o)) return;
        st.progress[i] = this._progress(st, i) + 1;
        bumped = true;
      });
      if (!bumped) continue;
      const ready = this._fulfilled(st, quest);
      if (ready) st.status = 'ready';
      events.push({ quest, ready });
      if (ready && quest.autoComplete) events.push(...this._autoComplete(giverId));
    }
    return events;
  }

  /** Every quest currently ACTIVE, with its progress so far — what a loaded
   *  game needs to re-materialize outstanding slay packs. */
  activeQuests() {
    const out = [];
    for (const giverId of Object.keys(this.questlines)) {
      const st = this._line(giverId);
      if (st.status !== 'active') continue;
      const quest = this.questFor(giverId);
      if (quest) out.push({ quest, progress: [...st.progress] });
    }
    return out;
  }

  /** Every in-flight quest for the HUD tracker (WoW-style objective list):
   *  gold title + one line per objective (`lines`, met ones flagged done),
   *  `ready` marking turn-ins. `text` keeps the single-line view: the first
   *  unfinished objective, or the return-to-giver nudge when ready. */
  trackerEntries() {
    const out = [];
    for (const giverId of Object.keys(this.questlines)) {
      const st = this._line(giverId);
      if (st.status !== 'active' && st.status !== 'ready') continue;
      const quest = this.questFor(giverId);
      if (!quest) continue;
      const ready = st.status === 'ready';
      const giverName = getNpcType(quest.giver)?.name ?? quest.giver;
      const lines = objectivesOf(quest).map((o, i) => {
        const n = Math.min(this._progress(st, i), o.count);
        return { text: `${o.noun} ${n}/${o.count}`, done: n >= o.count };
      });
      out.push({
        title: quest.title,
        text: ready ? `Return to ${giverName}` : (lines.find((l) => !l.done) ?? lines.at(-1)).text,
        lines: ready ? [{ text: `Return to ${giverName}`, done: false }] : lines,
        ready,
      });
    }
    return out;
  }

  /** First tracker entry, or null — the single-quest view of the above. */
  tracker() {
    return this.trackerEntries()[0] ?? null;
  }

  /** Every lifecycle flag entry implied by the log's current state, in the
   *  order the moments fired: each finished tier contributes its accept +
   *  complete lists, a currently accepted (active/ready) tier its accept
   *  list. GameApp replays these on every play start so the flag store can
   *  never disagree with quest history — a signal authored onto an already-
   *  finished quest still fires on the next load, mirroring how reactions
   *  catch up instead of being one-shots (see Reactions.js). */
  lifecycleFlags() {
    const out = [];
    for (const [giverId, line] of Object.entries(this.questlines)) {
      const st = this._line(giverId);
      for (let t = 0; t < st.tier && t < line.length; t++) {
        out.push(...(line[t].flags?.accept ?? []), ...(line[t].flags?.complete ?? []));
      }
      if (st.status === 'active' || st.status === 'ready') {
        out.push(...(line[st.tier]?.flags?.accept ?? []));
      }
    }
    return out;
  }

  serialize() {
    return {
      met: [...this.met],
      state: Object.fromEntries(
        [...this.state].map(([id, st]) => [id, { tier: st.tier, status: st.status, progress: [...st.progress] }]),
      ),
    };
  }

  /** Restore a serialized log; unknown givers and out-of-range tiers are
   *  dropped (questlines may have changed since the save). Progress from a
   *  save predating multi-goal quests is a bare number — it becomes the first
   *  objective's counter. */
  static deserialize(data, questlines = getQuestlines()) {
    const log = new QuestLog(questlines);
    if (!data) return log;
    for (const id of data.met ?? []) log.met.add(id);
    for (const [id, st] of Object.entries(data.state ?? {})) {
      const line = questlines[id];
      if (!line) continue;
      const tier = Math.min(Math.max(0, st.tier | 0), line.length);
      const status = tier >= line.length ? 'done'
        : ['available', 'active', 'ready'].includes(st.status) ? st.status : 'available';
      const progress = Array.isArray(st.progress)
        ? st.progress.map((n) => Math.max(0, n | 0))
        : [Math.max(0, st.progress | 0)];
      log.state.set(id, { tier, status, progress });
    }
    return log;
  }
}
