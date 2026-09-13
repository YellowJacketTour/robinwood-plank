import { createHash } from 'node:crypto';
import { privateRuntimeConfig } from './private-runtime-adapter.mjs';

export const PRIVATE_BRIDGE_HASHES = Object.freeze({
  'tutorial-bridge.js': 'e42e8d7ea6dd4d08970adcee7a4614a7ecd1b0b90c9bca33863b03a778f1079b',
  'runtime-shell.css': '65e8598a356fe8cf2881335eab1d1c93a2a3ac79144b4ccbd409143c2a0f40ca',
  'charmdex-device.css': '810966c0ee64c1bbd7b0a3b259dd511c228214a6af120b4f2b15a0cc0cb0b788',
  'runtime-shell.mjs': 'c56ff0bd975caff44849948956a28bd80ae205f218a3b51bdeebf7af3c2c59d1',
  'charmdex.js': 'e00e20d761982df8d0d2ef1e6e7f944363230b909149ebbb9e7875ccd00e3315',
  'voice-notes.js': 'ccf6409731cc88dc74ae71d2c62b518c608c7657054010e3b9ccea78a9c1cf4e',
  'follower-bridge.js': '8bdfe7d7086d8e056c7ba21735b2849ced62f23936e8f9b005c5f47a01c7a4d2',
  'action-event-bridge.js': '8c39fe74b0388fbfc7a5c27a5cfed1599ed4baefec8b517c59b14fb45ee43e23',
  'position-observer.js': '02e8aacc12d4ef4f7b40d31804e02a88bf81102431e5f3fa22520d47873e6616',
  'account-peers.js': 'a580817ee73ab0b97f36602b68dc5467617a7148c6cf25be87c270bc31a88479',
  'resource-bridge.js': 'ef3aef881660c18904f5423077f6ded71fbab3f41e24764fa11d0a40ba94ccf1',
  'world-encounter.js': '971481f8d59bd314fe8400816d60756bbd03f0d4ff47b665bfc08bfb6f2e6ccb',
  'capture-bridge.js': 'd4bfc3b1cf382cb0a6858fc7bf9b78f6f0f78e8fbc471ac02f3a4bd26042086c',
  'gameplay-video.mjs': 'b187c20f6d23a3dc8bd0c061a895d1222eb03c32b8823498984962445340c3b0',
  'gameplay-capture.mjs': 'd15358b7e8500c3d6bea07ed8d45d23ca2bdd2239411de8a410fded83763213f',
  'compact-game-hud.mjs': '1f193dc7e6063a12f086ea78ed5c19cbfeaa6d6222172f805c40bed78409fd2b',
  'display-controls.js': '3f12d54931afbee4874e3662d5a0a9e023203cf52abca45647b784bdd88d49d3',
  'controller-controls.js': '30a8ab50bb4770ff783c2138da3e2739e053b833c5fd9683fd1d581e8a8380e4',
});
function replaceCount(source, before, after, expected) {
  if (source.split(before).length - 1 !== expected) throw Error('Bridge replacement coverage changed');
  return source.split(before).join(after);
}
export function adaptPrivateBridge(name, source, options) {
  const config = privateRuntimeConfig(options);
  if (!Object.hasOwn(PRIVATE_BRIDGE_HASHES, name) || createHash('sha256').update(source).digest('hex') !== PRIVATE_BRIDGE_HASHES[name]) throw Error('Unreviewed runtime bridge revision');
  let result = source;
  const originBridge = ['tutorial-bridge.js', 'follower-bridge.js', 'action-event-bridge.js', 'position-observer.js', 'account-peers.js', 'resource-bridge.js', 'world-encounter.js', 'capture-bridge.js', 'runtime-shell.mjs'];
  if (originBridge.includes(name)) {
    const spaced = name === 'follower-bridge.js' || name === 'runtime-shell.mjs';
    result = replaceCount(result, spaced ? "['http://localhost:3017', 'http://127.0.0.1:3017']" : "['http://localhost:3017','http://127.0.0.1:3017']", JSON.stringify([config.accountOrigin]), 1);
  }
  const artCounts = { 'runtime-shell.mjs': 3, 'voice-notes.js': 1, 'charmdex.js': 2 };
  if (artCounts[name]) result = replaceCount(result, '/menu-art/', config.prefix + 'menu-art/', artCounts[name]);
  if (name === 'charmdex.js') result = replaceCount(result, "fetch('/charmdex-catalog.json')", `fetch(${JSON.stringify(config.prefix + 'charmdex-catalog.json')})`, 1);
  if (name === 'runtime-shell.mjs') {
    result = replaceCount(result, "window.open('http://localhost:3017/charmville/world?panel='+panel,'_blank','noopener')", `window.location.assign(${JSON.stringify(config.accountOrigin + '/charmville/world?panel=')}+panel)`, 1);
    result = replaceCount(result, "if(document.fullscreenElement)try{await document.exitFullscreen();}catch{/* The parent also checks its iframe fullscreen state. */}", '// Parent-owned fullscreen keeps the world mounted while showing account menus.', 1);
    result = replaceCount(result, "copy.textContent = 'Copy local play link'; copy.title = 'This localhost link only opens on this computer.';", "copy.hidden = true; copy.disabled = true;", 1);
  }
  if (name === 'follower-bridge.js') {
    const begin = '// Explicit standalone six-party playtest; never an account inventory grant.';
    const end = 'const uuid=';
    const start = result.indexOf(begin), finish = result.indexOf(end);
    if (start < 0 || finish <= start || result.indexOf(begin, start + 1) !== -1) throw Error('Follower fixture boundary changed');
    result = result.slice(0, start) + '// Private runtime receives companions only from its admitted account host.\n' + result.slice(finish);
  }
  const originNeutral = result.split(config.accountOrigin).join('APPROVED_ACCOUNT_ORIGIN');
  if (/localhost|127\.0\.0\.1|testParty|serviceWorker\.register/.test(originNeutral)) throw Error('Unrelocated local capability');
  // Root-relative network URLs must be explicitly reviewed above. Virtual FS
  // paths (/Files/Homestead/charmville) deliberately retain their native meaning.
  if (/fetch\(['"]\/(?!charmville\/runtime\/)/.test(result) || /src=["']\/(?!charmville\/runtime\/)/.test(result)) throw Error('Unrelocated network path');
  return result;
}

export function adaptPrivateBridgeSet(sources, options) {
  if (Object.keys(sources).length !== Object.keys(PRIVATE_BRIDGE_HASHES).length) throw Error('Incomplete bridge input set');
  return Object.fromEntries(Object.keys(PRIVATE_BRIDGE_HASHES).map(name => [name, adaptPrivateBridge(name, sources[name], options)]));
}
