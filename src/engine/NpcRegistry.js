// NpcRegistry.js — registry of NPC character definitions.
//
// Mirrors ItemRegistry/EquipmentRegistry: the editor's F4 panel authors NPC
// types, they persist to localStorage and ship inside the world bundle, and
// the playable game reads them to spawn talkable characters. A built-in
// starter (the granny) is always present so a fresh install has someone to
// meet; she can be edited or overridden like any other definition, and a
// registry reset brings her defaults back.
//
// An NPC def:
//   { id, name, skin, height, dialog: [line, ...],
//     greeting, topics: [{ label, lines: [line, ...] }, ...] }
// `skin` names a drawn character sheet (mobSprites.MOB_SKINS); `dialog` is
// the chit-chat played on first meeting; `greeting` opens every later talk;
// `topics` are optional lore questions the player can ask in the dialogue
// (label = the player's question, lines = the NPC's answer) — see
// game/Dialogue.js for how a conversation walks these.
//
// Pure module (no three.js/DOM) so it unit tests in Node.

export const NPC_HEIGHT_MIN = 1.2;
export const NPC_HEIGHT_MAX = 2.2;

export const BUILTIN_NPCS = Object.freeze({
  bolek: Object.freeze({
    id: 'bolek',
    name: 'Bolek',
    skin: 'bolek',
    // Seated in his wheelchair — the sprite fills the full standing rows, so
    // height is his real-world seated height, head to wheel rims.
    height: 1.35,
    dialog: Object.freeze([
      'Awake at last. I’ve been sitting here half the night listening to the world end and waiting for you to sleep through it.',
      'Something’s wrong out there, kid. The phones are dead, the streetlights too — and the neighbors… the neighbors aren’t right.',
      'Whatever this is, we handle it like we handle everything since your mother left for Halina’s: calm, careful, one thing at a time.',
    ]),
    greeting: 'Come here a moment, kid. These wheels don’t pace, so I do my worrying sitting still.',
    topics: Object.freeze([
      Object.freeze({
        label: 'What happened to your legs?',
        lines: Object.freeze([
          'The scaffolding at the Zakłady, eleven years back. Three stories straight down, and the safety line was clipped to nothing.',
          'I don’t miss the legs half as much as I miss the work. A man builds things his whole life, then one Tuesday he’s furniture.',
          'Don’t make that face. I got the chair, the pension, and you — two out of three still work.',
        ]),
      }),
      Object.freeze({
        label: 'Where’s mom?',
        lines: Object.freeze([
          'At your aunt Halina’s, out in the country — went the week before all this started. First time in my life I’ve been glad she never listens to me.',
          'Knowing her, she’s got the whole village fed, barricaded, and feeling guilty about something by now.',
          'When the phones come back she’ll call, and we’ll tell her we had it all under control. Agreed?',
        ]),
      }),
    ]),
  }),
  granny: Object.freeze({
    id: 'granny',
    name: 'Granny',
    skin: 'granny',
    height: 1.62,
    dialog: Object.freeze([
      'Oh, hello dearie. A living face — haven’t seen one of those in weeks.',
      'The dead ones don’t count. They shuffle past my window all night, moaning about who knows what.',
      'I’d offer you tea, but the kettle’s gone the way of everything else around here.',
      'You be careful out there, love. And if you find a tin of peaches, you know where I live.',
    ]),
    greeting: 'Back again, dearie? Good — the quiet was getting loud.',
    topics: Object.freeze([
      Object.freeze({
        label: 'What happened here?',
        lines: Object.freeze([
          'Nobody rightly knows, love. One Tuesday the sirens went, and by Friday the neighbors were eating each other.',
          'The radio said stay indoors, then it said nothing at all. I’ve been minding my own business ever since.',
          'The town’s still here, mind you. It’s just the people that went wrong.',
        ]),
      }),
      Object.freeze({
        label: 'Who’s Stefan?',
        lines: Object.freeze([
          'My husband, rest him. Forty-one years, and not one of them boring.',
          'He fixed clocks. The whole flat used to tick like a heartbeat. It’s the silence I can’t get used to.',
          'He’d have liked you — he always liked people who showed up armed and polite.',
        ]),
      }),
    ]),
  }),
});

const npcs = new Map();
resetNpcRegistry();

/** Restore the registry to the built-in set. */
export function resetNpcRegistry() {
  npcs.clear();
  for (const def of Object.values(BUILTIN_NPCS)) npcs.set(def.id, def);
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function cleanLines(v) {
  return (Array.isArray(v) ? v : [])
    .filter((l) => typeof l === 'string' && l.trim().length)
    .map((l) => l.trim());
}

/** Coerce a candidate def into a valid one, or null (bad/missing id). */
export function normalizeNpc(def) {
  if (!def || typeof def.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(def.id)) return null;
  const dialog = cleanLines(def.dialog);
  const topics = (Array.isArray(def.topics) ? def.topics : [])
    .map((t) => {
      const label = typeof t?.label === 'string' ? t.label.trim() : '';
      const lines = cleanLines(t?.lines);
      return label && lines.length ? { label, lines } : null;
    })
    .filter(Boolean);
  return {
    id: def.id,
    name: typeof def.name === 'string' && def.name.trim() ? def.name.trim() : def.id,
    skin: typeof def.skin === 'string' && def.skin ? def.skin : 'granny',
    height: clampNum(def.height, NPC_HEIGHT_MIN, NPC_HEIGHT_MAX, 1.65),
    dialog: dialog.length ? dialog : ['...'],
    greeting: typeof def.greeting === 'string' && def.greeting.trim() ? def.greeting.trim() : 'Hello again.',
    topics,
  };
}

/** Register (or replace) an NPC def. @returns {object|null} the stored def */
export function registerNpc(def) {
  const clean = normalizeNpc(def);
  if (!clean) return null;
  npcs.set(clean.id, clean);
  return clean;
}

/** NPC def by id, or null. */
export function getNpc(id) {
  return npcs.get(id) ?? null;
}

/** True when an id names a registered NPC. */
export function isNpcId(id) {
  return npcs.has(id);
}

/** Every registered NPC def, in insertion order. */
export function listNpcs() {
  return [...npcs.values()];
}

/** Remove an NPC def. Built-ins can be removed too (a reset or a bundle load
 *  without them keeps them gone — the author's roster is authoritative). */
export function removeNpc(id) {
  return npcs.delete(id);
}

/** @returns {string} JSON of every registered NPC def. */
export function serializeNpcRegistry() {
  return JSON.stringify(listNpcs(), null, 2);
}

/** Replace the whole registry with the defs in `text`. The author's roster is
 *  authoritative: a file without the built-in granny loads without her (she
 *  was deleted on purpose). Invalid text leaves the registry untouched.
 *  @returns {object[]} registered defs */
export function deserializeNpcRegistry(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  npcs.clear();
  const out = [];
  for (const def of data) {
    const stored = registerNpc(def);
    if (stored) out.push(stored);
  }
  return out;
}
