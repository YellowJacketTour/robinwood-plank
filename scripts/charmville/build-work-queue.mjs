import {readFile,writeFile} from 'node:fs/promises';
const root='docs/charmville-reconstruction/';
const source=await readFile(root+'FEATURE-PROGRESS.md','utf8');
const lanes={
'Shared foundation':['authority','Authenticated state, permission, retry and reconnect checks with two isolated accounts.'],
'Zelda / Graal adventure and presentation':['world-actions','Four-facing visual playback, contact timing, collision, interruption and world-state acceptance.'],
'Pokémon / companion systems':['creatures','Owned entity continuity, species-specific art, command acknowledgment and replay-safe transitions.'],
'RuneScape / FarmVille / Stardew / Animal Crossing / Palworld / Minecraft':['professions','Visible action and resource lifecycle; server input debit/output conservation; reload and visitor rights.'],
'SimCity / Age of Empires / EVE / No Man\'s Sky world scale':['world-travel','Authored map route, border and instance transition, access rules, recovery and measured streaming.'],
'Charms / Grained Exchange / social economy':['economy','Conserved supply and escrow, retries and concurrency, clear player costs and observable settlement.'],
'Communications, social and player controls':['experience','Keyboard, touch and controller flow; focus/close/reopen; accessibility; no unintended input or publication.'],
'Builder, quality and delivery':['delivery','Reproducible validation, documented evidence, rollback and measured target-device performance.']};
let section='';const items=[];
for(const line of source.split(/\r?\n/)){
 if(line.startsWith('## '))section=line.slice(3);
 if(!lanes[section]||!line.startsWith('| ')||!/[█░]{5}/u.test(line))continue;
 const [,feature,maturity,evidence]=line.split('|').map(s=>s.trim());
 const [lane,acceptance]=lanes[section];items.push({id:`CV-${String(items.length+1).padStart(3,'0')}`,feature,section,lane,maturity,evidence,acceptance,status:'queued'});
}
const supplements=[
 ['Retire standalone garden entry points','experience','Old garden routes return to the adventure; no Porch gameplay surfaces or parallel Garden menu; preserve stored accounts and receipts.'],
 ['Trusted authored collision geometry','world-actions','Pinned map identity and collision export; server validates traversable cells independently of client coordinates.'],
 ['Server-owned native movement','authority','Authenticated input sequence, speed/collision/range validation, stale epoch rejection and reconnect; two accounts cannot impersonate movement.'],
 ['Timed native action settlement','authority','Server action start/contact/cancel; atomic input debit and resource update; revoke-at-contact, replay and lost-response receipt tests.'],
 ['Shared native resource presentation','world-actions','Two clients render one authoritative resource lifecycle; rejected/cancelled actions cannot show saved yield or mutate account balances.'],
 ['Native resource to exchange continuity','economy','One server-authorized native harvest reaches inventory, crafting input consumption and escrow trade with conserved quantities.'],
 ['Native account action feedback','experience','Distinguish local observation, accepted start, committed receipt and rejected action; never label an animation as saved success.'],
 ['Six-member follower train and formations','creatures','Distinct owned UUIDs; six visible followers; corners/warps; spacing and ordering.'],
 ['Attack, defend, hold and free-roam commands','creatures','Acknowledged server commands, valid target selection, no neutral aggression, recall and leash.'],
 ['Species-specific move animation and effects','creatures','Source markers and anchors bound to defined move events; projectile/effect ownership and single hit.'],
 ['Livestock intelligence and habitat assignment','professions','Care and grazing permissions, species capabilities, bounded produce and breeding receipts.'],
 ['Nintendo-quality Charmdex interaction pass','experience','Consistent hierarchy, belt selection, meaningful feedback, input parity and visual review of every state.'],
 ['All-source art replacement and provenance completeness','delivery','Each used asset has source, hash, attribution, runtime role, replacement status and verified dimensions.'],
 ['Browser desktop/mobile GPU and memory budgets','delivery','Measure startup, frame time, memory and input latency; record device/browser and fallback.'],
 ['Account-transition recovery and GitHub handoff','delivery','Committed sources, reproducible setup and zero-context handoff with current blockers.']];
for(const [feature,lane,acceptance] of supplements)items.push({id:`CV-${String(items.length+1).padStart(3,'0')}`,feature,section:'Additional explicit player requirements',lane,maturity:'not scored',evidence:'Explicit conversation requirement; do not infer completion from assignment.',acceptance,status:'queued'});
const byFeature=new Map(items.map(item=>[item.feature,item]));
const prerequisites={
 'Server-owned native movement':['Trusted authored collision geometry'],
 'Timed native action settlement':['Server-owned native movement','Help versus harvest/build/storage rights'],
 'Shared native resource presentation':['Timed native action settlement'],
 'Native resource to exchange continuity':['Shared native resource presentation','Player trades / order book / escrow'],
 'Native account action feedback':['Timed native action settlement'],
 'Real-time creature combat':['Server-owned native movement','Timed native action settlement'],
 'Capture / ball consumption / ownership':['Real-time creature combat'],
 'Private/public border transitions':['Server-owned native movement','Account-owned map instances'],
 'Proximity voice / party voice':['Party and region shard routing'],
 'Species-specific move animation and effects':['Real-time creature combat'],
};
const laneGates={authority:['Trusted authored collision geometry'], 'world-actions':['Server-owned native movement'],creatures:['Server-owned native movement','Timed native action settlement'],professions:['Timed native action settlement'], 'world-travel':['Server-owned native movement'],economy:['Timed native action settlement'],experience:['Native account action feedback'],delivery:['Native resource to exchange continuity']};
for(const item of items){
 item.prerequisites=(prerequisites[item.feature]??[]).map(name=>byFeature.get(name).id);
 item.laneBlockers=(laneGates[item.lane]??[]).filter(name=>name!==item.feature).map(name=>byFeature.get(name).id);
 item.priority=['Trusted authored collision geometry','Server-owned native movement','Timed native action settlement'].includes(item.feature)?'P0':item.prerequisites.length?'P1':'P2';
 if(item.feature==='Server-owned native movement'){item.status='connected locally; broader acceptance pending';item.evidence='Seven native 8px steps persisted; actor identity/replay/reconnect/expiry/travel and20ms jitter tests passed. Two-account standing peer projection verified, capped16 and polled2s; no interpolation/hit collisions, combat, rewards or native warps. Oran-only settlement is now verified; weapon/encounter authority, additional resource content and unified equipment remain blocking. See NATIVE-ACCOUNT-MOVEMENT.md.';}
 if(['Timed native action settlement','Native resource to exchange continuity'].includes(item.feature)){item.status='Oran scope connected; broader acceptance pending';item.evidence='Native private till/plant/water/30s growth/harvest inventory and reload passed; PG escrow cancel/revoke/duplicate commits passed. No wider crop catalogue, crafting, combat or capture. See NATIVE-ECONOMIC-LOOP.md.';}
 if(item.feature==='Retire standalone garden entry points'){item.status='verified bounded removal';item.laneBlockers=[];item.priority='P0';}
 if(item.feature==='Preserved legacy garden storage (retired UI)'){item.status='preserved infrastructure; product UI retired';item.priority='archive';item.laneBlockers=[];}
 if(['Trusted authored collision geometry','Server-owned native movement','Timed native action settlement'].includes(item.feature))item.laneBlockers=[];
}

const data={generatedAt:'2026-09-09',source:'FEATURE-PROGRESS.md',concurrency:{coordinator:1,workers:3},note:'Complete row coverage is assignment coverage, not implementation completion. Maturity is copied from the evidence tracker and is not percent complete. Workers rotate through lanes; queued lanes are not running.',items};
await writeFile(root+'SWARM-WORK-QUEUE.json',JSON.stringify(data,null,2)+'\n');
let md='# Charmville implementation work queue\n\n'+data.note+'\n\nCapacity: one integration coordinator and three concurrent workers. Every progress-table row has a work item; explicit follow-up requirements are appended.\n\n## Current assignments\n\n- Native worker: trusted geometry and source contact observation validation.\n- State worker: authenticated movement service; unverified until integration evidence is recorded.\n- Experience worker: unified action feedback and menu/accessibility acceptance; standalone garden UI is retired.\n- Coordinator: cross-system test, evidence reconciliation, source preservation and next work dispatch.\n\n## Dispatch order and integration gates\n\n1. Validate trusted authored collision geometry and authenticated server-owned movement.\n2. Add timed native action start/contact/cancel and replay-safe receipts; observations alone cannot settle rewards.\n3. Replicate one committed native resource change to two accounts, then connect its inventory output to crafting and exchange.\n4. Extend the verified Oran loop with authoritative weapons/encounters, additional resource definitions and unified owned equipment; capture follows combat continuity.\n5. Extend authored homes/travel, production chains, social overlays and builder tools on the same state model.\n6. Each lane must pass its evidence gates; performance and source fidelity are checked throughout. No assignment alone raises a maturity bar.\n';
for(const [lane] of Object.values(lanes)){md+=`\n## ${lane}\n\n| Work | Feature | Status | Existing maturity | Priority / prerequisites | Required evidence |\n|---|---|---|---|---|---|\n`;for(const i of items.filter(i=>i.lane===lane))md+=`| ${i.id} | ${i.feature} | ${i.status} | ${i.maturity} | ${i.priority}; required: ${i.prerequisites.join(", ")||"none"}; lane gates: ${i.laneBlockers.join(", ")||"none"} | ${i.acceptance} Current gap: ${i.evidence} |\n`;}
await writeFile(root+'SWARM-WORK-QUEUE.md',md);
console.log(`${items.length} work items across ${Object.keys(lanes).length} lanes.`);
