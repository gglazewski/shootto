// dialogue.test.js — Dialogue: the choice-driven conversation machine on top
// of QuestLog. Intro chit-chat -> hub replies (quest offer / progress /
// turn-in, lore topics, bye); quest effects commit on the picked reply.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Dialogue, ACCEPT_LABEL, DECLINE_LABEL, BYE_LABEL } from '../src/game/Dialogue.js';
import { QuestLog } from '../src/game/quests.js';
import { GameFlags } from '../src/game/Reactions.js';

const LINES = {
  granny: [
    {
      id: 't1',
      title: 'First Blood',
      giver: 'granny',
      objective: { type: 'kill', target: 'any', count: 2, noun: 'zombies' },
      offer: ['Kill two of them.', 'They moan all night.'],
      offerPrompt: 'Do you need help?',
      turninPrompt: 'The yard is quiet now.',
      progressLine: 'That is {n} of {count}.',
      ready: ['Well done.', 'Take this.'],
      reward: { armor: 25 },
    },
    {
      id: 't2',
      title: 'Supplies',
      giver: 'granny',
      objective: { type: 'collect', kinds: ['ammo'], count: 1, noun: 'supplies' },
      offer: ['Bring me an ammo pack.'],
      offerPrompt: 'Anything else?',
      turninPrompt: 'Got your supplies.',
      progressLine: 'Anything yet? {n}/{count}.',
      ready: ['Good scavenging.'],
      reward: null,
      epilogue: ['All done, dearie.', 'Off you pop.'],
    },
  ],
};

function granny() {
  return {
    type: { id: 'granny' },
    name: 'Granny',
    dialog: ['Hello there.', 'Nice weather for the end of the world.'],
    greeting: 'Back again, dearie?',
    topics: [
      { label: 'What happened here?', lines: ['Sirens on Tuesday.', 'Silence by Friday.'] },
      { label: 'Who’s Stefan?', lines: ['My husband, rest him.'] },
    ],
  };
}

/** Step through NPC lines until replies appear (or the dialogue ends). */
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

test('first meeting: intro plays line by line, then the hub replies appear', () => {
  const quests = new QuestLog(LINES);
  const d = new Dialogue({ npc: granny(), quests });

  assert.equal(d.line(), 'Hello there.');
  assert.equal(d.choices(), null, 'NPC still talking');
  d.advance();
  assert.equal(d.line(), 'Nice weather for the end of the world.');
  d.advance(); // last line -> hub
  assert.deepEqual(labels(d), ['Do you need help?', 'What happened here?', 'Who’s Stefan?', BYE_LABEL]);
  assert.equal(d.line(), 'Nice weather for the end of the world.', 'last line stays on screen');
  assert.ok(quests.hasMet('granny'), 'reaching the hub counts as met');
});

test('walking away mid-intro replays the chit-chat next time', () => {
  const quests = new QuestLog(LINES);
  const d = new Dialogue({ npc: granny(), quests });
  d.advance(); // abandoned before the hub
  assert.equal(quests.hasMet('granny'), false);

  const again = new Dialogue({ npc: granny(), quests });
  assert.equal(again.line(), 'Hello there.', 'intro replays');
});

test('offer: the pitch plays, accepting commits the quest', () => {
  const quests = new QuestLog(LINES);
  const d = new Dialogue({ npc: granny(), quests });
  toHub(d);

  assert.equal(choose(d, 'Do you need help?'), null, 'nothing commits yet');
  assert.equal(d.line(), 'Kill two of them.');
  d.advance();
  assert.equal(d.line(), 'They moan all night.');
  d.advance();
  assert.deepEqual(labels(d), [ACCEPT_LABEL, DECLINE_LABEL]);

  const result = choose(d, ACCEPT_LABEL);
  assert.equal(result.accepted.id, 't1');
  assert.equal(quests.statusFor('granny'), 'active');
  assert.ok(labels(d).some((l) => l.includes('First Blood')), 'hub now offers the progress nudge');
});

test('declining an offer leaves the quest available', () => {
  const quests = new QuestLog(LINES);
  const d = new Dialogue({ npc: granny(), quests });
  toHub(d);
  choose(d, 'Do you need help?');
  toHub(d);
  assert.equal(choose(d, DECLINE_LABEL), null);
  assert.equal(quests.statusFor('granny'), 'available');
  assert.deepEqual(labels(d)[0], 'Do you need help?', 'the offer is back on the hub');
});

test('progress reply plays the templated nudge and returns to the hub', () => {
  const quests = new QuestLog(LINES);
  quests.markMet('granny');
  quests.accept('granny');
  quests.onKill('imp');

  const d = new Dialogue({ npc: granny(), quests });
  assert.equal(d.line(), 'Back again, dearie?', 'greeting, no intro replay');
  toHub(d);
  choose(d, 'About “First Blood”…');
  assert.equal(d.line(), 'That is 1 of 2.');
  d.advance();
  assert.ok(labels(d).includes(BYE_LABEL), 'back at the hub');
});

test('turn-in commits on the reply, pays, and unlocks the next tier', () => {
  const quests = new QuestLog(LINES);
  quests.markMet('granny');
  quests.accept('granny');
  quests.onKill('imp');
  quests.onKill('imp');

  const d = new Dialogue({ npc: granny(), quests });
  toHub(d);
  const result = choose(d, 'The yard is quiet now.');
  assert.equal(result.completed.id, 't1');
  assert.deepEqual(result.reward, { armor: 25 });
  assert.equal(quests.statusFor('granny'), 'available', 'tier 2 unlocked');
  assert.equal(d.line(), 'Well done.');
  d.advance();
  d.advance();
  assert.equal(labels(d)[0], 'Anything else?', 'next tier on offer in the same chat');
});

test('lore topics answer and come back to the hub, repeatably', () => {
  const quests = new QuestLog(LINES);
  quests.markMet('granny');
  const d = new Dialogue({ npc: granny(), quests });
  toHub(d);

  choose(d, 'What happened here?');
  assert.equal(d.line(), 'Sirens on Tuesday.');
  d.advance();
  assert.equal(d.line(), 'Silence by Friday.');
  d.advance();
  assert.ok(labels(d).includes('What happened here?'), 'topic can be asked again');

  choose(d, 'Who’s Stefan?');
  assert.equal(d.line(), 'My husband, rest him.');
});

test('bye ends the conversation without side effects', () => {
  const quests = new QuestLog(LINES);
  const d = new Dialogue({ npc: granny(), quests });
  toHub(d);
  assert.equal(choose(d, BYE_LABEL), null);
  assert.ok(d.done);
  assert.equal(quests.statusFor('granny'), 'available', 'no quest touched');
});

test('a finished questline opens with the epilogue and offers only lore', () => {
  const quests = new QuestLog(LINES);
  quests.markMet('granny');
  quests.accept('granny');
  quests.onKill('a');
  quests.onKill('b');
  quests.complete('granny');
  quests.accept('granny');
  quests.onCollect({ id: 'x', kind: 'ammo' });
  quests.complete('granny');

  const d = new Dialogue({ npc: granny(), quests });
  assert.equal(d.line(), 'All done, dearie.');
  d.advance();
  assert.equal(d.line(), 'Off you pop.');
  d.advance();
  assert.deepEqual(labels(d), ['What happened here?', 'Who’s Stefan?', BYE_LABEL], 'no quest replies left');
});

test('an NPC with no questline still chats: greeting, topics, bye', () => {
  const quests = new QuestLog({});
  const npc = granny();
  npc.type = { id: 'bystander' };
  const d = new Dialogue({ npc, quests });
  toHub(d);
  assert.deepEqual(labels(d), ['What happened here?', 'Who’s Stefan?', BYE_LABEL]);
});

// --- services (NPC repair etc. — see NpcRegistry `services`) ---

function smith(services) {
  return {
    type: { id: 'smith' },
    name: 'Smith',
    dialog: ['I fix things.'],
    greeting: 'Back with more dents?',
    services,
  };
}

test('an ungated service is a hub reply; picking it hands the service back and stays on the hub', () => {
  const quests = new QuestLog({});
  const service = { type: 'repair', label: 'Could you fix up my gear?' };
  const d = new Dialogue({ npc: smith([service]), quests });
  toHub(d);
  assert.deepEqual(labels(d), ['Could you fix up my gear?', BYE_LABEL]);

  const result = choose(d, 'Could you fix up my gear?');
  assert.deepEqual(result, { service });
  assert.equal(d.done, false, 'the chat stays open under the service screen');
  assert.deepEqual(labels(d), ['Could you fix up my gear?', BYE_LABEL], 'back on the hub');
});

test('a flag-gated service stays hidden until its signal is raised', () => {
  const quests = new QuestLog({});
  const flags = new GameFlags();
  const npc = smith([{ type: 'repair', label: 'Fix my axe?', flag: 'workshop-open' }]);

  const before = new Dialogue({ npc, quests, flags });
  toHub(before);
  assert.deepEqual(labels(before), [BYE_LABEL], 'signal down — no repair on offer');

  flags.set('workshop-open'); // e.g. a quest completed
  const after = new Dialogue({ npc, quests, flags });
  toHub(after);
  assert.deepEqual(labels(after), ['Fix my axe?', BYE_LABEL]);
});

test('a turn-in that raises the gating signal reveals the service in the same conversation', () => {
  // The tier has NO ready lines, so choose('turnin') rebuilds the hub
  // synchronously — before the caller can apply the completion flags. The
  // caller then applies them and calls refreshHub(), like GameApp does.
  const quests = new QuestLog({
    smith: [{
      id: 's1',
      title: 'Spare Parts',
      giver: 'smith',
      objective: { type: 'collect', kinds: ['ammo'], count: 1, noun: 'parts' },
      offer: ['Bring me parts.'],
      offerPrompt: 'Need anything?',
      turninPrompt: 'Got your parts.',
      progressLine: '{n}/{count}.',
      ready: [],
      flags: { complete: ['workshop-open'] },
    }],
  });
  const flags = new GameFlags();
  const npc = smith([{ type: 'repair', label: 'Fix my axe?', flag: 'workshop-open' }]);
  const d = new Dialogue({ npc, quests, flags });
  toHub(d);
  choose(d, 'Need anything?');
  for (let i = 0; i < 20 && !d.choices(); i++) d.advance();
  choose(d, ACCEPT_LABEL);
  quests.onCollect({ id: 'x', kind: 'ammo' });
  d.refreshHub(); // the replies predate the collect — catch them up

  const result = choose(d, 'Got your parts.');
  assert.equal(result.completed.id, 's1');
  assert.ok(!labels(d).includes('Fix my axe?'), 'hub built inside choose() predates the flag');

  flags.set('workshop-open'); // GameApp: applyFlagList(result.completed.flags.complete)
  d.refreshHub();
  assert.ok(labels(d).includes('Fix my axe?'), 'refreshHub catches the freshly raised signal');
});

test('refreshHub is a no-op while the NPC is mid-lines', () => {
  const quests = new QuestLog({});
  const d = new Dialogue({ npc: smith([{ type: 'repair', label: 'Fix it?' }]), quests });
  assert.equal(d.choices(), null, 'still on the intro');
  d.refreshHub();
  assert.equal(d.choices(), null, 'no replies forced mid-speech');
});

test('a "!" signal inverts the gate, like a light bound to !power', () => {
  const quests = new QuestLog({});
  const flags = new GameFlags();
  const npc = smith([{ type: 'repair', label: 'Fix it?', flag: '!shop-burned' }]);

  const open = new Dialogue({ npc, quests, flags });
  toHub(open);
  assert.deepEqual(labels(open), ['Fix it?', BYE_LABEL], 'flag down, inverted gate is open');

  flags.set('shop-burned');
  const burned = new Dialogue({ npc, quests, flags });
  toHub(burned);
  assert.deepEqual(labels(burned), [BYE_LABEL]);
});
