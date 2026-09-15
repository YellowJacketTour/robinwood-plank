import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {WebSocket} from 'ws';
import {broadcastAuthority} from '../../lib/charmville/broadcast-authority';
import {homeActor} from '../../lib/charmville/home-access-store';
import {startBroadcastGateway} from '../../lib/charmville/broadcast-gateway';
import {createGameplayBroadcastClient} from './gameplay-broadcast-client.mjs';

class BrowserSocket extends WebSocket {constructor(url: string) {super(url, {origin: 'http://localhost:3018'});}}
async function until(predicate: () => boolean) {for (let index = 0; index < 200; index++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10));} throw Error('Timed out waiting for signaling lifecycle');}

test('four separate PostgreSQL identities publish and subscribe through real sockets with independent privacy and admission', {skip: !process.env.CHARMVILLE_BROADCAST_TEST_DATABASE_URL, timeout: 20000}, async () => {
  const connectionString = process.env.CHARMVILLE_BROADCAST_TEST_DATABASE_URL!;
  const url = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.match(url.pathname, /^\/charmville_[a-z0-9_]*(test|validation|release)[a-z0-9_]*$/);
  assert.ok(!url.pathname.includes('acceptance'), 'Never run against the live acceptance database');
  const originalMode = process.env.CHARMVILLE_ACCESS_MODE, originalWallets = process.env.CHARMVILLE_ALLOWED_WALLETS;
  const wallets = Array.from({length: 4}, () => `0x${randomBytes(20).toString('hex')}`);
  process.env.CHARMVILLE_ACCESS_MODE = 'private'; process.env.CHARMVILLE_ALLOWED_WALLETS = wallets[0];
  const admin = new Pool({connectionString});
  const schema = `broadcast_four_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({connectionString, options: `-c search_path=${schema}`, max: 8});
  const clients: Awaited<ReturnType<typeof createGameplayBroadcastClient>>[] = [];
  let gateway: Awaited<ReturnType<typeof startBroadcastGateway>> | null = null;
  try {
    for (const migration of ['090_plankspace_native.sql', '142_charmville_spectator_settings.sql', '144_charmville_private_admission.sql']) await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${migration}`, 'utf8'));
    const ids: string[] = [], tokens = Array.from({length: 4}, () => randomBytes(32).toString('hex'));
    for (let index = 0; index < 4; index++) {
      ids.push((await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id::text", [wallets[index], `broadcast_test_${index}`])).rows[0].id);
      await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [createHash('sha256').update(tokens[index]).digest('hex'), wallets[index]]);
      await pool.query("INSERT INTO charmville_spectator_settings(profile_id,mode) VALUES($1,'public')", [ids[index]]);
      if (index) await pool.query("INSERT INTO charmville_admission_grants(profile_id,granted_by_profile_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [ids[index], ids[0]]);
    }
    gateway = await startBroadcastGateway({port: 0, origins: ['http://localhost:3018'], refreshMs: 100,
      authenticate: async token => {
        const client = await pool.connect();
        try {await client.query('BEGIN'); const id = await homeActor(client, token); await client.query('COMMIT'); return id;}
        catch (error) {await client.query('ROLLBACK'); throw error;} finally {client.release();}
      },
      resolve: (token, ownerId) => broadcastAuthority(pool, token, ownerId),
    });
    const receipts: string[] = [], ended = Array.from({length: 4}, () => [] as string[]);
    let stoppedSources = 0;
    for (let index = 0; index < 4; index++) {
      const peerFactory = ({role, send}: {role: string; send: (message: object) => void}) => ({
        active: true, async start() {send({description: {type: 'offer', sdp: 'v=0\r\n'}});},
        async receive(message: {description: {type: string}}) {receipts.push(`${index}:${role}:${message.description.type}`); if (role === 'viewer') send({description: {type: 'answer', sdp: 'v=0\r\n'}});},
        close() {},
      });
      clients.push(await createGameplayBroadcastClient({url: gateway.url, token: tokens[index], WebSocketImpl: BrowserSocket as unknown as typeof globalThis.WebSocket, peerFactory, renewMs: 5000, onEnded: id => {ended[index].push(id);}}));
      assert.equal(clients[index].profileId, ids[index]);
    }
    const stream = {getTracks: () => [{kind: 'video', readyState: 'live', stop() {stoppedSources++;}}]};
    const publications = await Promise.all(clients.map(client => client.publish(stream)));
    await Promise.all(clients.flatMap((client, viewer) => publications.filter((_id, owner) => owner !== viewer).map(id => client.subscribe(id))));
    await until(() => receipts.length === 24);
    for (let index = 0; index < 4; index++) {
      assert.equal(receipts.filter(value => value === `${index}:viewer:offer`).length, 3);
      assert.equal(receipts.filter(value => value === `${index}:publisher:answer`).length, 3);
    }
    await pool.query("UPDATE charmville_spectator_settings SET mode='private',revision=revision+1 WHERE profile_id=$1", [ids[0]]);
    await until(() => ended.every(events => events.includes(publications[0])));
    assert.ok(ended.slice(1).every(events => !events.includes(publications[1])));
    const privatePublication = await clients[0].publish(stream);
    await assert.rejects(clients[1].subscribe(privatePublication));
    await pool.query("UPDATE charmville_spectator_settings SET mode='allowlist',allowed_ids=$2::bigint[],revision=revision+1 WHERE profile_id=$1", [ids[0], [ids[1]]]);
    await until(() => ended[0].includes(privatePublication));
    const restrictedPublication = await clients[0].publish(stream);
    await clients[1].subscribe(restrictedPublication);
    await assert.rejects(clients[2].subscribe(restrictedPublication));
    await pool.query('UPDATE charmville_admission_grants SET revoked_at=clock_timestamp() WHERE profile_id=$1', [ids[3]]);
    await until(() => !clients[3].active);
    await until(() => clients.slice(0, 3).every((_client, index) => ended[index].includes(publications[3])));
    assert.ok(clients.slice(0, 3).every(client => client.active));
    assert.equal(stoppedSources, 0, 'Signaling does not own capture source tracks');
  } finally {
    for (const client of clients) client.close();
    await gateway?.close(); await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    if (originalMode === undefined) delete process.env.CHARMVILLE_ACCESS_MODE; else process.env.CHARMVILLE_ACCESS_MODE = originalMode;
    if (originalWallets === undefined) delete process.env.CHARMVILLE_ALLOWED_WALLETS; else process.env.CHARMVILLE_ALLOWED_WALLETS = originalWallets;
  }
});
