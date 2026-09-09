// Read-only presentation projection. Never receives credentials or grants items.
const parentOrigins = new Set(['http://localhost:3017', 'http://127.0.0.1:3017']);
const allowedSpecies = new Set([0, 277, 280, 283, 25, 133, 286]);
let selected = [];let spacing=18;
let written = null;
function flush() {
  const projection=[...selected,...Array(6-selected.length).fill(0),spacing].join('|');
  if (typeof FS === 'undefined' || written === projection) return;
  try {
    // ZScript file reads are sandboxed beneath Files/<quest basename>.
    const directory = FS.cwd().replace(/\/$/, '') + '/Files/Homestead/charmville';
    FS.mkdirTree(directory);
    FS.writeFile(directory + '/follower.txt', String(selected[0] || 0));
    FS.writeFile(directory + '/party-followers.txt', projection);
    written = projection;
  } catch { /* Emscripten filesystem has not finished initializing. */ }
}
window.addEventListener('message', event => {
  if (event.source !== window.parent || !parentOrigins.has(event.origin)) return;
  const data = event.data;
  if (!data) return;
  if(data.type==='charmville:follower-formation' && ['close','relaxed'].includes(data.formation))spacing=data.formation==='relaxed'?26:18;
  else if(data.type==='charmville:follower' && allowedSpecies.has(data.speciesId)) selected=data.speciesId?[data.speciesId]:[];
  else if(data.type==='charmville:party-followers' && Array.isArray(data.speciesIds) && data.speciesIds.length<=6 && data.speciesIds.every(id=>id!==0&&allowedSpecies.has(id))) selected=[...data.speciesIds];
  else return;
  flush();
});
const timer = setInterval(flush, 250);
window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
if (window.parent !== window) {
  let origin;try { origin = new URL(document.referrer).origin; } catch { /* No referrer. */ }
  for (const target of parentOrigins.has(origin) ? [origin] : parentOrigins) window.parent.postMessage({ type: 'charmville:follower-ready' }, target);
}
