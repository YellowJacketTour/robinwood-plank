import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { PRIVATE_BRIDGE_HASHES, adaptPrivateBridge, adaptPrivateBridgeSet } from './private-runtime-bridges.mjs';

const options = { release: 'alpha-1', accountOrigin: 'https://plank.love' };
async function readSources() {
  return Object.fromEntries(await Promise.all(Object.keys(PRIVATE_BRIDGE_HASHES).map(async name => [name, await readFile(new URL('./' + name, import.meta.url), 'utf8')])));
}
test('all reviewed bridge files relocate as a complete set, preserving native filesystem paths', async () => {
  const output = adaptPrivateBridgeSet(await readSources(), options);
  assert.equal(Object.keys(output).length, 18);
  for (const source of Object.values(output)) assert.doesNotMatch(source, /localhost|127\.0\.0\.1|testParty/);
  assert.match(output['runtime-shell.mjs'], /\/charmville\/runtime\/alpha-1\/menu-art\//);
  assert.match(output['charmdex.js'], /\/charmville\/runtime\/alpha-1\/charmdex-catalog.json/);
  assert.match(output['follower-bridge.js'], /\/Files\/Homestead\/charmville/);
  assert.doesNotMatch(output['runtime-shell.mjs'], /document.exitFullscreen\(/);
  assert.match(output['runtime-shell.mjs'], /event.source !== window.parent/);
  assert.match(output['tutorial-bridge.js'], /event.source!==parent/);
});
test('changed input, unknown bridge or incomplete set fail closed', async () => {
  const sources = await readSources();
  assert.throws(() => adaptPrivateBridge('unknown.js', '', options), /Unreviewed/);
  assert.throws(() => adaptPrivateBridge('resource-bridge.js', sources['resource-bridge.js'] + '\n', options), /Unreviewed/);
  delete sources['runtime-shell.css'];
  assert.throws(() => adaptPrivateBridgeSet(sources, options), /Incomplete/);
});
test('explicit local mirror rewrites all account origins without retaining old local services', async () => {
  const output = adaptPrivateBridgeSet(await readSources(), { release: 'alpha01-local', accountOrigin: 'http://localhost:3018', localMirror: true });
  for (const source of Object.values(output)) assert.doesNotMatch(source, /localhost:3017|localhost:3024|127\.0\.0\.1/);
  assert.match(output['resource-bridge.js'], /http:\/\/localhost:3018/);
});
test('capture bridge still rejects foreign source/origin and accepts admitted parent origin', async () => {
  const source = adaptPrivateBridge('capture-bridge.js', (await readSources())['capture-bridge.js'], options);
  let listener; const parent = {}; const window = { addEventListener(type, callback) { if (type === 'message') listener = callback; } };
  // Message-shape effects are intentionally checked only after origin/source filters.
  runInNewContext(source, { window, parent, setInterval() {}, console });
  assert.doesNotThrow(() => listener({ source: {}, origin: options.accountOrigin, get data() { throw Error('Should reject foreign source before reading data'); } }));
  assert.doesNotThrow(() => listener({ source: parent, origin: 'https://other.test', get data() { throw Error('Should reject foreign origin before reading data'); } }));
  assert.doesNotThrow(() => listener({ source: parent, origin: options.accountOrigin, data: { type: 'unrelated' } }));
});

 test('reviewed text tolerates checkout line endings but not source edits', async()=>{
 const sources=await readSources();
 for(const [name,source] of Object.entries(sources)){
 const lf=source.replace(/\r\n/g,'\n');
 assert.equal(adaptPrivateBridge(name,lf,options),adaptPrivateBridge(name,lf.replace(/\n/g,'\r\n'),options));
 assert.throws(()=>adaptPrivateBridge(name,lf+'// changed source\n',options),/Unreviewed/);
 }
 });
