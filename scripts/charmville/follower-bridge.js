// Read-only presentation projection. Never receives credentials or grants items.
const parentOrigins = new Set(['http://localhost:3017', 'http://127.0.0.1:3017']);
const allowedSpecies = new Set([0, 277, 280, 283, 25, 133, 286]);
let selected = [];let identities=[];let spacing=18;
// Explicit standalone six-party playtest; never an account inventory grant.
if(typeof location!=='undefined' && window.parent===window){
 const query=new URLSearchParams(location.search);
 if(query.get('testParty')==='6' && (query.get('test')||'').includes('/homestead-region/'))selected=[277,280,283,25,133,286];
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let written = null;
let writtenFs = null;
function flush() {
  const projection=[...selected,...Array(6-selected.length).fill(0),spacing].join('|');
  const identityProjection=[...identities,...Array(6-identities.length).fill('')].join('|');
  if (typeof FS === 'undefined') return;
  try {
    // ZScript file reads are sandboxed beneath Files/<quest basename>.
    const directory = FS.cwd().replace(/\/$/, '') + '/Files/Homestead/charmville';
    const fingerprint=directory+';'+projection+';'+identityProjection;
    const paths=['follower.txt','party-followers.txt','party-follower-ids.txt'].map(name=>directory+'/'+name);
    // Loading/reinitializing a quest can replace its filesystem or remove these
    // files without changing the selected party. Re-project after that lifecycle
    // change rather than retaining a successful write from a vanished mount.
    if(writtenFs===FS&&written===fingerprint&&paths.every(path=>typeof FS.analyzePath!=='function'||FS.analyzePath(path).exists))return;
    FS.mkdirTree(directory);
    FS.writeFile(directory + '/follower.txt', String(selected[0] || 0));
    FS.writeFile(directory + '/party-followers.txt', projection);
    FS.writeFile(directory + '/party-follower-ids.txt', identityProjection);
    written = fingerprint;
    writtenFs = FS;
  } catch { /* Emscripten filesystem has not finished initializing. */ }
}
window.addEventListener('message', event => {
  if (event.source !== window.parent || !parentOrigins.has(event.origin)) return;
  const data = event.data;
  if (!data) return;
  if(data.type==='charmville:follower-formation' && ['close','relaxed'].includes(data.formation))spacing=data.formation==='relaxed'?26:18;
  else if(data.type==='charmville:follower' && allowedSpecies.has(data.speciesId)) {selected=data.speciesId?[data.speciesId]:[];identities=[];}
  else if(data.type==='charmville:party-followers' && Array.isArray(data.speciesIds) && data.speciesIds.length<=6 && data.speciesIds.every(id=>id!==0&&allowedSpecies.has(id))) {
    if(data.creatureIds!==undefined&&(!Array.isArray(data.creatureIds)||data.creatureIds.length!==data.speciesIds.length||!data.creatureIds.every(id=>typeof id==='string'&&(id===''||uuid.test(id)))))return;
    selected=[...data.speciesIds];identities=data.creatureIds?[...data.creatureIds]:[];
  }
  else return;
  flush();
});
const timer = setInterval(flush, 250);
window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
if (window.parent !== window) {
  let origin;try { origin = new URL(document.referrer).origin; } catch { /* No referrer. */ }
  for (const target of parentOrigins.has(origin) ? [origin] : parentOrigins) window.parent.postMessage({ type: 'charmville:follower-ready' }, target);
}
