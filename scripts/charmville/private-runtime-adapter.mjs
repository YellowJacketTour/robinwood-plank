import { createHash } from 'node:crypto';
import { fitNativeCanvas } from './native-canvas-layout.mjs';

// Exact reviewed upstream bytes. New engine builds require reviewing this adapter
// and updating these pins deliberately, never accepting arbitrary source shapes.
export const PRIVATE_SOURCE_HASHES = {
  html: '6fecd0915c9209a2b7c381a1831d44ea8b3d9abd0b8b777d35fb071ca35c497d',
  main: 'd80825ea6c1d0cce78983a44148304f294ab5fa7834f81112e30867ea0cb7113',
};
export const PRIVATE_QUEST = '/quests/charmville/homestead-region/r01/Homestead.qst';
export function privateRuntimeConfig({ release, accountOrigin, localMirror = false }) {
  if (typeof release !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(release)) throw Error('Invalid release');
  const origin = new URL(accountOrigin);
  const allowedLocalMirror = localMirror === true && accountOrigin === 'http://localhost:3018';
  if ((!allowedLocalMirror && origin.protocol !== 'https:') || origin.origin !== accountOrigin || origin.username || origin.password) throw Error('Exact HTTPS account origin required (explicit local mirror: http://localhost:3018 only)');
  return { prefix: `/charmville/runtime/${release}/`, accountOrigin, query: new URLSearchParams({ test: PRIVATE_QUEST, dmap: '4', screen: '63', storage: 'idb' }).toString() };
}
function pinned(source, type) {
  if (createHash('sha256').update(source).digest('hex') !== PRIVATE_SOURCE_HASHES[type]) throw Error(`Unreviewed ${type} source revision`);
}
function one(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Adapter source marker changed');
  return source.replace(before, after);
}
export function adaptPrivateMain(source, options) {
  pinned(source, 'main'); const config = privateRuntimeConfig(options);
  let result = one(source, 'dataOrigin: "https://data.zquestclassic.com"', `dataOrigin: ${JSON.stringify(config.prefix + 'reference-data')}`);
  // The upstream copies every unknown query parameter into engine switches.
  // Replace every reviewed query reader; arbitrary URLs never select engine flags.
  const marker = 'new URLSearchParams(location.search)';
  if (result.split(marker).length !== 4) throw Error('Query-reader coverage changed');
  result = result.split(marker).join(`new URLSearchParams(${JSON.stringify(config.query)})`);
  result = fitNativeCanvas(result);
  return result;
}

// This function becomes inline code in the retained upstream DOM. No external
// analytics, PWA installation, launched-file handlers or service worker bootstrap.
function boot(config) {
  if (location.origin !== config.accountOrigin) throw Error('Runtime origin mismatch');
  const canonical = new URLSearchParams(config.query);
  for (const [key, value] of new URLSearchParams(location.search)) {
    if (!canonical.has(key) || canonical.get(key) !== value) throw Error('Unsupported runtime launch');
  }
  history.replaceState(null, '', location.pathname + '?' + config.query);
  window.charmvillePrivateRuntime = Object.freeze({ prefix: config.prefix, accountOrigin: config.accountOrigin });
  const start = document.createElement('button'); start.textContent = 'Enter the world'; start.className = 'panel-button';
  document.querySelector('.panel-buttons').prepend(start);
  start.addEventListener('click', async () => {
    start.disabled = true; start.textContent = 'Loading world...';
    try {
      for (const name of ['main.js', 'zplayer.data.js', 'zplayer.js']) {
        if (name === 'zplayer.js') {
          const response = await fetch(config.prefix + 'midi-bank.json', { signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw Error('MIDI bank unavailable'); const bank = await response.json();
          if (bank.virtualRoot !== '/etc' || !Array.isArray(bank.patches) || bank.patches.length > 512) throw Error('Invalid MIDI manifest');
          const loaded = []; let cursor = 0;
          await Promise.all(Array.from({ length: 6 }, async () => {
            while (cursor < bank.patches.length) {
              const patch = bank.patches[cursor++];
              if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.pat$/.test(patch.name) || patch.name.includes('..')) throw Error('Invalid MIDI path');
              const response = await fetch(config.prefix + 'timidity/' + patch.name, { signal: AbortSignal.timeout(30000) });
              if (!response.ok) throw Error('MIDI instrument unavailable');
              const bytes = new Uint8Array(await response.arrayBuffer());
              if (bytes.byteLength !== patch.bytes) throw Error('Incomplete MIDI instrument');
              loaded.push({ name: patch.name, bytes }); start.textContent = 'Loading instruments ' + loaded.length + '/' + bank.patches.length;
            }
          }));
          (Module.preRun ??= []).push(() => {
            for (const patch of loaded) { const target = bank.virtualRoot + '/' + patch.name; FS.mkdirTree(target.slice(0, target.lastIndexOf('/'))); FS.writeFile(target, patch.bytes); }
            for (const directory of new Set(loaded.map(patch => patch.name.split('/')[0]))) if (!FS.analyzePath('/' + directory).exists) FS.symlink(bank.virtualRoot + '/' + directory, '/' + directory);
            console.log('CHARMVILLE_MIDI_BANK_READY ' + loaded.length);
          });
          const sprites = await fetch(config.prefix + 'action-sprites/manifest.json', { cache: 'no-store' });
          if (!sprites.ok) throw Error('Sprite manifest unavailable'); const assets = await sprites.json();
          if (!Array.isArray(assets) || assets.length > 128) throw Error('Invalid sprite manifest');
          const images = await Promise.all(assets.map(async asset => {
            if (!/^[a-z0-9-]+\.png$/.test(asset.name) || !/^[a-f0-9]{64}$/i.test(asset.runtimeSha256)) throw Error('Invalid sprite entry');
            const response = await fetch(config.prefix + 'action-sprites/' + asset.name, { cache: 'no-store' });
            if (!response.ok) throw Error('Sprite unavailable'); const bytes = new Uint8Array(await response.arrayBuffer());
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
            if (hash !== asset.runtimeSha256.toLowerCase()) throw Error('Sprite version mismatch'); return { name: asset.name, bytes };
          }));
          (Module.preRun ??= []).push(() => { for (const directory of ['/charmville', '/Files/Homestead/charmville']) { FS.mkdirTree(directory); for (const asset of images) FS.writeFile(directory + '/' + asset.name, asset.bytes); } });
        }
        await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = config.prefix + name; script.onload = resolve; script.onerror = reject; document.body.append(script); });
      }
      start.remove();
    } catch { start.textContent = 'Loading failed — reload to retry'; }
  }, { once: true });
}
export function privateRuntimeBootstrap(options) {
  return `(${boot.toString()})(${JSON.stringify(privateRuntimeConfig(options))});`;
}
export function adaptPrivateHtml(source, options) {
  pinned(source, 'html'); const config = privateRuntimeConfig(options);
  // Hash pin means these are the reviewed six script blocks, not an arbitrary
  // HTML sanitizer. Preserve native DOM/templates/styles used by main.js.
  const scripts = source.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
  if (scripts.length !== 7) throw Error('Script coverage changed');
  let html = source;
  for (const script of scripts) html = one(html, script, '');
  for (const tag of html.match(/<link\b[^>]*>/g) || []) if (tag.includes('https://data.zquestclassic.com') || tag.includes('rel="preload"')) html = one(html, tag, '');
  html = one(html, 'href="../favicon.ico"', `href="${config.prefix}favicon.ico"`);
  const constants = `var TARGET="zplayer";var IS_CI=false;var rootUrl=new URL(${JSON.stringify(config.prefix)},location.origin).href;window.ZC_Constants={zeldaUrl:rootUrl+'play/',zquestUrl:rootUrl+'unavailable',patsUrl:rootUrl+'timidity',files:[]};`;
  html = one(html, '</head>', `<link rel="stylesheet" href="${config.prefix}runtime-shell.css"><link rel="stylesheet" href="${config.prefix}charmdex-device.css"><style>.button--open-testmode,[data-panel=".quest-list"],[data-panel=".testmode"]{display:none!important}</style><script>${constants}</script></head>`);
  const modules = ['charmville-display.js', 'charmville-controller.js', 'runtime-shell.mjs'].map(name => `<script type="module" src="${config.prefix}${name}"></script>`).join('');
  html = one(html, '</body>', `<script>${privateRuntimeBootstrap(options)}</script>${modules}</body>`);
  return html;
}
