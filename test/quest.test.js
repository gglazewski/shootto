// quest.test.js — QuestLog: tiered questlines, choice-driven lifecycle
// (accept/complete), objective progress, tracker, and save/load round-trip.
// The conversation layer on top is covered in dialogue.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { QuestLog, QUESTLINES } from '../src/game/quests.js';

/** A small two-tier questline for focused tests. */
const LINES = {
  granny: [
    {
      id: 't1',
      title: 'First Blood',
      giver: 'granny',
      objective: { type: 'kill', target: 'any', count: 2, noun: 'zombies' },
      offer: ['Kill two of them.'],
      offerPrompt: 'Do you need help?',
      turninPrompt: 'It’s done.',
      progressLine: 'That is {n} of {count}.',
      ready: ['Well done.'],
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
      reward: { ammo: { type: 'pistol', amount: 10 } },
      epilogue: ['All done, dearie.'],
    },
  ],
};

test('a fresh giver offers tier 1; accepting starts it and the tracker', () => {
  const log = new QuestLog(LINES);
  assert.equal(log.statusFor('granny'), 'available');
  assert.equal(log.questFor('granny').id, 't1');

  const result = log.accept('granny');
  assert.equal(result.accepted.id, 't1');
  assert.equal(log.statusFor('granny'), 'active');
  assert.equal(log.tracker().title, 'First Blood');
  assert.equal(log.tracker().text, 'zombies 0/2');
});

test('accept/complete apply only in the matching status', () => {
  const log = new QuestLog(LINES);
  assert.equal(log.complete('granny'), null, 'nothing to turn in yet');
  log.accept('granny');
  assert.equal(log.accept('granny'), null, 'already active');
  assert.equal(log.complete('granny'), null, 'objective not fulfilled');
  assert.equal(log.tracker().text, 'zombies 0/2', 'state unchanged');
});

test('met bookkeeping: intro chit-chat plays once', () => {
  const log = new QuestLog(LINES);
  assert.equal(log.hasMet('granny'), false);
  log.markMet('granny');
  assert.equal(log.hasMet('granny'), true);
});

test('kill progress: counts only while active, flips to ready, then turns in', () => {
  const log = new QuestLog(LINES);
  assert.deepEqual(log.onKill('imp'), [], 'no active quest — nothing counts');
  log.accept('granny');

  let events = log.onKill('imp');
  assert.deepEqual(events.map((e) => [e.quest.id, e.ready]), [['t1', false]]);
  assert.equal(log.tracker().text, 'zombies 1/2');
  assert.equal(log.progressLineFor('granny'), 'That is 1 of 2.');

  events = log.onKill('brute'); // target 'any' takes every mob type
  assert.deepEqual(events.map((e) => [e.quest.id, e.ready]), [['t1', true]]);
  assert.equal(log.statusFor('granny'), 'ready');
  assert.equal(log.tracker().text, 'Return to Granny');
  assert.deepEqual(log.onKill('imp'), [], 'ready quests stop counting');

  const result = log.complete('granny');
  assert.equal(result.completed.id, 't1');
  assert.deepEqual(result.reward, { armor: 25 });
});

test('turning a tier in unlocks the next tier from the same giver', () => {
  const log = new QuestLog(LINES);
  log.accept('granny');
  log.onKill('imp');
  log.onKill('imp');
  log.complete('granny');
  assert.equal(log.statusFor('granny'), 'available');
  assert.equal(log.questFor('granny').id, 't2', 'tier 2 now on offer');
});

test('collect objectives match by equip-item kind and ignore the rest', () => {
  const log = new QuestLog(LINES);
  log.accept('granny');
  log.onKill('imp');
  log.onKill('imp');
  log.complete('granny');
  log.accept('granny'); // t2

  assert.deepEqual(log.onCollect({ id: 'axe', kind: 'weapon' }), [], 'weapons do not count');
  const events = log.onCollect({ id: 'pistol-box', kind: 'ammo' });
  assert.deepEqual(events.map((e) => [e.quest.id, e.ready]), [['t2', true]]);
});

test('an exhausted questline goes done, keeps its epilogue, offers nothing more', () => {
  const log = new QuestLog(LINES);
  log.accept('granny');
  log.onKill('imp');
  log.onKill('imp');
  log.complete('granny');
  log.accept('granny');
  log.onCollect({ id: 'x', kind: 'ammo' });
  const result = log.complete('granny');
  assert.equal(result.completed.id, 't2');

  assert.equal(log.statusFor('granny'), 'done');
  assert.equal(log.questFor('granny'), null);
  assert.deepEqual(log.epilogueFor('granny'), ['All done, dearie.']);
  assert.equal(log.accept('granny'), null);
  assert.equal(log.complete('granny'), null);
  assert.equal(log.tracker(), null);
});

test('serialize/deserialize round-trips mid-quest state', () => {
  const log = new QuestLog(LINES);
  log.markMet('granny');
  log.accept('granny');
  log.onKill('imp');

  const restored = QuestLog.deserialize(log.serialize(), LINES);
  assert.equal(restored.tracker().text, 'zombies 1/2');
  assert.equal(restored.statusFor('granny'), 'active');
  assert.ok(restored.hasMet('granny'), 'no chit-chat replay after load');
});

test('deserialize tolerates missing data and unknown givers', () => {
  assert.equal(QuestLog.deserialize(null, LINES).tracker(), null);
  const restored = QuestLog.deserialize(
    { met: ['granny', 'ghost'], state: { ghost: { tier: 1, status: 'active', progress: 3 }, granny: { tier: 99, status: 'active', progress: 1 } } },
    LINES,
  );
  assert.equal(restored.questFor('ghost'), null);
  assert.equal(restored.questFor('granny'), null, 'out-of-range tier clamps to done');
});

test('the real granny questline is well-formed', () => {
  const line = QUESTLINES.granny;
  assert.ok(line.length >= 3, 'multi-tiered');
  for (const quest of line) {
    assert.equal(quest.giver, 'granny');
    assert.ok(quest.title && quest.offer.length && quest.ready.length);
    assert.ok(quest.offerPrompt && quest.turninPrompt, 'player replies authored');
    assert.ok(quest.progressLine.includes('{count}'));
    for (const o of quest.objectives ?? [quest.objective]) {
      assert.ok(o.count > 0);
      assert.ok(['kill', 'collect', 'visit'].includes(o.type));
    }
  }
  assert.ok(line.at(-1).epilogue?.length, 'the finale has an epilogue');
});

// --- visit areas ---

/** One-tier questline whose objective is standing on marked cells. */
function visitLines(extra = {}) {
  return {
    scout: [{
      id: 'v1',
      title: 'Find the Cellar',
      giver: 'scout',
      objectives: [{ type: 'visit', cells: [[4, 2, 4], [5, 2, 4]], count: 1, noun: 'cellar reached' }],
      offer: ['Find the cellar.'],
      offerPrompt: 'Anything to do?',
      turninPrompt: 'Found it.',
      progressLine: 'Not yet? {n}/{count}.',
      ready: ['Good.'],
      reward: { health: 5 },
      ...extra,
    }],
  };
}

test('visit objective: entering a marked cell fulfills it, anywhere else does not', () => {
  const log = new QuestLog(visitLines());
  assert.deepEqual(log.onVisit(4, 3, 4), [], 'nothing counts before accepting');
  log.accept('scout');
  assert.equal(log.tracker().text, 'cellar reached 0/1');

  assert.deepEqual(log.onVisit(9, 3, 9), [], 'far away — no hit');
  assert.deepEqual(log.onVisit(4, 3, 5), [], 'adjacent column — no hit');
  assert.deepEqual(log.onVisit(4, 6, 4), [], 'flying high above the mark — no hit');

  const events = log.onVisit(4, 3, 4); // feet directly on the marked top face
  assert.deepEqual(events.map((e) => [e.quest.id, e.ready]), [['v1', true]]);
  assert.equal(log.statusFor('scout'), 'ready');
  assert.deepEqual(log.onVisit(4, 3, 4), [], 'met objectives stop counting');
});

test('visit matching tolerates feet at the mark itself and one step above', () => {
  for (const feetY of [2, 3, 4]) {
    const log = new QuestLog(visitLines());
    log.accept('scout');
    assert.equal(log.onVisit(5, feetY, 4).length, 1, `feet y=${feetY} over a y=2 mark counts`);
  }
  const log = new QuestLog(visitLines());
  log.accept('scout');
  assert.equal(log.onVisit(5, 5, 4).length, 0, 'three cells up is no longer "on" the area');
});

// --- multi-goal quests ---

const MULTI = {
  granny: [{
    id: 'm1',
    title: 'The Long Errand',
    giver: 'granny',
    objectives: [
      { type: 'kill', target: 'any', count: 2, noun: 'zombies' },
      { type: 'collect', kinds: ['ammo'], count: 1, noun: 'supplies' },
      { type: 'visit', cells: [[0, 0, 0]], count: 1, noun: 'yard checked' },
    ],
    offer: ['Do all three.'],
    offerPrompt: 'Need help?',
    turninPrompt: 'All done.',
    progressLine: 'So far: {n}/{count}.',
    ready: ['My hero.'],
    reward: { armor: 10 },
  }],
};

test('a quest is ready only when EVERY objective is met', () => {
  const log = new QuestLog(MULTI);
  log.accept('granny');

  assert.deepEqual(log.onKill('imp').map((e) => e.ready), [false]);
  assert.deepEqual(log.onCollect({ id: 'box', kind: 'ammo' }).map((e) => e.ready), [false]);
  assert.deepEqual(log.onVisit(0, 1, 0).map((e) => e.ready), [false]);
  assert.equal(log.statusFor('granny'), 'active', 'two of three objectives still open? no — one left');

  const events = log.onKill('imp'); // second zombie — the last open objective
  assert.deepEqual(events.map((e) => e.ready), [true]);
  assert.equal(log.statusFor('granny'), 'ready');
});

test('multi-goal tracker lists every objective and ticks off the met ones', () => {
  const log = new QuestLog(MULTI);
  log.accept('granny');
  log.onCollect({ id: 'box', kind: 'ammo' });

  const entry = log.trackerEntries()[0];
  assert.deepEqual(entry.lines, [
    { text: 'zombies 0/2', done: false },
    { text: 'supplies 1/1', done: true },
    { text: 'yard checked 0/1', done: false },
  ]);
  assert.equal(entry.text, 'zombies 0/2', 'single-line view shows the first open objective');
  assert.equal(log.progressLineFor('granny'), 'So far: 0/2.', 'nudge follows the first open objective');
});

test('events only fire for quests the event actually advanced', () => {
  const log = new QuestLog(MULTI);
  log.accept('granny');
  log.onCollect({ id: 'box', kind: 'ammo' });
  assert.deepEqual(log.onCollect({ id: 'box2', kind: 'ammo' }), [], 'collect objective already full');
});

test('wantsItem goes cold once the collect objective is met, even mid-quest', () => {
  const log = new QuestLog(MULTI);
  log.accept('granny');
  const pack = { id: 'box', kind: 'ammo' };
  assert.equal(log.wantsItem(pack), true);
  log.onCollect(pack);
  assert.equal(log.statusFor('granny'), 'active', 'kill + visit still open');
  assert.equal(log.wantsItem(pack), false, 'fetch slot already satisfied');
});

test('multi-goal progress survives a save/load round-trip', () => {
  const log = new QuestLog(MULTI);
  log.accept('granny');
  log.onKill('imp');
  log.onCollect({ id: 'box', kind: 'ammo' });

  const restored = QuestLog.deserialize(log.serialize(), MULTI);
  assert.deepEqual(restored.trackerEntries()[0].lines.map((l) => l.done), [false, true, false]);
  assert.equal(restored.trackerEntries()[0].lines[0].text, 'zombies 1/2');
});

test('a legacy save with numeric progress lands in the first objective slot', () => {
  const restored = QuestLog.deserialize(
    { met: [], state: { granny: { tier: 0, status: 'active', progress: 1 } } },
    LINES,
  );
  assert.equal(restored.tracker().text, 'zombies 1/2');
});

// --- quest chains ---

/** Three tiers: walk into the room (auto-completes) -> kill what's inside
 *  (auto-starts) -> a normal turn-in tier. The storytelling chain. */
const CHAIN = {
  scout: [
    {
      id: 'c1',
      title: 'Into the Cellar',
      giver: 'scout',
      objectives: [{ type: 'visit', cells: [[4, 2, 4]], count: 1, noun: 'cellar reached' }],
      autoAccept: true,
      autoComplete: true,
      offer: ['Go in.'],
      offerPrompt: 'What now?',
      turninPrompt: 'I went in.',
      progressLine: 'Go on. {n}/{count}.',
      ready: ['In you go.'],
      reward: { health: 5 },
    },
    {
      id: 'c2',
      title: 'Clear It Out',
      giver: 'scout',
      objectives: [{ type: 'kill', target: 'any', count: 2, noun: 'zombies' }],
      autoAccept: true,
      offer: ['Kill them.'],
      offerPrompt: 'And now?',
      turninPrompt: 'Cellar is clear.',
      progressLine: 'Keep going. {n}/{count}.',
      ready: ['Clean work.'],
      reward: { armor: 10 },
    },
  ],
};

test('autoAcceptAvailable starts flagged openers and is idempotent', () => {
  const log = new QuestLog(CHAIN);
  const events = log.autoAcceptAvailable();
  assert.deepEqual(events.map((e) => [e.quest.id, e.accepted]), [['c1', true]]);
  assert.equal(log.statusFor('scout'), 'active');
  assert.deepEqual(log.autoAcceptAvailable(), [], 'already running — nothing to start');
});

test('an autoComplete tier finishes in the field and chains into the next', () => {
  const log = new QuestLog(CHAIN);
  log.autoAcceptAvailable();

  // Walking into the cellar: c1 goes ready, completes itself (reward in the
  // event), and c2 starts — all from one step.
  const events = log.onVisit(4, 3, 4);
  assert.deepEqual(
    events.map((e) => [e.quest.id, !!e.ready, !!e.completed, !!e.accepted]),
    [
      ['c1', true, false, false],
      ['c1', false, true, false],
      ['c2', false, false, true],
    ],
  );
  assert.deepEqual(events[1].reward, { health: 5 }, 'field completion carries the reward');
  assert.equal(log.questFor('scout').id, 'c2');
  assert.equal(log.statusFor('scout'), 'active');

  // c2 is a normal tier: fulfilling it waits for the turn-in talk.
  log.onKill('imp');
  const done = log.onKill('imp');
  assert.deepEqual(done.map((e) => [e.quest.id, e.ready]), [['c2', true]]);
  assert.equal(log.statusFor('scout'), 'ready', 'no autoComplete — the giver wants to hear it');
  assert.deepEqual(log.complete('scout').reward, { armor: 10 });
  assert.equal(log.statusFor('scout'), 'done');
});

test('a manual turn-in chains into an auto-accepting next tier via autoAcceptAvailable', () => {
  const lines = {
    scout: [
      { ...CHAIN.scout[0], autoAccept: false, autoComplete: false },
      CHAIN.scout[1],
    ],
  };
  const log = new QuestLog(lines);
  log.accept('scout');
  log.onVisit(4, 3, 4);
  log.complete('scout'); // the talk-to-giver turn-in (GameApp calls autoAcceptAvailable after)
  const events = log.autoAcceptAvailable();
  assert.deepEqual(events.map((e) => [e.quest.id, e.accepted]), [['c2', true]]);
  assert.equal(log.statusFor('scout'), 'active');
});

test('lifecycleFlags replays quest history: finished tiers, current accept, "!" entries, in order', () => {
  const FLAGGED = {
    granny: [
      { ...LINES.granny[0], flags: { accept: ['gate-open'], complete: ['yard-safe', '!gate-open'] } },
      { ...LINES.granny[1], flags: { accept: ['cellar-open'], complete: ['repair-open'] } },
    ],
  };
  const log = new QuestLog(FLAGGED);
  assert.deepEqual(log.lifecycleFlags(), [], 'nothing accepted yet — no history');

  log.accept('granny');
  assert.deepEqual(log.lifecycleFlags(), ['gate-open'], 'an active tier contributes its accept list');

  log.onKill('any');
  log.onKill('any');
  log.complete('granny');
  assert.deepEqual(log.lifecycleFlags(), ['gate-open', 'yard-safe', '!gate-open'],
    'a finished tier contributes accept + complete, clears included, in fired order');

  log.accept('granny');
  log.onCollect({ id: 'x', kind: 'ammo' });
  log.complete('granny');
  assert.deepEqual(log.lifecycleFlags(),
    ['gate-open', 'yard-safe', '!gate-open', 'cellar-open', 'repair-open']);

  // The point of the replay: a save made BEFORE the flag was authored still
  // fires it — deserialize against the flagged questline and replay.
  const restored = QuestLog.deserialize(log.serialize(), FLAGGED);
  assert.deepEqual(restored.lifecycleFlags(),
    ['gate-open', 'yard-safe', '!gate-open', 'cellar-open', 'repair-open']);
});
