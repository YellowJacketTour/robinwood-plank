// Read-only presentation projection. Never receives credentials or grants items.
const parentOrigins = new Set(['http://localhost:3017', 'http://127.0.0.1:3017']);
const allowedSpecies = new Set([0, 277, 280, 283]);
let selected = 0;
let written = null;
function flush() {
  if (typeof FS === 'undefined' || written === selected) return;
  try {
    // ZScript file reads are sandboxed beneath Files/<quest basename>.
    const directory = FS.cwd().replace(/\/$/, '') + '/Files/Homestead/charmville';
    FS.mkdirTree(directory);
    FS.writeFile(directory + '/follower.txt', String(selected));
    written = selected;
  } catch { /* Emscripten filesystem has not finished initializing. */ }
}
window.addEventListener('message', event => {
  if (event.source !== window.parent || !parentOrigins.has(event.origin)) return;
  const data = event.data;
  if (!data || data.type !== 'charmville:follower' || !allowedSpecies.has(data.speciesId)) return;
  selected = data.speciesId;
  flush();
});
const timer = setInterval(flush, 250);
window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
if (window.parent !== window) {
  let origin;try { origin = new URL(document.referrer).origin; } catch { /* No referrer. */ }
  for (const target of parentOrigins.has(origin) ? [origin] : parentOrigins) window.parent.postMessage({ type: 'charmville:follower-ready' }, target);
}
