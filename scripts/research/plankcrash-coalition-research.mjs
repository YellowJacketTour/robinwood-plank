import {writeFile} from 'node:fs/promises';
import {settleCcs2L,DEFAULT_CCS2L} from '../../docs/marketplank/sim-settlement-ccs2l/engine.mjs';
const out='C:/Users/k1rby/Documents/Codex/2026-09-09/find/outputs/';
const targets=[10100,11000,12500,15000,20000,30000,50000,100000,200000,500000,1000000];
const survival=m=>Math.min(9999,Math.floor(100000000/m))/10000;
const floor=.75,rake=.045,bonusRate=.25;
function evaluate(honest,attack){
 const seats=[...honest,...attack],Q=seats.reduce((a,s)=>a+s.stake,0),A=attack.reduce((a,s)=>a+s.stake,0),D=Q*(1-rake),H=Q*rake*bonusRate;
 const points=[...new Set(seats.map(s=>s.target))].sort((a,b)=>a-b);let playerEV=0,bonusEV=0,minNet=Infinity,allProfitable=true;
 for(let k=0;k<points.length;k++){const m=points[k],p=survival(m)-(points[k+1]?survival(points[k+1]):0),living=seats.filter(s=>s.target<=m);const F=living.reduce((a,s)=>a+floor*s.stake,0),W=living.reduce((a,s)=>a+s.stake*Math.log(s.target/10000),0);let paid=0,b=0;
  for(const s of attack)if(s.target<=m){const w=s.stake*Math.log(s.target/10000);paid+=floor*s.stake+(D-F)*w/W;b+=Math.min(H*w/W,s.stake*(s.target/10000-1));}
  playerEV+=p*paid;bonusEV+=p*b;minNet=Math.min(minNet,paid+b-A);if(paid+b<A)allProfitable=false;
 }
 // Conservative maximum lottery expectation at the intended contribution split.
 const lotteryUpper=A*rake*.4485/2;
 return {playerEV,bonusEV,netEV:playerEV+bonusEV-A,lotteryUpper,netUpper:playerEV+bonusEV+lotteryUpper-A,roi:(playerEV+bonusEV)/A-1,bonusToOwnRake:bonusEV/(A*rake)};
}
const populations=[];
for(const alpha of [1.05,1.2,1.5,2,3])for(const correlation of ['large-low','large-high','mixed']){
 const raw=Array.from({length:96},(_,i)=>Math.pow(96/(i+.5),1/alpha)),total=raw.reduce((a,b)=>a+b,0);
 const seats=raw.map((stake,i)=>({stake:stake/total,target:correlation==='large-low'?targets[Math.min(10,Math.floor(i/9))]:correlation==='large-high'?targets[10-Math.min(10,Math.floor(i/9))]:targets[(i*7)%11]}));
 populations.push({name:`pareto-${alpha}-${correlation}`,alpha,correlation,seats,hhi:seats.reduce((a,s)=>a+s.stake*s.stake,0),largest:seats[0].stake,top20:seats.slice(0,20).reduce((a,s)=>a+s.stake,0)});
}
for(const target of [10100,20000,100000])populations.push({name:`uniform-target-${target}`,seats:Array.from({length:20},()=>({stake:.05,target})),hhi:.05,largest:.05});
const results=[];let evaluations=0;
for(const pop of populations)for(const share of [.001,.01,.05,.2,.5,.8]){
 const amount=share/(1-share);let bestSingle=null,bestSplit=null;
 for(const target of targets){const attack=[{stake:amount,target}],ev=evaluate(pop.seats,attack);evaluations++;if(!bestSingle||ev.netEV>bestSingle.ev.netEV)bestSingle={attack,ev};}
 for(let a=0;a<targets.length;a++)for(let b=a+1;b<targets.length;b++)for(const fraction of [.05,.1,.2,.4,.5,.6,.8,.9,.95]){
  const attack=[{stake:amount*fraction,target:targets[a]},{stake:amount*(1-fraction),target:targets[b]}],ev=evaluate(pop.seats,attack);evaluations++;if(!bestSplit||ev.netEV>bestSplit.ev.netEV)bestSplit={attack,ev};
 }
 results.push({population:pop.name,share,hhi:pop.hhi,largest:pop.largest,bestSingle,bestSplit,splitImprovement:(bestSplit.ev.netEV-bestSingle.ev.netEV)/amount,honest:pop.seats});
}
results.sort((a,b)=>b.splitImprovement-a.splitImprovement);
const params={...DEFAULT_CCS2L,maxVaultBonusBps:2500n,vaultBonusDecayWad:999000000000000000n};
async function exact(row){
 const scale=10n**18n;
 function calc(attack){const seats=[...row.honest.map((s,i)=>({id:'h'+i,stake:BigInt(Math.round(s.stake*1e15))*1000n,targetBps:BigInt(s.target)})),...attack.map((s,i)=>({id:'a'+i,stake:BigInt(Math.round(s.stake*1e15))*1000n,targetBps:BigInt(s.target)}))];const Q=seats.reduce((a,s)=>a+s.stake,0n),A=seats.filter(s=>s.id.startsWith('a')).reduce((a,s)=>a+s.stake,0n),D=Q*9550n/10000n,R=Q-D;let paidNumerator=0n,bonusNumerator=0n;
  const points=[...new Set(seats.map(s=>Number(s.targetBps)))].sort((a,b)=>a-b);
  for(let k=0;k<points.length;k++){const mass=BigInt(Math.min(9999,Math.floor(1e8/points[k]))-(points[k+1]?Math.min(9999,Math.floor(1e8/points[k+1])):0));const r=settleCcs2L(D,10n**21n,BigInt(points[k]),seats,10n**23n,params,R,1000000000n);for(const seat of r.allocations)if(String(seat.id).startsWith('a')){paidNumerator+=mass*seat.payout;bonusNumerator+=mass*seat.houseBonus;}}
  return {stake:A.toString(),paidNumerator:paidNumerator.toString(),bonusNumerator:bonusNumerator.toString(),denominator:'10000',netEV:Number(paidNumerator-A*10000n)/10000/Number(scale),roi:Number(paidNumerator)/10000/Number(A)-1};
 }
 return {population:row.population,share:row.share,single:calc(row.bestSingle.attack),split:calc(row.bestSplit.attack),attacks:{single:row.bestSingle.attack,split:row.bestSplit.attack}};
}
// For a single position, payout is nondecreasing in target within each exact
// survival plateau. Therefore the plateau endpoints cover every accepted
// single-target optimum (up to the configured 10000x cap), not merely our grid.
const exactChecks=[];
const singleEndpoints=[...new Set(Array.from({length:9900},(_,i)=>Math.floor(1e8/(i+1))))].filter(m=>m>=10100&&m<=1e8);
for(const row of results.slice(0,6)){
 const amount=row.share/(1-row.share);let best=row.bestSingle;
 for(const target of singleEndpoints){const attack=[{stake:amount,target}],ev=evaluate(row.honest,attack);if(ev.netEV>best.ev.netEV)best={attack,ev};}
 row.bestSingle=best;row.splitImprovement=(row.bestSplit.ev.netEV-best.ev.netEV)/amount;
 exactChecks.push(await exact(row));
}

const bestProfit=[...results].sort((a,b)=>Math.max(b.bestSingle.ev.roi,b.bestSplit.ev.roi)-Math.max(a.bestSingle.ev.roi,a.bestSplit.ev.roi))[0];
const report={assumptions:{rake,floor,bonusRate,age:1000000000,targets,population:'96 synthetic deterministic Pareto-quantile bettors; not observed users',lottery:'only conservative EV upper bound; no asserted realized win',numerics:'floating search, integer reference verification of top six plus exhaustive single-target survival-plateau endpoint search; exact 10000-residue survival masses under uniform-residue model'},evaluations,exactChecks,largestSplitImprovement:results[0],bestProfit,results};
await writeFile(out+'coalition-research-results.json',JSON.stringify(report,null,2));
await writeFile(out+'coalition-research-results.csv','population,attacker_pool_share,hhi,best_single_roi,best_two_target_roi,split_improvement\n'+results.map(r=>[r.population,r.share,r.hhi,r.bestSingle.ev.roi,r.bestSplit.ev.roi,r.splitImprovement].join(',')).join('\n'));
console.log(JSON.stringify({evaluations,exactChecks,bestProfit:{population:bestProfit.population,share:bestProfit.share,single:bestProfit.bestSingle,split:bestProfit.bestSplit},largestSplitImprovement:results[0].splitImprovement},null,2));
