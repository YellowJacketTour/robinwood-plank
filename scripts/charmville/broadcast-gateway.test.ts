import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {startBroadcastGateway} from '../../lib/charmville/broadcast-gateway';

const origin = 'http://localhost:3018';
function connect(url: string, from = origin) {
  const socket = new WebSocket(url, {origin: from});
  const messages: Record<string, unknown>[] = [];
  socket.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
  return {socket, async ready() {await new Promise<void>((resolve, reject) => {socket.once('open', resolve); socket.once('error', reject);});},
    async next(type: string) {for (let attempt = 0; attempt < 100; attempt++) {const index = messages.findIndex(message => message.type === type); if (index >= 0) return messages.splice(index, 1)[0]; await new Promise(resolve => setTimeout(resolve, 10));} throw Error(`Missing ${type}`);},
    send(message: object) {socket.send(JSON.stringify(message));},
  };
}
const first = 'a'.repeat(64), second = 'b'.repeat(64);
test('real WebSocket binds identity, routes authorized peer signals and revokes changed policy', async () => {
  let revision = '0';
  const gateway = await startBroadcastGateway({port: 0, origins: [origin], refreshMs: 100,
    authenticate: async token => {if (token === first) return '1'; if (token === second) return '2'; throw Error('invalid');},
    resolve: async (token, ownerId) => ({profileId: token === first ? '1' : '2', ownerId, revision: ownerId === '1' ? revision : '0', mode: 'public', allowedIds: []}),
  });
  const publisher = connect(gateway.url), viewer = connect(gateway.url);
  try {
    await Promise.all([publisher.ready(), viewer.ready()]);
    publisher.send({type: 'authenticate', token: first}); viewer.send({type: 'authenticate', token: second});
    const ownerReady = await publisher.next('broadcast:ready'); await viewer.next('broadcast:ready');
    viewer.send({type: 'start', requestId: 1, ownerId: '1'});
    assert.equal((await viewer.next('broadcast:error')).code, 'rejected');
    publisher.send({type: 'start', requestId: 1, ownerId: '1'});
    const publication = (await publisher.next('broadcast:result')).result as {id: string};
    viewer.send({type: 'subscribe', requestId: 2, publicationId: publication.id});
    const subscription = (await viewer.next('broadcast:result')).result as {viewerConnectionId: string};
    await publisher.next('broadcast:subscriber');
    viewer.send({type: 'signal', requestId: 3, publicationId: publication.id, target: ownerReady.connectionId, signal: {description: {type: 'answer', sdp: 'v=0\r\n'}}});
    const signal = await publisher.next('broadcast:signal');
    assert.equal(signal.from, subscription.viewerConnectionId);
    assert.deepEqual(signal.signal, {description: {type: 'answer', sdp: 'v=0\r\n'}});
    revision = '1';
    assert.equal((await viewer.next('broadcast:ended')).publicationId, publication.id);
  } finally {publisher.socket.terminate(); viewer.socket.terminate(); await gateway.close();}
});

test('rejects remote origins, unauthenticated commands, identity replacement and binary payloads', async () => {
  const gateway = await startBroadcastGateway({port: 0, origins: [origin], authenticate: async () => '1', resolve: async (_token, ownerId) => ({profileId: '1', ownerId, revision: '0', mode: 'public', allowedIds: []})});
  try {
    const denied = connect(gateway.url, 'https://attacker.example'); await assert.rejects(denied.ready()); denied.socket.terminate();
    for (const mode of ['unauthenticated', 'replacement', 'binary']) {
      const client = connect(gateway.url); await client.ready();
      const closed = new Promise<number>(resolve => client.socket.once('close', resolve));
      if (mode === 'replacement') {client.send({type: 'authenticate', token: first}); await client.next('broadcast:ready'); client.send({type: 'authenticate', token: second});}
      else if (mode === 'binary') client.socket.send(Buffer.from('{}'));
      else client.send({type: 'start', requestId: 1, ownerId: '1'});
      assert.equal(await closed, 1008);
    }
  } finally {await gateway.close();}
});

test('bounds frames, expires pending authentication and rejects unbounded configuration', async () => {
  const options = {port: 0, origins: [origin], authTimeoutMs: 100, authenticate: async () => '1', resolve: async (_token: string, ownerId: string) => ({profileId: '1', ownerId, revision: '0', mode: 'public' as const, allowedIds: []})};
  await assert.rejects(startBroadcastGateway({...options, origins: ['https://plank.love']}));
  const gateway = await startBroadcastGateway(options);
  try {
    const idle = connect(gateway.url); await idle.ready();
    assert.equal(await new Promise(resolve => idle.socket.once('close', resolve)), 1008);
    const large = connect(gateway.url); await large.ready();
    const closed = new Promise(resolve => large.socket.once('close', resolve)); large.socket.send('x'.repeat(40961));
    assert.equal(await closed, 1009);
  } finally {await gateway.close();}
});

test('rate-limits authenticated bursts and closes revoked sessions while idle', async () => {
  let admitted = true;
  const gateway = await startBroadcastGateway({port: 0, origins: [origin], refreshMs: 100,
    authenticate: async () => '1',
    resolve: async (_token, ownerId) => {if (!admitted) throw Error('expired'); return {profileId: '1', ownerId, revision: '0', mode: 'public', allowedIds: []};},
  });
  try {
    const fast = connect(gateway.url); await fast.ready(); fast.send({type: 'authenticate', token: first}); await fast.next('broadcast:ready');
    const limited = new Promise(resolve => fast.socket.once('close', resolve));
    for (let requestId = 1; requestId <= 100; requestId++) fast.send({type: 'unsupported', requestId});
    assert.equal(await limited, 1008);
    const idle = connect(gateway.url); await idle.ready(); idle.send({type: 'authenticate', token: first}); await idle.next('broadcast:ready');
    const revoked = new Promise(resolve => idle.socket.once('close', resolve)); admitted = false;
    assert.equal(await revoked, 1008);
  } finally {await gateway.close();}
});
