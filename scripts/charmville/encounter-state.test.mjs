import test from 'node:test';
import assert from 'node:assert/strict';
import { createEncounter, encounterAction as act } from './encounter-state.mjs';
const fresh = () => createEncounter({ id: 'wild-1', species: 'cow', maxHp: 100, hp: 100, statuses: [] }, { alice: 3, bob: 3 });
const request = (id, kind) => ({ id, kind });
const claimed = () => act(fresh(), 'alice', request('claim', 'claim')).state;
test('single controller, transitions preserve entity HP and statuses in both directions', () => {
  let state = claimed();
  assert.equal(act(state, 'bob', request('claim', 'claim')).error, 'claimed');
  assert.equal(act(state, 'bob', request('hit', 'damage'), { damage: 99 }).error, 'not-controller');
  state = act(state, 'alice', request('hit', 'damage'), { damage: 35 }).state;
  state = act(state, 'alice', request('poison', 'status'), { status: 'poison', active: true }).state;
  state = act(state, 'alice', request('turn', 'enter-turn')).state;
  state = act(state, 'alice', request('turn-hit', 'damage'), { damage: 10 }).state;
  state = act(state, 'alice', request('world', 'return-world')).state;
  assert.equal(state.entity.id, 'wild-1'); assert.equal(state.entity.hp, 55);
  assert.deepEqual(state.entity.statuses, ['poison']); assert.equal(state.entity.mode, 'world');
});
test('capture consumes once and cannot reroll a failed request', () => {
  const initial = claimed();
  const failed = act(initial, 'alice', request('ball', 'capture'), { roll: .8, probability: .5 });
  assert.equal(failed.captured, false); assert.equal(failed.state.balls.alice, 2);
  const replay = act(failed.state, 'alice', request('ball', 'capture'), { roll: 0, probability: 1 });
  assert.equal(replay.replay, true); assert.equal(replay.captured, false);
  assert.equal(replay.state, failed.state); assert.equal(initial.balls.alice, 3);
  assert.equal(act(failed.state, 'alice', request('ball', 'damage'), { damage: 1 }).error, 'request-id-conflict');
});
test('successful capture preserves specimen identity and awards exactly once', () => {
  let state = act(claimed(), 'alice', request('hit', 'damage'), { damage: 70 }).state;
  state = act(state, 'alice', request('ball', 'capture'), { roll: .2, probability: .3 }).state;
  assert.equal(state.specimens['wild-1'].hp, 30); assert.equal(state.entity.owner, 'alice');
  const second = act(state, 'alice', request('another', 'capture'), { roll: 0, probability: 1 });
  assert.equal(second.error, 'already-captured'); assert.equal(second.state.balls.alice, 2);
  assert.equal(Object.keys(second.state.specimens).length, 1);
});
test('defeated creature cannot be captured and no item is spent', () => {
  const state = act(claimed(), 'alice', request('fatal', 'damage'), { damage: 200 }).state;
  const result = act(state, 'alice', request('ball', 'capture'), { roll: 0, probability: 1 });
  assert.equal(result.error, 'defeated'); assert.equal(result.state.balls.alice, 3);
});
test('invalid decision and missing ball do not mutate resources; request input cannot set RNG', () => {
  assert.equal(act(claimed(), 'alice', { id: 'x', kind: 'capture', roll: 0 }).error, 'invalid-request');
  const invalid = act(claimed(), 'alice', request('x', 'capture'), { roll: 1, probability: 1 });
  assert.equal(invalid.error, 'invalid-capture-decision'); assert.equal(invalid.state.balls.alice, 3);
  const state = claimed(); state.balls.alice = 0;
  assert.equal(act(state, 'alice', request('x', 'capture'), { roll: 0, probability: 1 }).error, 'no-ball');
});
test('release enables another controller without healing', () => {
  let state = act(claimed(), 'alice', request('hit', 'damage'), { damage: 20 }).state;
  state = act(state, 'alice', request('release', 'release')).state;
  state = act(state, 'bob', request('claim', 'claim')).state;
  assert.equal(state.entity.controller, 'bob'); assert.equal(state.entity.hp, 80);
});
test('entity identifiers are data even when matching object prototype names', () => {
  let state = createEncounter({ id: '__proto__', species: 'cow', maxHp: 1, hp: 1, statuses: [] }, { alice: 1 });
  state = act(state, 'alice', request('claim', 'claim')).state;
  state = act(state, 'alice', request('capture', 'capture'), { roll: 0, probability: 1 }).state;
  assert.equal(Object.hasOwn(state.specimens, '__proto__'), true);
  assert.equal(state.specimens.__proto__.owner, 'alice');
});
