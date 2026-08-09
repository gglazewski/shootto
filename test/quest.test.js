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
    assert.ok(quest.objective.count > 0);
    assert.ok(['kill', 'collect'].includes(quest.objective.type));
  }
  assert.ok(line.at(-1).epilogue?.length, 'the finale has an epilogue');
});
