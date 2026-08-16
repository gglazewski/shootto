// Dialogue.js — choice-driven NPC conversations.
//
// Replaces the old on-rails line reel: the NPC speaks a batch of lines, then
// the floor passes to the player, who picks a reply — ask for work, report a
// finished job, dig into lore topics, or say goodbye. Quest effects commit at
// the moment the matching reply is picked ("I'll do it" accepts, the turn-in
// reply completes and pays), so walking away mid-chat still changes nothing.
//
// Shape of a conversation:
//   intro (first meeting: the NPC's chit-chat; later: greeting or epilogue)
//     -> HUB: [offer?] [progress?] [turn-in?] [topic...] [Bye]
//   offer    -> quest.offer lines -> "I'll do it." / "Not now."
//   progress -> the {n}/{count} nudge -> HUB
//              (or, when the quest carries an `about` dialogue tree, that
//               tree plays instead — branching, replayable, {n}/{count} live)
//   turn-in  -> commits the quest, plays quest.ready lines -> HUB
//              (or, when the quest carries a `debrief` dialogue tree, that
//               tree plays after the commit — the giver can ask what
//               happened and the player picks their account of it)
//   topic    -> its answer lines -> HUB
//   chat     -> the NPC's small-talk tree (npc.chat), same walk -> HUB
//   service  -> hands the picked service back to the caller (choose() returns
//               { service }) — GameApp opens the matching screen (e.g. the
//               repair menu). Services gated by a flag signal only appear
//               while it is up (npc.services[i].flag, '!' inverts).
//
// Dialogue trees are DialogueGraphs (engine/DialogueGraph.js): each node
// speaks its lines, then its choices become the replies; a choice without a
// `next` (and a node without choices) drops back to the hub.
//
// Pure module (no three.js/DOM): GameApp renders line()/choices() and feeds
// player input to advance()/choose().

import { flagRefRaised } from './Reactions.js';

/** Player replies that wrap up an offer pitch. */
export const ACCEPT_LABEL = 'I’ll do it.';
export const DECLINE_LABEL = 'Not now.';
export const BYE_LABEL = 'Bye.';

export class Dialogue {
  /**
   * @param {object} deps
   * @param {{type:{id:string}, name:string, dialog:string[], greeting?:string,
   *          topics?:Array<{label:string, lines:string[]}>}} deps.npc
   * @param {import('./quests.js').QuestLog} deps.quests
   * @param {import('./Reactions.js').GameFlags} [deps.flags]  gate for flag-
   *   bound services; omitted means ungated services still show
   */
  constructor({ npc, quests, flags = null }) {
    this.npc = npc;
    this.quests = quests;
    this.flags = flags;
    this.giverId = npc.type.id;
    this.done = false;
    this._lines = [];
    this._i = 0;
    this._choices = null;
    this._after = null;
    /** Dialogue-tree walk state: the graph being played, its current node's
     *  choices, and the per-line placeholder filler. */
    this._graph = null;
    this._graphChoices = null;
    this._mapLine = null;
    /** True while the replies on screen are the hub menu (refreshHub). */
    this._onHub = false;
    this._play(this._intro(), () => this._hub());
  }

  /** What the NPC opens with: full chit-chat on the first meeting, the
   *  questline epilogue once it's all done, a short greeting otherwise. */
  _intro() {
    if (!this.quests.hasMet(this.giverId)) return [...this.npc.dialog];
    if (this.quests.statusFor(this.giverId) === 'done') {
      const epilogue = this.quests.epilogueFor(this.giverId);
      if (epilogue.length) return [...epilogue];
    }
    return [this.npc.greeting ?? 'Hello again.'];
  }

  /** The NPC line currently on screen, or null. */
  line() {
    return this._lines[Math.min(this._i, this._lines.length - 1)] ?? null;
  }

  /** The replies on offer, or null while the NPC is still speaking. */
  choices() {
    return this._choices;
  }

  /** E / tap: step to the next NPC line; the last line opens the replies. */
  advance() {
    if (this.done || this._choices) return;
    if (this._i < this._lines.length - 1) {
      this._i++;
      return;
    }
    this._after?.();
  }

  /**
   * The player picked a reply. Quest effects commit here.
   * @param {string} id  a choice id from choices()
   * @returns {{accepted?:object, completed?:object, reward?:object}|null}
   */
  choose(id) {
    if (this.done || !this._choices?.some((c) => c.id === id)) return null;
    const quest = this.quests.questFor(this.giverId);
    this._choices = null;

    // Mid-tree replies: follow the picked branch, or fall out to the hub.
    if (this._graph && id.startsWith('node:')) {
      const branch = this._graphChoices?.[Number(id.slice('node:'.length))];
      this._graphChoices = null;
      if (branch?.next) this._playNode(branch.next);
      else this._exitGraph();
      return null;
    }

    switch (id) {
      case 'offer':
        this._play([...quest.offer], () => {
          this._choices = [
            { id: 'accept', label: ACCEPT_LABEL, kind: 'accept' },
            { id: 'decline', label: DECLINE_LABEL, kind: 'decline' },
          ];
        });
        return null;
      case 'accept': {
        const result = this.quests.accept(this.giverId);
        this._hub();
        return result;
      }
      case 'decline':
        this._hub();
        return null;
      case 'progress':
        // An authored "about the quest" tree replaces the one-line nudge.
        if (quest?.about) {
          this._enterGraph(quest.about, (l) => this.quests.fillPlaceholders(this.giverId, l));
        } else {
          this._play([this.quests.progressLineFor(this.giverId)], () => this._hub());
        }
        return null;
      case 'chat':
        if (this.npc.chat) this._enterGraph(this.npc.chat);
        else this._hub();
        return null;
      case 'turnin': {
        // Commit first, then let the giver talk — the reply was the handover.
        const result = this.quests.complete(this.giverId);
        if (quest.debrief) this._enterGraph(quest.debrief);
        else this._play([...quest.ready], () => this._hub());
        return result;
      }
      case 'bye':
        this.done = true;
        return null;
      default: {
        // Service replies hand the picked service to the caller — the screen
        // (repair menu, ...) is GameApp's to open; the hub stays underneath.
        if (id.startsWith('service:')) {
          const service = this._services()[Number(id.slice('service:'.length))];
          this._hub();
          return service ? { service } : null;
        }
        const topic = (this.npc.topics ?? [])[Number(id.slice('topic:'.length))];
        if (topic) this._play([...topic.lines], () => this._hub());
        else this._hub();
        return null;
      }
    }
  }

  /** Show a batch of NPC lines, then run `after` (hub or follow-up replies).
   *  An empty batch skips straight to `after`, keeping the last line up. */
  _play(lines, after) {
    const clean = lines.filter((l) => typeof l === 'string' && l.length);
    if (clean.length) {
      this._lines = clean;
      this._i = 0;
    }
    this._choices = null;
    this._onHub = false;
    this._after = after;
    if (!clean.length) after();
  }

  /** Rebuild the hub replies if the conversation is sitting on them. The
   *  caller applies quest flags only after choose() returns, so a hub built
   *  synchronously inside it (a turn-in with no ready lines) can miss a
   *  flag-gated service that just switched on — this catches it up. No-op
   *  mid-lines or mid-tree. */
  refreshHub() {
    if (this._onHub && !this.done) this._hub();
  }

  /** Start walking a dialogue tree from its start node. `mapLine` fills
   *  placeholders ({n}/{count}) in every spoken line. */
  _enterGraph(graph, mapLine = (l) => l) {
    this._graph = graph;
    this._mapLine = mapLine;
    this._playNode(graph.start);
  }

  /** Speak a tree node's lines, then surface its choices as the replies — or
   *  drop back to the hub when the node is a leaf. */
  _playNode(id) {
    const node = this._graph?.nodes[id];
    if (!node) {
      this._exitGraph();
      return;
    }
    this._play(node.say.map((l) => this._mapLine(l)), () => {
      if (node.choices.length) {
        this._graphChoices = node.choices;
        this._choices = node.choices.map((c, i) => ({ id: `node:${i}`, label: c.label, kind: 'node' }));
      } else {
        this._exitGraph();
      }
    });
  }

  /** The NPC's services whose flag signal is currently up. Index-stable
   *  within one hub render: the hub and choose() both call this, and flags
   *  only move on quest commits, which rebuild the hub anyway. */
  _services() {
    return (this.npc.services ?? []).filter((s) => flagRefRaised(this.flags, s.flag));
  }

  /** Leave the tree walk and come back to the conversation hub. */
  _exitGraph() {
    this._graph = null;
    this._graphChoices = null;
    this._hub();
  }

  /** The conversation hub: build the reply menu from quest state + topics.
   *  Reaching it means the intro played out, so the NPC counts as met.
   *  Each reply carries a `kind` (offer/progress/turnin/topic/service/chat/
   *  bye) so the UI can flag quest actions without guessing from labels. */
  _hub() {
    this.quests.markMet(this.giverId);
    const status = this.quests.statusFor(this.giverId);
    const quest = this.quests.questFor(this.giverId);
    const choices = [];
    if (status === 'available') choices.push({ id: 'offer', label: quest.offerPrompt, kind: 'offer' });
    if (status === 'active') choices.push({ id: 'progress', label: `About “${quest.title}”…`, kind: 'progress' });
    if (status === 'ready') choices.push({ id: 'turnin', label: quest.turninPrompt, kind: 'turnin' });
    (this.npc.topics ?? []).forEach((t, i) => choices.push({ id: `topic:${i}`, label: t.label, kind: 'topic' }));
    this._services().forEach((s, i) => choices.push({ id: `service:${i}`, label: s.label, kind: 'service' }));
    if (this.npc.chat) choices.push({ id: 'chat', label: this.npc.chat.prompt ?? 'Can we talk?', kind: 'chat' });
    choices.push({ id: 'bye', label: BYE_LABEL, kind: 'bye' });
    this._choices = choices;
    this._onHub = true;
  }
}
