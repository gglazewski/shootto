// QuestRegistry.js — registry of questlines, keyed by their NPC giver.
//
// A questline is an ordered array of quest tiers; the runtime (game/quests.js
// QuestLog) walks it one tier at a time. The editor's F4 panel authors these,
// they persist to localStorage and ship inside the world bundle. A built-in
// starter line (the granny's) is always present on a fresh install and can be
// edited or replaced like any authored one.
//
// A quest tier:
//   { id, title, giver,
//     objective: { type:'kill', target:'any'|mobId, count, noun }
//              | { type:'collect', kinds?:[equipKind...], ids?:[itemId...], count, noun },
//     offer: [lines], progressLine: '...{n}/{count}...', ready: [lines],
//     offerPrompt, turninPrompt,  // the player's replies that open the offer / hand the job in
//     reward: { health?, armor?, ammo?: {type, amount}, items?: [itemId...] } | null,
//     epilogue?: [lines] }   // last tier only: played once the line is done
//
// Pure module (no three.js/DOM) so it unit tests in Node.

import { isAmmoId } from './AmmoTypes.js';

export const BUILTIN_QUESTLINES = Object.freeze({
  granny: [
    {
      id: 'granny-teapot',
      title: 'The Favorite Teapot',
      giver: 'granny',
      // A fetch quest: the teapot is a kind:'quest' item (see QuestItems.js).
      // It sits in the world unpickable until this tier is accepted.
      objective: { type: 'collect', ids: ['granny-teapot'], count: 1, noun: 'teapot' },
      offer: [
        'Before anything else, dearie — I must confess I’ve been sick with worry. Not about the dead. About my teapot.',
        'The blue one, with the little flowers. I left it behind when they hurried us out of the old flat, and I haven’t brewed a proper cup since.',
        'Somewhere in those ruins it sits, wondering where I’ve gone. Bring it home, would you? A body can face the apocalypse, but not without tea.',
      ],
      offerPrompt: 'Is something troubling you?',
      turninPrompt: 'I found your teapot.',
      progressLine: 'No teapot yet? {n} of {count} found, dearie — blue, with the little flowers. My cup stands empty and so does my heart.',
      ready: [
        'My teapot! Oh, hand it here — careful now, careful! Not a chip on it. You wonderful creature.',
        'The kettle may be broken, but a pot like this deserves patience. Sit down a moment, you’ve earned a rest.',
      ],
      reward: { health: 25 },
    },
    {
      id: 'granny-1',
      title: 'Quiet the Yard',
      giver: 'granny',
      objective: { type: 'kill', target: 'any', count: 3, noun: 'zombies' },
      offer: [
        'Actually, dearie… since you’re armed and upright, could you do an old woman a favor?',
        'Three of those things have taken to loitering in my yard. I can’t hear my own thoughts over the moaning.',
        'Put them down for me, will you? I’ll dig out something of my Stefan’s for your trouble.',
      ],
      offerPrompt: 'Anything else I can do?',
      turninPrompt: 'The yard is quiet now.',
      progressLine: 'The yard, dearie. Still {n} down out of {count} — my ears are counting on you.',
      ready: [
        'Oh, blessed silence! You did it, didn’t you — I can tell by the quiet.',
        'Here — Stefan’s old vest. He won’t be needing it, and you clearly will.',
      ],
      reward: { armor: 25 },
    },
    {
      id: 'granny-2',
      title: 'Waste Not',
      giver: 'granny',
      objective: { type: 'collect', kinds: ['ammo', 'armor'], count: 2, noun: 'supplies' },
      offer: [
        'You know what wins against the dead, dearie? Thrift. Everything useful is lying about in the ruins.',
        'Scavenge me proof you can look after yourself — a couple of supply packs, ammunition, gear, anything.',
        'Waste not, want not. Off you go.',
      ],
      offerPrompt: 'Got more work for me?',
      turninPrompt: 'I’ve got the supplies.',
      progressLine: 'Found anything useful yet? {n} of {count}, by my count. Check the dark corners, dearie.',
      ready: [
        'There’s a good scavenger! Stefan always said the careful ones outlive the brave ones.',
        'I’ve been sitting on a box of pistol rounds I can’t use. Take it — my eyes are too far gone to aim.',
      ],
      reward: { ammo: { type: 'pistol', amount: 30 } },
    },
    {
      id: 'granny-3',
      title: 'Cull the Horde',
      giver: 'granny',
      objective: { type: 'kill', target: 'any', count: 10, noun: 'zombies' },
      offer: [
        'One last favor, dearie, and it’s a big one. There’s a whole crowd of them shambling about the neighborhood.',
        'Ten of them, give or take. Thin them out and every soul left in this town sleeps easier — me included.',
        'Go on now. Come back in one piece or don’t come back at all — I can’t take another funeral.',
      ],
      offerPrompt: 'Anything else, ma’am?',
      turninPrompt: 'The horde is thinned out.',
      progressLine: 'Still shambling, are they? {n} of {count} down. Keep at it, dearie.',
      ready: [
        'Ten of them! And here everyone thought I was mad, talking to the well-armed stranger.',
        'Sit still a moment — grandmother’s orders. Let me patch you up properly, and take these rounds too.',
        'That’s all an old woman can offer. The rest of this town is your mess now, dearie.',
      ],
      reward: { health: 100, ammo: { type: 'pistol', amount: 30 } },
      epilogue: [
        'Quiet as a churchyard, thanks to you. The proper kind of churchyard, I mean.',
        'Come by whenever you like, dearie. The kettle’s still broken, but the company’s free.',
      ],
    },
  ],
});

const questlines = new Map();
resetQuestRegistry();

/** Restore the registry to the built-in questlines. */
export function resetQuestRegistry() {
  questlines.clear();
  for (const [giver, line] of Object.entries(BUILTIN_QUESTLINES)) {
    questlines.set(giver, line.map((q) => ({ ...q })));
  }
}

function lines(v) {
  return (Array.isArray(v) ? v : [])
    .filter((l) => typeof l === 'string' && l.trim().length)
    .map((l) => l.trim());
}

function posInt(v, fallback) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Coerce a candidate objective into a valid one. */
export function normalizeObjective(o = {}) {
  if (o.type === 'collect') {
    const kinds = lines(o.kinds);
    const ids = lines(o.ids);
    return {
      type: 'collect',
      ...(ids.length ? { ids } : kinds.length ? { kinds } : {}),
      count: posInt(o.count, 1),
      noun: typeof o.noun === 'string' && o.noun.trim() ? o.noun.trim() : 'supplies',
    };
  }
  // Optional slay pack spawn point (feet cell): accepting the quest spawns
  // the objective's `count` mobs there (see GameApp._spawnQuestMobs). Kill
  // quests without one just count kills wherever they happen.
  const sc = o.spawnCell;
  const spawnCell = Array.isArray(sc) && sc.length === 3 && sc.every((v) => Number.isFinite(Number(v)))
    ? sc.map((v) => Math.round(Number(v)))
    : null;
  return {
    type: 'kill',
    target: typeof o.target === 'string' && o.target ? o.target : 'any',
    count: posInt(o.count, 1),
    noun: typeof o.noun === 'string' && o.noun.trim() ? o.noun.trim() : 'zombies',
    ...(spawnCell ? { spawnCell } : {}),
  };
}

/** Coerce a candidate reward into a valid one, or null when it grants nothing. */
export function normalizeReward(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {};
  const health = posInt(r.health, 0);
  const armor = posInt(r.armor, 0);
  if (health) out.health = health;
  if (armor) out.armor = armor;
  const amount = posInt(r.ammo?.amount, 0);
  if (r.ammo?.type && isAmmoId(r.ammo.type) && amount) out.ammo = { type: r.ammo.type, amount };
  // Item grants: equip-item ids handed over at turn-in — they fly from the
  // giver to the player (see GameApp._grantReward). Unknown ids are skipped
  // at grant time, not here, so a reward can name an item authored later.
  const items = lines(r.items);
  if (items.length) out.items = items;
  return Object.keys(out).length ? out : null;
}

/** Coerce a candidate quest tier into a valid one, or null (bad id/giver). */
export function normalizeQuest(q, giver) {
  if (!q || typeof q !== 'object') return null;
  const id = typeof q.id === 'string' && q.id.trim() ? q.id.trim() : null;
  if (!id || !giver) return null;
  const epilogue = lines(q.epilogue);
  return {
    id,
    title: typeof q.title === 'string' && q.title.trim() ? q.title.trim() : id,
    giver,
    objective: normalizeObjective(q.objective),
    offer: lines(q.offer).length ? lines(q.offer) : ['I could use a hand with something.'],
    progressLine:
      typeof q.progressLine === 'string' && q.progressLine.trim()
        ? q.progressLine
        : 'How goes it? {n} of {count} so far.',
    ready: lines(q.ready).length ? lines(q.ready) : ['You did it. Thank you.'],
    offerPrompt:
      typeof q.offerPrompt === 'string' && q.offerPrompt.trim() ? q.offerPrompt.trim() : 'Do you need help?',
    turninPrompt:
      typeof q.turninPrompt === 'string' && q.turninPrompt.trim() ? q.turninPrompt.trim() : 'It’s done.',
    reward: normalizeReward(q.reward),
    ...(epilogue.length ? { epilogue } : {}),
  };
}

/** Replace a giver's whole questline (empty array removes it).
 *  @returns {object[]} the stored, normalized tiers */
export function setQuestline(giver, quests) {
  if (typeof giver !== 'string' || !giver) return [];
  const clean = (Array.isArray(quests) ? quests : [])
    .map((q) => normalizeQuest(q, giver))
    .filter(Boolean);
  if (clean.length) questlines.set(giver, clean);
  else questlines.delete(giver);
  return clean;
}

/** A giver's questline (empty array when none). */
export function getQuestline(giver) {
  return questlines.get(giver) ?? [];
}

/** Snapshot of every questline: { giverId: [tier, ...], ... }. QuestLog takes
 *  this shape directly. */
export function getQuestlines() {
  return Object.fromEntries([...questlines]);
}

/** @returns {string} JSON of every questline. */
export function serializeQuestRegistry() {
  return JSON.stringify(getQuestlines(), null, 2);
}

/** Replace the whole registry with the questlines in `text`. Authoritative
 *  like the NPC registry: built-ins absent from the file stay absent.
 *  Invalid text leaves the registry untouched. @returns {string[]} giver ids */
export function deserializeQuestRegistry(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  questlines.clear();
  const out = [];
  for (const [giver, quests] of Object.entries(data)) {
    if (setQuestline(giver, quests).length) out.push(giver);
  }
  return out;
}
