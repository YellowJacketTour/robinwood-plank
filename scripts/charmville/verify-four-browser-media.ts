import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {Pool} from 'pg';
import {build} from 'esbuild';
import {chromium, type Browser, type BrowserContext} from '@playwright/test';
import {broadcastAuthority} from '../../lib/charmville/broadcast-authority';
import {homeActor} from '../../lib/charmville/home-access-store';
import {startBroadcastGateway} from '../../lib/charmville/broadcast-gateway';

type VideoProof = {id: string; presented: number; decoded: number | null; rgb: number[] | null; stopped: boolean};
declare global {interface Window {mediaHarness: {initialize(options: {token: string; url: string; index: number}): Promise<string>; subscribe(ids: string[]): Promise<void>; stats(): VideoProof[]; ended(): string[]; stop(): void;};}}

async function main() {
  const connectionString = process.env.CHARMVILLE_BROADCAST_TEST_DATABASE_URL;
  if (!connectionString) throw Error('A disposable broadcast test database is required');
  const url = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.match(url.pathname, /^\/charmville_[a-z0-9_]*(test|validation|release)[a-z0-9_]*$/);
  assert.ok(!url.pathname.includes('acceptance'));
  const output = path.resolve('work/four-browser-media-20260914');
  await mkdir(output, {recursive: true});
  const originalMode = process.env.CHARMVILLE_ACCESS_MODE, originalWallets = process.env.CHARMVILLE_ALLOWED_WALLETS;
  const wallets = Array.from({length: 4}, () => `0x${randomBytes(20).toString('hex')}`);
  process.env.CHARMVILLE_ACCESS_MODE = 'private'; process.env.CHARMVILLE_ALLOWED_WALLETS = wallets[0];
  const admin = new Pool({connectionString});
  const schema = `browser_media_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({connectionString, options: `-c search_path=${schema}`, max: 8});
  let gateway: Awaited<ReturnType<typeof startBroadcastGateway>> | null = null, browser: Browser | null = null;
  const contexts: BrowserContext[] = [];
  const server = createServer();
  let stage = 'schema';
  const evidence: {status: string; scope: string; browserContexts: number; receiverCount: number; videos: VideoProof[][]; revisionRevoked: boolean; failureStage?: string} = {status: 'pending', scope: 'four isolated headless contexts, synthetic source canvases, real PostgreSQL and WebRTC over local networking; not rendered gameplay or WAN acceptance', browserContexts: 0, receiverCount: 0, videos: [], revisionRevoked: false};
  try {
    for (const migration of ['090_plankspace_native.sql', '142_charmville_spectator_settings.sql', '144_charmville_private_admission.sql']) await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${migration}`, 'utf8'));
    const ids: string[] = [], tokens = Array.from({length: 4}, () => randomBytes(32).toString('hex'));
    for (let index = 0; index < 4; index++) {
      ids.push((await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id::text", [wallets[index], `media_profile_${index}`])).rows[0].id);
      await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [createHash('sha256').update(tokens[index]).digest('hex'), wallets[index]]);
      await pool.query("INSERT INTO charmville_spectator_settings(profile_id,mode) VALUES($1,'public')", [ids[index]]);
      if (index) await pool.query("INSERT INTO charmville_admission_grants(profile_id,granted_by_profile_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [ids[index], ids[0]]);
    }
    stage = 'browser-bundle';
    const bundle = await build({entryPoints: ['scripts/charmville/four-browser-media-page.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser'});
    server.on('request', (request, response) => {
      if (request.url === '/media.js') {response.writeHead(200, {'Content-Type': 'text/javascript', 'Cache-Control': 'no-store'}); response.end(bundle.outputFiles[0].contents); return;}
      if (request.url !== '/') {response.writeHead(404); response.end(); return;}
      response.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'}); response.end('<!doctype html><title>Local four-profile media acceptance</title><script defer src="/media.js"></script>');
    });
    await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve());});
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    gateway = await startBroadcastGateway({port: 0, origins: [origin], refreshMs: 250,
      authenticate: async token => {const client = await pool.connect(); try {await client.query('BEGIN'); const id = await homeActor(client, token); await client.query('COMMIT'); return id;} catch (error) {await client.query('ROLLBACK'); throw error;} finally {client.release();}},
      resolve: (token, ownerId) => broadcastAuthority(pool, token, ownerId),
    });
    stage = 'launch-browser';
    browser = await chromium.launch({headless: true});
    for (let index = 0; index < 4; index++) contexts.push(await browser.newContext({viewport: {width: 1000, height: 620}}));
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all(pages.map(page => page.goto(origin)));
    evidence.browserContexts = pages.length;
    stage = 'authenticated-publications';
    const publications = await Promise.all(pages.map((page, index) => page.evaluate(options => window.mediaHarness.initialize(options), {token: tokens[index], url: gateway!.url, index})));
    stage = 'media-subscriptions';
    await Promise.all(pages.map((page, index) => page.evaluate(ids => window.mediaHarness.subscribe(ids), publications.filter((_id, owner) => owner !== index))));
    stage = 'decoded-frames';
    await Promise.all(pages.map(page => page.waitForFunction(() => {const videos = window.mediaHarness.stats(); return videos.length === 3 && videos.every(video => video.presented >= 15 && (video.decoded ?? 0) >= 15);}, undefined, {timeout: 20000})));
    evidence.videos = await Promise.all(pages.map(page => page.evaluate(() => window.mediaHarness.stats())));
    evidence.receiverCount = evidence.videos.reduce((sum, videos) => sum + videos.length, 0);
    const colors = [[220, 50, 50], [40, 170, 80], [40, 90, 230], [220, 180, 40]];
    stage = 'source-continuity';
    for (const videos of evidence.videos) for (const video of videos) {
      const owner = publications.indexOf(video.id); assert.ok(owner >= 0 && video.rgb);
      assert.ok(colors[owner].every((value, channel) => Math.abs(value - video.rgb![channel]) <= 20));
    }
    await Promise.all(pages.map((page, index) => page.screenshot({path: path.join(output, `profile-${index + 1}.png`)})));
    stage = 'privacy-revision';
    await pool.query("UPDATE charmville_spectator_settings SET mode='private',revision=revision+1 WHERE profile_id=$1", [ids[0]]);
    await Promise.all(pages.map(page => page.waitForFunction(id => window.mediaHarness.ended().includes(id), publications[0], {timeout: 10000})));
    const after = await Promise.all(pages.slice(1).map(page => page.evaluate(() => window.mediaHarness.stats())));
    assert.ok(after.every(videos => videos.find(video => video.id === publications[0])?.stopped));
    evidence.revisionRevoked = true; evidence.status = 'passed';
    console.log(JSON.stringify({status: 'passed', browserContexts: 4, actualVideoReceivers: evidence.receiverCount, minimumDecodedFrames: Math.min(...evidence.videos.flat().map(video => video.decoded ?? 0)), sourceColorsVerified: true, cooperatingClientRevocation: true, renderedGamePlayers: false, remoteWanTested: false}));
  } catch {evidence.status = 'failed'; evidence.failureStage = stage; process.exitCode = 1; console.error(`Four-context media acceptance failed at ${stage}. No session tokens are logged.`);}
  finally {
    await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    for (const context of contexts) {for (const page of context.pages()) await page.evaluate(() => window.mediaHarness?.stop()).catch(() => {}); await context.close();}
    await browser?.close(); await gateway?.close();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
    if (originalMode === undefined) delete process.env.CHARMVILLE_ACCESS_MODE; else process.env.CHARMVILLE_ACCESS_MODE = originalMode;
    if (originalWallets === undefined) delete process.env.CHARMVILLE_ALLOWED_WALLETS; else process.env.CHARMVILLE_ALLOWED_WALLETS = originalWallets;
  }
}
void main().catch(() => {console.error('Four-context media setup failed. Check disposable local database configuration.'); process.exitCode = 1;});
