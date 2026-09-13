import { createReadStream } from 'node:fs';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseMidiPatches } from './midi-bank.mjs';

// Inventory only. No recursive directory collection, networking or asset copying.
const allowed = new Set(['repo-root', 'runtime-root', 'content-root', 'sprite-root', 'output']);
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  const value = process.argv[i + 1];
  if (!process.argv[i].startsWith('--') || !allowed.has(key) || args[key] || !value || value.startsWith('--')) throw Error('Expected unique --repo-root --runtime-root --content-root --sprite-root --output arguments');
  args[key] = value;
}
for (const key of allowed) if (!args[key]) throw Error(`Missing --${key}`);
const roots = {};
for (const name of ['repo', 'runtime', 'content', 'sprite']) roots[name] = await realpath(path.resolve(args[`${name}-root`]));
const entries = [], issues = [];
async function inspect(root, relative, route, role = 'served') {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Error('Unsafe inventory path');
  const filename = path.join(roots[root], relative);
  try {
    const resolved = await realpath(filename);
    const rel = path.relative(roots[root], resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw Error('Path escapes declared root');
    const info = await stat(resolved);
    if (!info.isFile()) throw Error('Expected regular file');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(resolved)) hash.update(chunk);
    entries.push({ root, path: relative.replaceAll('\\', '/'), route, role, bytes: info.size, sha256: hash.digest('hex'), status: 'present' });
  } catch (error) {
    entries.push({ root, path: relative, route, role, status: error.code === 'ENOENT' ? 'missing' : 'rejected' });
    issues.push(`${root}:${relative}: ${error.code === 'ENOENT' ? 'missing' : 'unreadable or unsafe file'}`);
  }
}
const runtimeFiles = ['play/index.html', 'main.js', 'zplayer.js', 'zplayer.wasm', 'zplayer.data.js', 'zplayer.data', 'styles.css', 'manifest.json', 'favicon.ico', 'zscript.mjs', 'zscript.wasm', 'sw.js', 'android-chrome-192x192.png', 'android-chrome-512x512.png', 'android-chrome-maskable-192x192.png', 'android-chrome-maskable-512x512.png', 'apple-touch-icon.png'];
for (const file of runtimeFiles) await inspect('runtime', file, file === 'play/index.html' ? '/play/' : `/${file}`);
// Only Workbox chunks explicitly named by this service worker, never a folder glob.
try {
  const sw = await readFile(path.join(roots.runtime, 'sw.js'), 'utf8');
  for (const file of new Set(sw.match(/workbox-[a-f0-9]+\.js/g) || [])) await inspect('runtime', file, `/${file}`);
} catch { issues.push('Service-worker dependency inspection unavailable'); }
const bridges = ['tutorial-bridge.js', 'runtime-shell.css', 'charmdex-device.css', 'runtime-shell.mjs', 'charmdex.js', 'voice-notes.js', 'follower-bridge.js', 'action-event-bridge.js', 'position-observer.js', 'account-peers.js', 'resource-bridge.js', 'world-encounter.js', 'capture-bridge.js', 'gameplay-video.mjs', 'gameplay-capture.mjs', 'compact-game-hud.mjs'];
for (const file of bridges) await inspect('repo', `scripts/charmville/${file}`, `/${file}`);
for (const [file, route] of [['display-controls.js', '/charmville-display.js'], ['controller-controls.js', '/charmville-controller.js']]) await inspect('repo', `scripts/charmville/${file}`, route);
for (const file of ['serve-reference-runtime.mjs', 'adventure-entry.mjs', 'midi-bank.mjs', 'static-encoding.mjs', 'native-canvas-layout.mjs']) await inspect('repo', `scripts/charmville/${file}`, null, 'adapter-source');
await inspect('repo', 'public/charmville/catalog/emoji-catalog.json', '/charmdex-catalog.json');
for (const file of ['poke_ball.png', 'macho_brace.png', 'berry_pouch.png', 'vs_seeker.png', 'coin_case.png', 'poke_doll.png', 'retro_mail.png']) await inspect('repo', `public/charmville/reference-items/pokeemerald/graphics/items/icons/${file}`, `/menu-art/${file}`);
const spriteFiles = ['manifest.json', 'hoe-fg.png', 'hoe-bg.png', 'water-fg.png', 'water-bg.png', 'gold-hair.png', 'berry-dirt.png', 'berry-sprout.png', 'berry-oran.png', ...['treecko', 'torchic', 'mudkip', 'pikachu', 'eevee', 'poochyena'].flatMap(name => [`follower-${name}.png`, `attack-${name}.png`]), 'capture-ball.png', 'faint-poochyena.png'];
for (const file of spriteFiles) await inspect('sprite', file, `/action-sprites/${file}`);
try {
  const manifest = JSON.parse(await readFile(path.join(roots.sprite, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest)) throw Error('Invalid sprite manifest');
  for (const asset of manifest) {
    const entry = entries.find(item => item.root === 'sprite' && item.path === asset.name);
    if (!entry || entry.status !== 'present' || (asset.runtimeSha256 && entry.sha256 !== asset.runtimeSha256.toLowerCase())) issues.push(`Sprite manifest mismatch: ${typeof asset.name === 'string' && spriteFiles.includes(asset.name) ? asset.name : 'unsupported entry'}`);
  }
} catch { issues.push('Sprite manifest verification unavailable'); }
await inspect('runtime', 'timidity/zc.cfg', '/timidity/zc.cfg');
try {
  for (const patch of parseMidiPatches(await readFile(path.join(roots.runtime, 'timidity/zc.cfg'), 'utf8'))) await inspect('runtime', `timidity/${patch}`, `/timidity/${patch}`);
} catch { issues.push('MIDI dependency inspection unavailable'); }
// Inventory the six metadata inputs consumed by the current server, but only the
// joined homestead quest payload. Legacy quest launchers are not this release.
for (const file of ['139-metadata.json', '204-metadata.json', '461-metadata.json', 'homestead-metadata.json', 'region-candidate-metadata.json', 'joined-homestead-metadata.json']) await inspect('content', file, null, 'manifest-input');
await inspect('content', 'quests/charmville/homestead-region/r01/Homestead.qst.gz', '/reference-data/quests/charmville/homestead-region/r01/Homestead.qst.gz');
const output = path.resolve(args.output);
for (const root of Object.values(roots)) {
  const rel = path.relative(root, output);
  if (!rel.startsWith('..') && !path.isAbsolute(rel) && entries.some(entry => path.resolve(roots[entry.root], entry.path) === output)) throw Error('Output cannot overwrite an inventoried input');
}
const manifest = { schemaVersion: 1, scope: 'joined-homestead-private-inventory', generatedAt: new Date().toISOString(), readiness: 'inventory-only', completeInventory: issues.length === 0, files: entries, issues, totalBytes: entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0), generatedRoutes: ['/midi-bank.json', '/reference-data/manifest.json'], limitations: ['No production bundle, network validation, permission decision or deployment is produced.', 'HTML and main.js still require the reference server adaptations; hashes describe original inputs.', 'Legacy quests, editor and arbitrary runtime files are deliberately excluded; manifest/launcher exposure must be narrowed for private hosting.', 'Service-worker precache and runtime dynamic fetches require a cold-cache browser network audit before release.', 'No secrets or absolute local paths are included in this manifest.'] };
await writeFile(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ files: entries.length, missingOrRejected: entries.filter(entry => entry.status !== 'present').length, issues: issues.length, totalBytes: manifest.totalBytes, completeInventory: manifest.completeInventory }));
if (issues.length) process.exitCode = 1;
