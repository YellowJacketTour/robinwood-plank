import { createHash } from 'node:crypto';
import { privateRuntimeConfig } from './private-runtime-adapter.mjs';

// Canonical LF source identities. Inventories separately verify exact package bytes.
export const PRIVATE_BRIDGE_HASHES = Object.freeze({
  'tutorial-bridge.js': 'e42e8d7ea6dd4d08970adcee7a4614a7ecd1b0b90c9bca33863b03a778f1079b',
  'runtime-shell.css': '1f9680c4d8d1d270578e5ca2c2a05b38c22d2a671f9831545874d27bc119390b',
  'charmdex-device.css': '1db48cd7fba5e812941d83938ef9249aa618baa6af51e085b39d970af420bef4',
  'runtime-shell.mjs': '4015fbf824639034ad145a535a9a59a177b694abb60d7a1038aad80979d1e17c',
  'charmdex.js': 'd38cd5f9020766c65a296943e0c59d654c6ae4f2e0712217aa09e2fc0466c06d',
  'voice-notes.js': '1c504fc60e6d445c5f7acf3e45d76f12240aec9973a0538d1d14c9a819e0e67e',
  'follower-bridge.js': '4da08da432397a65435a142b3a840c42ececf7bea73151289efe863ec2dfd52d',
  'action-event-bridge.js': '8c39fe74b0388fbfc7a5c27a5cfed1599ed4baefec8b517c59b14fb45ee43e23',
  'position-observer.js': '1ff08799a3650b813e9d24a53b877ef18f67710b8278aba31ac28ced860cd22f',
  'account-peers.js': '3d29347bf8fbee4cccb90e416b52d79950f6921b28d9455baa0721ae265f85b7',
  'resource-bridge.js': 'f26748e6a4900209cb7ef4f5fe6963d72f36e76ec6fb0c56807f3d2a4dd8e054',
  'world-encounter.js': '225b6b591d7b784f66c80de9c0404f91ecc025945bec5dbfb01b36429d13e04e',
  'capture-bridge.js': '9b1b03b69aec5762ccfc13129a101efb017dd6b6cf93b588845a361fd7058aa8',
  'gameplay-video.mjs': 'b187c20f6d23a3dc8bd0c061a895d1222eb03c32b8823498984962445340c3b0',
  'gameplay-capture.mjs': 'd15358b7e8500c3d6bea07ed8d45d23ca2bdd2239411de8a410fded83763213f',
  'compact-game-hud.mjs': '1d4a1cc472b86df2db037f41ecd7c9539ffe393a6332d875812d4ff5834b2d82',
  'display-controls.js': 'b67d088a076f7d785d4159a2d5fdc70efa7abe54f2affc2c75a69eec828fe901',
  'controller-controls.js': '06bb7e6671c2adae84a224912795600bcb412f24e4d77c53c5eb4e41a70164f8',
});
function replaceCount(source, before, after, expected) {
  if (source.split(before).length - 1 !== expected) throw Error('Bridge replacement coverage changed');
  return source.split(before).join(after);
}
export function adaptPrivateBridge(name, source, options) {
  const config = privateRuntimeConfig(options);
  source = source.replace(/\r\n/g, '\n');
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
