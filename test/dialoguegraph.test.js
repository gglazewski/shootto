// dialoguegraph.test.js — DialogueGraph: the branching-conversation shape
// (normalizer), its persistence through the quest/NPC registries, and the
// Dialogue runtime walking a quest's "about the quest" tree and an NPC's
// small-talk tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDialogueGraph } from '../src/engine/DialogueGraph.js';
import { normalizeQuest } from '../src/engine/QuestRegistry.js';
import { normalizeNpc } from '../src/engine/NpcRegistry.js';
import { Dialogue, BYE_LABEL } from '../src/game/Dialogue.js';
import { QuestLog } from '../src/game/quests.js';
import { NPC } from '../src/game/NPC.js';

// --- fixtures ---

/** A two-branch tree: root asks, one branch loops deeper, both ends exit. */
function scoutTree() {
  return {
    start: 'root',
    nodes: {
      root: {
        say: ['You’re asking about the scouting job?', 'What do you want to know?'],
        choices: [
          { label: 'Where should I look?', next: 'where' },
          { label: 'Why me?', next: 'why' },
          { label: 'Never mind.', next: null },
        ],
      },
      where: {
        say: ['Past the yard, {n} of {count} streets checked so far.'],
        choices: [{ label: 'Anything else?', next: 'root' }],
      },
      why: { say: ['You’ve got two good legs, kid.'], choices: [] },
    },
  };
}

const LINES = {
  granny: [
    {
      id: 't1',
      title: 'Scout the Area',
      giver: 'granny',
      objectives: [{ type: 'kill', target: 'any', count: 2, noun: 'streets' }],
      offer: ['Go have a look around.'],
      offerPrompt: 'Do you need help?',
      turninPrompt: 'All clear.',
      progressLine: 'Plain nudge {n}/{count}.',
      ready: ['Good.'],
      reward: null,
      about: normalizeDialogueGraph(scoutTree()),
    },
  ],
};

function npc(extra = {}) {
  return {
    type: { id: 'granny' },
    name: 'Granny',
    dialog: ['Hello.'],
    greeting: 'Back again?',
    topics: [],
    ...extra,
  };
}

function toHub(d) {
  for (let i = 0; i < 20 && !d.choices() && !d.done; i++) d.advance();
  return d.choices();
}

function labels(d) {
  return d.choices().map((c) => c.label);
}

function choose(d, label) {
  const choice = d.choices().find((c) => c.label === label);
  assert.ok(choice, `reply "${label}" on offer (have: ${labels(d).join(' | ')})`);
  return d.choose(choice.id);
}

// --- normalizeDialogueGraph ---

test('normalize: trims, drops empty nodes, reroutes dangling choices to end', () => {
  const g = normalizeDialogueGraph({
    start: 'gone',
    nodes: {
      a: { say: ['  hi  ', ''], choices: [{ label: ' go ', next: 'gone' }, { label: '', next: 'a' }] },
      gone: { say: [], choices: [] }, // empty — dropped
    },
  });
  assert.deepEqual(g, {
    start: 'a',
    nodes: { a: { say: ['hi'], choices: [{ label: 'go', next: null }] } },
  });
});

test('normalize: keeps prompt, honors a valid start, null when empty', () => {
  const g = normalizeDialogueGraph({
    prompt: ' Can we talk? ',
    start: 'b',
    nodes: { a: { say: ['first'] }, b: { say: ['second'] } },
  });
  assert.equal(g.prompt, 'Can we talk?');
  assert.equal(g.start, 'b');
  assert.equal(normalizeDialogueGraph(null), null);
  assert.equal(normalizeDialogueGraph({ nodes: {} }), null);
  assert.equal(normalizeDialogueGraph({ nodes: { x: { say: [], choices: [] } } }), null);
});

test('normalize: node map positions round-trip, junk positions are dropped', () => {
  const g = normalizeDialogueGraph({
    nodes: {
      a: { say: ['hi'], pos: [12.4, -30.6] },
      b: { say: ['yo'], pos: ['x', 1] },
    },
  });
  assert.deepEqual(g.nodes.a.pos, [12, -31]);
  assert.equal('pos' in g.nodes.b, false);
});

// --- registry persistence ---

test('normalizeQuest keeps the about tree and the start reward', () => {
  const q = normalizeQuest({
    id: 'q1',
    title: 'Scout',
    objective: { type: 'kill', count: 1 },
    about: scoutTree(),
    startReward: { items: ['baseball-bat'], ammo: { type: 'pistol', amount: 5 } },
  }, 'granny');
  assert.equal(q.about.start, 'root');
  assert.equal(q.about.nodes.root.choices.length, 3);
  assert.deepEqual(q.startReward, { ammo: { type: 'pistol', amount: 5 }, items: ['baseball-bat'] });
});

test('normalizeQuest drops an empty start reward and a useless about tree', () => {
  const q = normalizeQuest({
    id: 'q1',
    objective: { type: 'kill', count: 1 },
    about: { nodes: {} },
    startReward: { health: 0 },
  }, 'granny');
  assert.equal('about' in q, false);
  assert.equal('startReward' in q, false);
});

test('normalizeNpc keeps a chat tree, prompt included', () => {
  const def = normalizeNpc({
    id: 'bystander',
    chat: { prompt: 'Got a minute?', ...scoutTree() },
  });
  assert.equal(def.chat.prompt, 'Got a minute?');
  assert.equal(def.chat.start, 'root');
  const bare = normalizeNpc({ id: 'bystander' });
  assert.equal('chat' in bare, false);
});

// --- Dialogue runtime: quest about tree ---

test('about tree replaces the progress nudge and fills {n}/{count}', () => {
  const quests = new QuestLog(LINES);
  quests.markMet('granny');
  quests.accept('granny');
  quests.onKill('imp');

  const d = new Dialogue({ npc: npc(), quests });
  toHub(d);
  choose(d, 'About “Scout the Area”…');
  assert.equal(d.line(), 'You’re asking about the scouting job?');
  d.advance();
  assert.equal(d.line(), 'What do you want to know?');
  d.advance();
  assert.deepEqual(labels(d), ['Where should I look?', 'Why me?', 'Never mind.']);

  choose(d, 'Where should I look?');
  assert.equal(d.line(), 'Past the yard, 1 of 2 streets checked so far.');
  d.advance();
  assert.deepEqual(labels(d), ['Anything else?'], 'branch offers its own replies');

  choose(d, 'Anything else?');
  assert.equal(d.line(), 'You’re asking about the scouting job?', 'loops back to the root node');
});

test('a leaf node and an end reply both drop back to the hub', () => {
  const quests = new QuestLog(LINES);
  quests.markMet('granny');
  quests.accept('granny');

  const d = new Dialogue({ npc: npc(), quests });
  toHub(d);
  choose(d, 'About “Scout the Area”…');
  toHub(d);
  choose(d, 'Why me?'); // leaf: one line, no choices
  assert.equal(d.line(), 'You’ve got two good legs, kid.');
  d.advance();
  assert.ok(labels(d).includes(BYE_LABEL), 'leaf falls out to the hub');

  choose(d, 'About “Scout the Area”…'); // replayable
  toHub(d);
  choose(d, 'Never mind.'); // explicit end reply
  assert.ok(labels(d).includes(BYE_LABEL), 'end reply falls out to the hub');
  assert.equal(quests.statusFor('granny'), 'active', 'tree talk touches no quest state');
});

test('a quest without an about tree keeps the plain progress line', () => {
  const lines = { granny: [{ ...LINES.granny[0], about: undefined }] };
  const quests = new QuestLog(lines);
  quests.markMet('granny');
  quests.accept('granny');

  const d = new Dialogue({ npc: npc(), quests });
  toHub(d);
  choose(d, 'About “Scout the Area”…');
  assert.equal(d.line(), 'Plain nudge 0/2.');
});

// --- Dialogue runtime: turn-in debrief tree ---

test('a debrief tree plays after the turn-in commit and walks back to the hub', () => {
  const debrief = normalizeDialogueGraph({
    start: 'ask',
    nodes: {
      ask: {
        say: ['So? Out with it — what was down there?'],
        choices: [
          { label: 'The dead. Walking.', next: 'dead' },
          { label: 'You don’t want to know.', next: null },
        ],
      },
      dead: { say: ['So the radio wasn’t raving after all.'], choices: [] },
    },
  });
  const lines = {
    granny: [
      { ...LINES.granny[0], about: undefined, debrief, reward: { armor: 10 } },
      {
        id: 't2',
        title: 'Next Job',
        giver: 'granny',
        objectives: [{ type: 'kill', target: 'any', count: 1, noun: 'zombie' }],
        offer: ['One more.'],
        offerPrompt: 'Anything else?',
        turninPrompt: 'Done.',
        progressLine: '{n}/{count}.',
        ready: ['Good.'],
        reward: null,
      },
    ],
  };
  const quests = new QuestLog(lines);
  quests.markMet('granny');
  quests.accept('granny');
  quests.onKill('a');
  quests.onKill('b');

  const d = new Dialogue({ npc: npc(), quests });
  toHub(d);
  const result = choose(d, 'All clear.');
  assert.equal(result.completed.id, 't1', 'the reply itself commits the quest');
  assert.deepEqual(result.reward, { armor: 10 }, 'reward rides the commit, not the tree');
  assert.equal(d.line(), 'So? Out with it — what was down there?', 'debrief replaces the ready lines');
  d.advance();
  choose(d, 'The dead. Walking.');
  assert.equal(d.line(), 'So the radio wasn’t raving after all.');
  d.advance();
  assert.equal(labels(d)[0], 'Anything else?', 'hub already offers the next tier after the debrief');
});

// --- Dialogue runtime: NPC small talk ---

test('an NPC chat tree joins the hub under its prompt and walks the same way', () => {
  const quests = new QuestLog({});
  quests.markMet('granny');
  const chat = normalizeDialogueGraph({ prompt: 'Got a minute?', ...scoutTree() });
  const d = new Dialogue({ npc: npc({ chat }), quests });
  toHub(d);
  assert.deepEqual(labels(d), ['Got a minute?', BYE_LABEL]);

  choose(d, 'Got a minute?');
  d.advance();
  d.advance();
  choose(d, 'Where should I look?');
  assert.equal(d.line(), 'Past the yard, {n} of {count} streets checked so far.',
    'no quest context — placeholders stay literal');
  d.advance();
  choose(d, 'Anything else?');
  assert.equal(d.line(), 'You’re asking about the scouting job?');
});

test('a spawned NPC carries its chat tree into the conversation', () => {
  // The in-game path: registry def -> placed NPC instance -> Dialogue. The
  // NPC copy must forward `chat`, or authored small talk never shows up.
  const type = normalizeNpc({
    id: 'bolek',
    dialog: ['Hello.'],
    chat: { prompt: 'Got a minute?', ...scoutTree() },
  });
  const spawned = new NPC({ type, feet: { x: 0, y: 0, z: 0 } });
  const quests = new QuestLog({});
  quests.markMet('bolek');
  const d = new Dialogue({ npc: spawned, quests });
  toHub(d);
  assert.deepEqual(labels(d), ['Got a minute?', BYE_LABEL]);
});

test('a spawned NPC carries its services into the conversation', () => {
  // Same trap as chat above: registry def -> placed NPC instance -> Dialogue.
  // The NPC copy must forward `services`, or an authored repair service
  // never shows up in the actual game (only in tests that hand-build npcs).
  const type = normalizeNpc({
    id: 'bolek',
    dialog: ['Hello.'],
    services: [{ type: 'repair', label: 'Fix my axe?' }],
  });
  const spawned = new NPC({ type, feet: { x: 0, y: 0, z: 0 } });
  const quests = new QuestLog({});
  quests.markMet('bolek');
  const d = new Dialogue({ npc: spawned, quests });
  toHub(d);
  assert.deepEqual(labels(d), ['Fix my axe?', BYE_LABEL]);
});

test('picking a craft service reply hands it back to the caller', () => {
  // GameApp routes the returned { service } to the workbench screen — the
  // same hand-off repair uses. The hub drops back underneath so the chat
  // continues when the screen closes.
  const type = normalizeNpc({
    id: 'bolek',
    dialog: ['Hello.'],
    services: [{ type: 'craft', label: 'Forge me something.' }],
  });
  const spawned = new NPC({ type, feet: { x: 0, y: 0, z: 0 } });
  const quests = new QuestLog({});
  quests.markMet('bolek');
  const d = new Dialogue({ npc: spawned, quests });
  toHub(d);
  assert.deepEqual(labels(d), ['Forge me something.', BYE_LABEL]);
  const result = d.choose(d.choices()[0].id);
  assert.deepEqual(result, { service: { type: 'craft', label: 'Forge me something.' } });
  // The conversation sits back on its hub after the hand-off.
  assert.deepEqual(labels(d), ['Forge me something.', BYE_LABEL]);
  assert.equal(d.done, false);
});

test('a chat tree without a prompt gets the stock hub label', () => {
  const quests = new QuestLog({});
  quests.markMet('granny');
  const chat = normalizeDialogueGraph(scoutTree());
  const d = new Dialogue({ npc: npc({ chat }), quests });
  toHub(d);
  assert.deepEqual(labels(d), ['Can we talk?', BYE_LABEL]);
});
