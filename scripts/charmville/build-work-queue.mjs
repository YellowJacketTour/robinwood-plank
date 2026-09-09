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
 ['Six-member follower train and formations','creatures','Distinct owned UUIDs; six visible followers; corners/warps; spacing and ordering.'],
 ['Attack, defend, hold and free-roam commands','creatures','Acknowledged server commands, valid target selection, no neutral aggression, recall and leash.'],
 ['Species-specific move animation and effects','creatures','Source markers and anchors bound to defined move events; projectile/effect ownership and single hit.'],
 ['Livestock intelligence and habitat assignment','professions','Care and grazing permissions, species capabilities, bounded produce and breeding receipts.'],
 ['Nintendo-quality Charmdex interaction pass','experience','Consistent hierarchy, belt selection, meaningful feedback, input parity and visual review of every state.'],
 ['All-source art replacement and provenance completeness','delivery','Each used asset has source, hash, attribution, runtime role, replacement status and verified dimensions.'],
 ['Browser desktop/mobile GPU and memory budgets','delivery','Measure startup, frame time, memory and input latency; record device/browser and fallback.'],
 ['Account-transition recovery and GitHub handoff','delivery','Committed sources, reproducible setup and zero-context handoff with current blockers.']];
for(const [feature,lane,acceptance] of supplements)items.push({id:`CV-${String(items.length+1).padStart(3,'0')}`,feature,section:'Additional explicit player requirements',lane,maturity:'not scored',evidence:'Explicit conversation requirement; do not infer completion from assignment.',acceptance,status:'queued'});
for(const item of items)if(['Followers and companion reactions','Party / storage / clinic','Six-member follower train and formations'].includes(item.feature))item.status='in progress';
const data={generatedAt:'2026-09-09',source:'FEATURE-PROGRESS.md',concurrency:{coordinator:1,workers:3},note:'Complete row coverage is assignment coverage, not implementation completion. Maturity is copied from the evidence tracker and is not percent complete. Workers rotate through lanes; queued lanes are not running.',items};
await writeFile(root+'SWARM-WORK-QUEUE.json',JSON.stringify(data,null,2)+'\n');
let md='# Charmville implementation work queue\n\n'+data.note+'\n\nCapacity: one integration coordinator and three concurrent workers. Every progress-table row has a work item; explicit follow-up requirements are appended.\n\n## Current assignments\n\n- Native worker: source-ground anchors and path/warp visual verification.\n- State worker: saved action intent verification and desktop/mobile performance baseline.\n- Experience worker: saved garden access inside the game shell and fullscreen menu.\n- Coordinator: cross-system test, evidence reconciliation, source preservation and next work dispatch.\n\n## Dispatch order and integration gates\n\n1. Finish and test the current roster/menu/native chain.\n2. Rotate native work to tool contact and collision; state work to authoritative resource actions; experience work to input and layout defects.\n3. Connect one resource action through animation, owned inventory, crafting consumption and exchange settlement.\n4. Add authoritative encounter/capture, then combat commands and move bindings.\n5. Extend authored homes/travel, production chains, social overlays and builder tools on the same state model.\n6. Each lane must pass its evidence gates; performance and source fidelity are checked throughout. No assignment alone raises a maturity bar.\n';
for(const [lane] of Object.values(lanes)){md+=`\n## ${lane}\n\n| Work | Feature | Status | Existing maturity | Required evidence |\n|---|---|---|---|---|\n`;for(const i of items.filter(i=>i.lane===lane))md+=`| ${i.id} | ${i.feature} | ${i.status} | ${i.maturity} | ${i.acceptance} Current gap: ${i.evidence} |\n`;}
await writeFile(root+'SWARM-WORK-QUEUE.md',md);
console.log(`${items.length} work items across ${Object.keys(lanes).length} lanes.`);
