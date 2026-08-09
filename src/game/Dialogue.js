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
//   turn-in  -> commits the quest, plays quest.ready lines -> HUB
//   topic    -> its answer lines -> HUB
//
// Pure module (no three.js/DOM): GameApp renders line()/choices() and feeds
// player input to advance()/choose().

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
   */
  constructor({ npc, quests }) {
    this.npc = npc;
    this.quests = quests;
    this.giverId = npc.type.id;
    this.done = false;
    this._lines = [];
    this._i = 0;
    this._choices = null;
    this._after = null;
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

    switch (id) {
      case 'offer':
        this._play([...quest.offer], () => {
          this._choices = [
            { id: 'accept', label: ACCEPT_LABEL },
            { id: 'decline', label: DECLINE_LABEL },
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
        this._play([this.quests.progressLineFor(this.giverId)], () => this._hub());
        return null;
      case 'turnin': {
        // Commit first, then let the giver talk — the reply was the handover.
        const result = this.quests.complete(this.giverId);
        this._play([...quest.ready], () => this._hub());
        return result;
      }
      case 'bye':
        this.done = true;
        return null;
      default: {
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
    this._after = after;
    if (!clean.length) after();
  }

  /** The conversation hub: build the reply menu from quest state + topics.
   *  Reaching it means the intro played out, so the NPC counts as met. */
  _hub() {
    this.quests.markMet(this.giverId);
    const status = this.quests.statusFor(this.giverId);
    const quest = this.quests.questFor(this.giverId);
    const choices = [];
    if (status === 'available') choices.push({ id: 'offer', label: quest.offerPrompt });
    if (status === 'active') choices.push({ id: 'progress', label: `About “${quest.title}”…` });
    if (status === 'ready') choices.push({ id: 'turnin', label: quest.turninPrompt });
    (this.npc.topics ?? []).forEach((t, i) => choices.push({ id: `topic:${i}`, label: t.label }));
    choices.push({ id: 'bye', label: BYE_LABEL });
    this._choices = choices;
  }
}
