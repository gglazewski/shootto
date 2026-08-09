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
// Objectives progress through game events (onKill / onCollect) only while
// their quest is active. Pure module (no three.js/DOM) so it unit tests in
// Node; GameApp owns the dialog UI, toasts, and reward granting.

import { getNpcType } from './NPC.js';
import { getQuestlines, BUILTIN_QUESTLINES } from '../engine/QuestRegistry.js';

/**
 * Objective shapes:
 *   { type: 'kill',    target: 'any'|mobTypeId, count, noun }
 *   { type: 'collect', kinds: [equipKind...] | ids: [itemId...], count, noun }
 * Reward shape: { health?, armor?, ammo?: { type, amount }, items?: [itemId...] }
 * — see GameApp._grantReward. `progressLine` may use {n} and {count} placeholders.
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

export class QuestLog {
  /** @param {object} [questlines]  giver id -> ordered quest array; defaults
   *  to a snapshot of the QuestRegistry (built-ins + editor-authored) */
  constructor(questlines = getQuestlines()) {
    this.questlines = questlines;
    this.met = new Set(); // NPCs whose intro chit-chat has fully played
    /** @type {Map<string, {tier:number, status:string, progress:number}>}
     *  status: 'available' | 'active' | 'ready' | 'done' */
    this.state = new Map();
  }

  _line(giverId) {
    let st = this.state.get(giverId);
    if (!st) {
      const has = (this.questlines[giverId]?.length ?? 0) > 0;
      st = { tier: 0, status: has ? 'available' : 'done', progress: 0 };
      this.state.set(giverId, st);
    }
    return st;
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

  /** The giver's progress nudge with {n}/{count} filled in, or null. */
  progressLineFor(giverId) {
    const quest = this.questFor(giverId);
    if (!quest) return null;
    return template(quest.progressLine, this._line(giverId).progress, quest.objective.count);
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
    st.progress = 0;
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
    st.progress = 0;
    st.status = st.tier < this.questlines[giverId].length ? 'available' : 'done';
    return { completed: quest, reward: quest.reward ?? null };
  }

  /** A mob died by the player's hand. @returns {Array<{quest, ready:boolean}>} */
  onKill(mobTypeId) {
    return this._advance((o) => o.type === 'kill' && (o.target === 'any' || o.target === mobTypeId));
  }

  /** The player was granted a pickup. @returns {Array<{quest, ready:boolean}>} */
  onCollect(def) {
    return this._advance((o) => o.type === 'collect' && collectMatches(o, def));
  }

  /** True while some ACTIVE quest's collect objective matches this item def.
   *  This is the gate for kind:'quest' items: a fetch objective sits in the
   *  world unpickable (no prompt, no E) until its quest is accepted, and goes
   *  inert again the moment the objective is fulfilled. */
  wantsItem(def) {
    for (const giverId of Object.keys(this.questlines)) {
      const st = this._line(giverId);
      if (st.status !== 'active') continue;
      const o = this.questFor(giverId)?.objective;
      if (o?.type === 'collect' && collectMatches(o, def)) return true;
    }
    return false;
  }

  /** Bump every active quest whose objective the event satisfies. */
  _advance(matches) {
    const events = [];
    for (const giverId of Object.keys(this.questlines)) {
      const st = this._line(giverId);
      if (st.status !== 'active') continue;
      const quest = this.questFor(giverId);
      if (!quest || !matches(quest.objective)) continue;
      st.progress++;
      if (st.progress >= quest.objective.count) st.status = 'ready';
      events.push({ quest, ready: st.status === 'ready' });
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
      if (quest) out.push({ quest, progress: st.progress });
    }
    return out;
  }

  /** Every in-flight quest for the HUD tracker (WoW-style objective list):
   *  gold title + one objective line each, `ready` marking turn-ins. */
  trackerEntries() {
    const out = [];
    for (const giverId of Object.keys(this.questlines)) {
      const st = this._line(giverId);
      if (st.status !== 'active' && st.status !== 'ready') continue;
      const quest = this.questFor(giverId);
      if (!quest) continue;
      const ready = st.status === 'ready';
      const giverName = getNpcType(quest.giver)?.name ?? quest.giver;
      const o = quest.objective;
      out.push({
        title: quest.title,
        text: ready ? `Return to ${giverName}` : `${o.noun} ${st.progress}/${o.count}`,
        ready,
      });
    }
    return out;
  }

  /** First tracker entry, or null — the single-quest view of the above. */
  tracker() {
    return this.trackerEntries()[0] ?? null;
  }

  serialize() {
    return {
      met: [...this.met],
      state: Object.fromEntries(
        [...this.state].map(([id, st]) => [id, { tier: st.tier, status: st.status, progress: st.progress }]),
      ),
    };
  }

  /** Restore a serialized log; unknown givers and out-of-range tiers are
   *  dropped (questlines may have changed since the save). */
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
      log.state.set(id, { tier, status, progress: Math.max(0, st.progress | 0) });
    }
    return log;
  }
}
