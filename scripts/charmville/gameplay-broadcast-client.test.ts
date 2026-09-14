import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {startBroadcastGateway} from '../../lib/charmville/broadcast-gateway';
import {createGameplayBroadcastClient} from './gameplay-broadcast-client.mjs';

class LocalBrowserSocket extends WebSocket {
  constructor(url: string) {super(url, {origin: 'http://localhost:3018'});}
}
async function until(predicate: () => boolean) {for (let index = 0; index < 100; index++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10));} throw Error('Timed out waiting for lifecycle');}

test('browser adapter exchanges peer offers over authenticated real sockets and cleans up on revocation', async () => {
  const one = 'a'.repeat(64), two = 'b'.repeat(64);
  let revision = '0', closedPeers = 0, sourceStopped = false;
  const received: string[] = [], ended: string[] = [];
  const gateway = await startBroadcastGateway({port: 0, origins: ['http://localhost:3018'], refreshMs: 100,
    authenticate: async token => token === one ? '1' : '2',
    resolve: async (token, ownerId) => ({profileId: token === one ? '1' : '2', ownerId, revision: ownerId === '1' ? revision : '0', mode: 'public', allowedIds: []}),
  });
  const peerFactory = ({role, send}: {role: string; send: (message: object) => void}) => ({
    async start() {send({description: {type: 'offer', sdp: 'v=0\r\n'}});},
    async receive(message: {description: {type: string}}) {received.push(`${role}:${message.description.type}`); if (role === 'viewer') send({description: {type: 'answer', sdp: 'v=0\r\n'}});},
    close() {closedPeers++;},
    active: true,
  });
  const browserSocket = LocalBrowserSocket as unknown as typeof globalThis.WebSocket;
  const owner = await createGameplayBroadcastClient({url: gateway.url, token: one, WebSocketImpl: browserSocket, peerFactory, onEnded: (id: string) => {ended.push(id);}, renewMs: 100});
  const viewer = await createGameplayBroadcastClient({url: gateway.url, token: two, WebSocketImpl: browserSocket, peerFactory, onEnded: (id: string) => {ended.push(id);}, renewMs: 100});
  try {
    const id = await owner.publish({getTracks: () => [{kind: 'video', readyState: 'live', stop() {sourceStopped = true;}}]});
    await viewer.subscribe(id);
    await until(() => received.length === 2);
    assert.deepEqual(received.sort(), ['publisher:answer', 'viewer:offer']);
    await assert.rejects(viewer.subscribe(id));
    revision = '1'; await until(() => ended.length === 2);
    assert.equal(closedPeers, 2); assert.equal(sourceStopped, false);
  } finally {owner.close(); viewer.close(); await gateway.close();}
});

test('browser adapter rejects nonlocal endpoints and malformed token before connection', async () => {
  await assert.rejects(createGameplayBroadcastClient({url: 'wss://plank.love/broadcast', token: 'a'.repeat(64)}));
  await assert.rejects(createGameplayBroadcastClient({url: 'ws://localhost:3025/broadcast?token=secret', token: 'a'.repeat(64)}));
  await assert.rejects(createGameplayBroadcastClient({url: 'ws://localhost:3025/broadcast', token: 'bad'}));
});
