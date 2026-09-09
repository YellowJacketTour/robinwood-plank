import test from 'node:test';
import assert from 'node:assert/strict';
import { TRAVEL_GRAPH, resolveTravel, validateTravelGraph } from './travel-graph.mjs';

const request = (portalId = 'home-gate', actorId = 'alice') => {
  const portal = TRAVEL_GRAPH.portals[portalId];
  return { actorId, portalId, current: { region: portal.from, instance: portal.from === 'home' ? `home:${actorId}` : 'meadow:public', x: portal.trigger.x, y: portal.trigger.y } };
};

test('home exit resolves public destination with exact facing and safe spawn', () => {
  const result = resolveTravel(request());
  assert.deepEqual(result.destination, { region: 'meadow', instance: 'meadow:public', x: 128, y: 24, facing: 'down' });
  assert.equal(result.cancelActiveAction, false);
});
test('return gate resolves each authenticated player to their own home', () => {
  assert.equal(resolveTravel(request('return-home', 'alice')).destination.instance, 'home:alice');
  assert.equal(resolveTravel(request('return-home', 'bob')).destination.instance, 'home:bob');
});
test('another home or fabricated public instance cannot be exited', () => {
  const input = request(); input.current.instance = 'home:bob';
  assert.equal(resolveTravel(input).reason, 'instance-access-denied');
  const publicInput = request('return-home'); publicInput.current.instance = 'meadow:other';
  assert.equal(resolveTravel(publicInput).reason, 'instance-access-denied');
});
test('travel rejects wrong map, invalid actor, distant and nonfinite positions', () => {
  assert.equal(resolveTravel({ ...request(), actorId: 'alice:home' }).reason, 'invalid-actor');
  for (const x of [0, NaN, Infinity]) {
    const input = request(); input.current.x = x;
    assert.equal(resolveTravel(input).ok, false);
  }
  const input = request(); input.current.region = 'meadow';
  assert.equal(resolveTravel(input).reason, 'wrong-region');
  assert.equal(resolveTravel({ ...request(), portalId: '__proto__' }).reason, 'unknown-portal');
});
test('accepted transition cancels active action without mutating caller state', () => {
  const input = { ...request(), activeAction: { kind: 'watering', reservedItem: 'water' } };
  const before = structuredClone(input);
  assert.equal(resolveTravel(input).cancelActiveAction, true);
  assert.deepEqual(input, before);
  input.current.x = 0;
  assert.equal(Object.hasOwn(resolveTravel(input), 'cancelActiveAction'), false);
});
for (const [portalId, capability] of [['woodland-trail', 'mount'], ['island-dock', 'boat'], ['orbital-launch', 'spacecraft']]) {
  test(`${portalId}: requirement enforced and future map remains unavailable even with gear`, () => {
    assert.deepEqual(resolveTravel(request(portalId)).missing, [capability]);
    assert.equal(resolveTravel({ ...request(portalId), ownedCapabilities: [capability] }).reason, 'destination-unavailable');
  });
}
test('invalid destination coordinates and facing fail graph validation', () => {
  for (const patch of [{ x: 256 }, { y: -1 }, { facing: 'northwest' }]) {
    const graph = structuredClone(TRAVEL_GRAPH);
    Object.assign(graph.portals['home-gate'].spawn, patch);
    assert.throws(() => validateTravelGraph(graph), /Invalid portal/);
  }
  assert.equal(Object.isFrozen(TRAVEL_GRAPH.portals['home-gate'].spawn), true);
});
