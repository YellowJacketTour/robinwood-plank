import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { adaptPrivateHtml, adaptPrivateMain, privateRuntimeConfig, privateRuntimeBootstrap } from './private-runtime-adapter.mjs';

test('private adapter validates release/origin and fixes launch identity', () => {
  const config = privateRuntimeConfig({ release: 'alpha-1', accountOrigin: 'https://plank.love' });
  assert.equal(config.prefix, '/charmville/runtime/alpha-1/');
  const query = new URLSearchParams(config.query);
  assert.equal(query.get('test'), '/quests/charmville/homestead-region/r01/Homestead.qst');
  assert.equal(query.get('testParty'), null);
  for (const release of ['../public', 'alpha/1', 'x?test=evil', '']) assert.throws(() => privateRuntimeConfig({ release, accountOrigin: 'https://plank.love' }));
  for (const accountOrigin of ['http://plank.love', 'https://plank.love/', 'https://u:p@plank.love', 'https://plank.love/x']) assert.throws(() => privateRuntimeConfig({ release: 'alpha', accountOrigin }));
});
test('unreviewed upstream HTML or main.js cannot silently transform', () => {
  const options = { release: 'alpha', accountOrigin: 'https://plank.love' };
  assert.throws(() => adaptPrivateHtml('<html></html>', options), /Unreviewed html/);
  assert.throws(() => adaptPrivateMain('new URLSearchParams(location.search)', options), /Unreviewed main/);
});
test('local mirror exception requires explicit boolean and exact isolated origin', () => {
  const base = { release: 'alpha01-local', accountOrigin: 'http://localhost:3018' };
  assert.throws(() => privateRuntimeConfig(base), /HTTPS/);
  assert.throws(() => privateRuntimeConfig({ ...base, localMirror: 'true' }), /HTTPS/);
  assert.equal(privateRuntimeConfig({ ...base, localMirror: true }).accountOrigin, base.accountOrigin);
  for (const accountOrigin of ['http://localhost:3017', 'http://127.0.0.1:3018', 'http://localhost:3018/', 'http://localhost:3018.evil.test', 'http://plank.love', 'http://localhost:3018/path']) assert.throws(() => privateRuntimeConfig({ ...base, accountOrigin, localMirror: true }));
  assert.equal(privateRuntimeConfig({ release: 'alpha', accountOrigin: 'https://plank.love' }).accountOrigin, 'https://plank.love');
});
test('bootstrap refuses foreign origin and fixture query before installing start control', () => {
  const code = privateRuntimeBootstrap({ release: 'alpha', accountOrigin: 'https://plank.love' });
  for (const [origin, search] of [['https://elsewhere.test', ''], ['https://plank.love', '?testParty=6'], ['https://plank.love', '?test=/other.qst'], ['https://plank.love', '?testInitData=items[1]=1']]) {
    assert.throws(() => runInNewContext(code, { location: { origin, search }, URLSearchParams }), /origin mismatch|Unsupported runtime launch/);
  }
  let installed = false, canonical = '';
  runInNewContext(code, {
    location: { origin: 'https://plank.love', search: '', pathname: '/charmville/runtime/alpha/play/' },
    history: { replaceState(a, b, url) { canonical = url; } }, window: {}, URLSearchParams,
    document: { createElement() { return { addEventListener() {} }; }, querySelector() { return { prepend() { installed = true; } }; } },
  });
  assert.equal(installed, true); assert.ok(canonical.includes('homestead-region')); assert.ok(!canonical.includes('testParty'));
  assert.ok(!code.includes('serviceWorker')); assert.ok(!code.includes('googletagmanager'));
});
test('gesture loader preserves main/data/engine order and registers MIDI/sprite preload', async () => {
  const code = privateRuntimeBootstrap({ release: 'alpha', accountOrigin: 'https://plank.love' });
  let activate; const loaded = [], fetched = []; const Module = {};
  runInNewContext(code, {
    location: { origin: 'https://plank.love', search: '', pathname: '/charmville/runtime/alpha/play/' },
    history: { replaceState() {} }, window: {}, URLSearchParams, AbortSignal, Module,
    fetch: async url => { fetched.push(url); return { ok: true, json: async () => url.endsWith('midi-bank.json') ? { virtualRoot: '/etc', patches: [] } : [] }; },
    document: {
      createElement(tag) { return tag === 'button' ? { addEventListener(event, fn) { activate = fn; }, remove() {} } : {}; },
      querySelector() { return { prepend() {} }; },
      body: { append(script) { loaded.push(script.src); script.onload(); } },
    },
  });
  assert.equal(loaded.length, 0); await activate();
  assert.deepEqual(loaded, ['main.js', 'zplayer.data.js', 'zplayer.js'].map(file => '/charmville/runtime/alpha/' + file));
  assert.equal(Module.preRun.length, 2);
  assert.deepEqual(fetched, ['/charmville/runtime/alpha/midi-bank.json', '/charmville/runtime/alpha/action-sprites/manifest.json']);
});
