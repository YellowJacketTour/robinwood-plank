import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomestead, submitAction, advanceHomestead, cancelAction } from './authority-homestead.mjs';

const actors = { alice: { scene: 'meadow', x: 10, y: 10 }, bob: { scene: 'meadow', x: 10, y: 10 } };
const fresh = () => createHomestead([{ id: 'plot', scene: 'meadow', x: 10, y: 10 }]);
const request = (kind, id = kind) => ({ id, kind, target: 'plot', direction: 1 });
function cycle(input, kind) {
  const result = submitAction(input, 'alice', request(kind), actors);
  assert.equal(result.error, null);
  return advanceHomestead(result.state, input.tick + 48, actors);
}
function grown() {
  let state = cycle(cycle(cycle(fresh(), 'till'), 'plant'), 'water');
  return advanceHomestead(state, state.plots.plot.readyAt, actors);
}

test('windup, contact, recovery and completion use server ticks; input is unchanged', () => {
  const initial = fresh();
  const begun = submitAction(initial, 'alice', request('till'), actors).state;
  assert.equal(initial.requests[JSON.stringify(['alice', 'till'])], undefined);
  let state = advanceHomestead(begun, 27, actors);
  assert.equal(state.plots.plot.stage, 'untilled');
  assert.equal(Object.values(state.requests)[0].phase, 'windup');
  state = advanceHomestead(state, 28, actors);
  assert.equal(state.plots.plot.stage, 'tilled');
  assert.equal(Object.values(state.requests)[0].phase, 'contact');
  state = advanceHomestead(state, 29, actors);
  assert.equal(Object.values(state.requests)[0].phase, 'recovery');
  state = advanceHomestead(state, 48, actors);
  assert.equal(Object.values(state.requests)[0].status, 'complete');
  assert.deepEqual(advanceHomestead(begun, 48, actors), state);
  assert.throws(() => advanceHomestead(state, 47, actors));
});

test('complete farming cycle grants one reward, retries cannot duplicate it', () => {
  const ready = grown();
  let state = submitAction(ready, 'alice', request('harvest'), actors).state;
  state = advanceHomestead(state, ready.tick + 27, actors);
  assert.deepEqual(state.rewards, {});
  state = advanceHomestead(state, ready.tick + 28, actors);
  assert.deepEqual(Object.values(state.rewards), [{ crops: 1, xp: 10 }]);
  const replay = submitAction(state, 'alice', request('harvest'), actors);
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.state, state);
  state = advanceHomestead(state, ready.tick + 200, actors);
  assert.deepEqual(Object.values(state.rewards), [{ crops: 1, xp: 10 }]);
  assert.equal(submitAction(state, 'alice', request('water', 'harvest'), actors).error, 'request-id-conflict');
});

test('pre-contact cancellation, departure and disconnect grant no reward', () => {
  for (const mode of ['cancel', 'range', 'scene', 'disconnect']) {
    const ready = grown();
    let state = submitAction(ready, 'alice', request('harvest'), actors).state;
    let positions = actors;
    if (mode === 'cancel') state = cancelAction(state, 'alice', 'harvest').state;
    if (mode === 'range') positions = { alice: { ...actors.alice, x: 100 } };
    if (mode === 'scene') positions = { alice: { ...actors.alice, scene: 'elsewhere' } };
    if (mode === 'disconnect') positions = {};
    state = advanceHomestead(state, ready.tick + 48, positions);
    assert.deepEqual(state.rewards, {}, mode);
    assert.equal(state.plots.plot.stage, 'growing');
  }
});

test('recovery cancellation preserves committed harvest', () => {
  const ready = grown();
  let state = submitAction(ready, 'alice', request('harvest'), actors).state;
  state = advanceHomestead(state, ready.tick + 28, actors);
  state = cancelAction(state, 'alice', 'harvest').state;
  state = advanceHomestead(state, ready.tick + 100, actors);
  assert.deepEqual(Object.values(state.rewards), [{ crops: 1, xp: 10 }]);
});

test('rejects invalid targets, stages, scenes, ranges and premature harvest', () => {
  assert.equal(submitAction(fresh(), 'alice', { ...request('till'), target: 'missing' }, actors).error, 'unknown-target');
  assert.equal(submitAction(fresh(), 'alice', request('plant'), actors).error, 'wrong-stage');
  assert.equal(submitAction(fresh(), 'alice', request('till'), {}).error, 'wrong-scene');
  assert.equal(submitAction(fresh(), 'alice', request('till'), { alice: { ...actors.alice, x: NaN } }).error, 'out-of-range');
  const watered = cycle(cycle(cycle(fresh(), 'till'), 'plant'), 'water');
  assert.equal(submitAction(watered, 'alice', request('harvest'), actors).error, 'not-grown');
  assert.equal(submitAction(fresh(), 'alice', { ...request('till'), tick: 999 }, actors).error, 'invalid-request');
});

test('single actor and target reservations prevent concurrent double action', () => {
  const begun = submitAction(fresh(), 'alice', request('till'), actors).state;
  assert.equal(submitAction(begun, 'alice', request('till', 'second'), actors).error, 'actor-busy');
  assert.equal(submitAction(begun, 'bob', request('till'), actors).error, 'target-busy');
  assert.equal(submitAction(begun, 'alice', request('till'), actors).replay, true);
});
