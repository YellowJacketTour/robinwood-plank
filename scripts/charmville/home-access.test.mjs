import test from 'node:test';
import assert from 'node:assert/strict';
import { canAccessHome } from './home-access.mjs';
import { resolveTravel } from './travel-graph.mjs';
const grant = { ownerId: 'bob', actorId: 'alice', rights: ['visit', 'help'], expiresAt: 100 };
const access = { actorId: 'alice', ownerId: 'bob', grants: [grant], now: 10 };
test('visitor may help but cannot harvest, build or withdraw', () => {
  for (const right of ['visit', 'help']) assert.equal(canAccessHome({ ...access, right }), true);
  for (const right of ['harvest', 'build', 'storage']) assert.equal(canAccessHome({ ...access, right }), false);
});
test('expiration and revocation deny the next action contact', () => {
  assert.equal(canAccessHome({ ...access, now: 100 }), false);
  assert.equal(canAccessHome({ ...access, grants: [{ ...grant, revoked: true }] }), false);
  assert.equal(canAccessHome({ ...access, actorId: 'eve' }), false);
});
test('storage is scoped to a named container and requires visit', () => {
  const storage = { ...grant, rights: ['visit', 'storage'], containers: ['shared'] };
  assert.equal(canAccessHome({ ...access, grants: [storage], right: 'storage', containerId: 'shared' }), true);
  assert.equal(canAccessHome({ ...access, grants: [storage], right: 'storage', containerId: 'private' }), false);
  assert.equal(canAccessHome({ ...access, grants: [{ ...storage, rights: ['storage'] }], right: 'storage', containerId: 'shared' }), false);
});
test('friend gate targets the owner home and permits an authorized departure', () => {
  const input = { actorId: 'alice', portalId: 'return-home', destinationOwnerId: 'bob', grants: [grant], now: 10,
    current: { region: 'meadow', instance: 'meadow:public', x: 128, y: 16 } };
  assert.equal(resolveTravel(input).destination.instance, 'home:bob');
  assert.equal(resolveTravel({ ...input, grants: [] }).reason, 'destination-access-denied');
  assert.equal(resolveTravel({ ...input, now: undefined }).reason, 'destination-access-denied');
  assert.equal(resolveTravel({ ...input, portalId: 'home-gate', current: { region: 'home', instance: 'home:bob', x: 128, y: 152 } }).destination.instance, 'meadow:public');
});
