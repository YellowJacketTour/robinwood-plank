// Executable mathematical reference, not a deployed contract or oracle.
// All money arithmetic is integer. Entropy is assumed uniform and unavailable
// until commitments close; this file does not establish that external premise.
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const B=10000n,M=1n<<256n;
let rng=917231n,checks=0;
const random=n=>{rng=(rng*6364136223846793005n+1442695040888963407n)&((1n<<64n)-1n);return rng%n;};
const check=(value,message)=>{assert.ok(value,message);checks++;};
const ceil=(a,b)=>(a+b-1n)/b;
const max=(a,b)=>a>b?a:b;
const quote=(s,m,phi,fee)=>({s,m,payout:s*m*phi/(B*B),fee:ceil(s*fee,B)});
const liability=c=>max(c.s,c.payout+c.fee);
const mass=(m,edge)=>((M*(B-edge)/B)*B)/m;

// Proposed exact-word nested crash law; the target is in basis points.
for(let i=0;i<100000;i++){
 const s=1n+random(10n**24n),m=10100n+random(99989901n),phi=1n+random(B),edge=random(1000n);
 const c=quote(s,m,phi,400n),n=mass(m,edge);
 check(n*c.payout*B*B<=M*s*phi*(B-edge),'conditional expected payout bound');
 const a=random(s+1n),first=quote(a,m,phi,400n),second=quote(s-a,m,phi,400n);
 check(first.payout+second.payout<=c.payout,'splitting cannot increase a fixed-position claim');
 check(first.fee+second.fee>=c.fee,'splitting cannot reduce rounded processing cost');
 check(liability(c)>=c.payout+c.fee&&liability(c)>=s,'reserve covers settlement AND full stake refund');
 const legacyMass=100000000n/m;
 const capped=quote(s,m,B,0n).payout;
 check(legacyMass*capped<=B*s,'capping total crash payout at locked X bounds legacy expected return');
}

// A fixed committed-stake denominator prevents survivor scarcity from turning
// a tiny extension position into ownership of the whole extension reserve.
for(let i=0;i<10000;i++){
 const stakes=Array.from({length:16},()=>1n+random(10n**18n)),Q=stakes.reduce((a,b)=>a+b,0n),bonus=1n+random(10n**24n);
 const awards=stakes.map(s=>bonus*s/Q);
 check(awards.reduce((a,b)=>a+b,0n)<=bonus,'extension reserve is sufficient even if everyone earns it');
 const s=stakes[0],a=random(s+1n);
 check(bonus*a/Q+bonus*(s-a)/Q<=awards[0],'extension splitting cannot increase the committed share');
}

// Stateful reference: callers cannot settle a made-up claim list or replay a
// terminal transition. Real contracts must authenticate entropy/refund authority.
class Book{
 constructor(buffer,protectedFunds){this.assets=buffer+protectedFunds;this.protected=protectedFunds;this.reserved=0n;this.owed=0n;this.fees=0n;this.rounds=new Map();}
 free(){return this.assets-this.protected-this.reserved-this.owed-this.fees;}
 open(id,phi){assert.ok(!this.rounds.has(id));this.rounds.set(id,{phase:'open',phi,claims:new Map()});}
 accept(round,id,s,m){const r=this.rounds.get(round);assert.equal(r.phase,'open');assert.ok(!r.claims.has(id));const c=quote(s,m,r.phi,400n),l=liability(c);if(this.free()+s<l)return false;this.assets+=s;this.reserved+=l;r.claims.set(id,c);check(this.free()>=0n,'admission solvency');return true;}
 seal(id){const r=this.rounds.get(id);assert.equal(r.phase,'open');r.phase='sealed';}
 finish(id,refund,word=0n){const r=this.rounds.get(id);assert.equal(r.phase,'sealed');for(const c of r.claims.values()){this.reserved-=liability(c);this.owed+=refund?c.s:word<mass(c.m,450n)?c.payout:0n;if(!refund)this.fees+=c.fee;}r.phase=refund?'refunded':'settled';check(this.free()>=0n,'terminal solvency');}
 withdraw(){this.assets-=this.owed;this.owed=0n;check(this.free()>=0n&&this.assets>=this.protected,'withdrawal preserves protected funds');}
}
let accepted=0,rejected=0;
for(let simulation=0;simulation<100;simulation++){
 const book=new Book(10n**20n,10n**22n),floor=book.protected;
 for(let round=0;round<40;round++){
  book.open(round,9500n+BigInt(round)*10n);
  for(let i=0;i<32;i++){
   const s=10n**12n+random(10n**17n),m=10100n+random(1000000n);
   if(book.accept(round,i,s,m))accepted++;else rejected++;
  }
  book.seal(round);
  assert.throws(()=>book.accept(round,999,10n**12n,20000n));checks++;
  // Correlated worst-case all-survive, all-bust, and whole-round refunds.
  book.finish(round,round%3===0,round%3===1?0n:M-1n);
  assert.throws(()=>book.finish(round,false));checks++;
  book.withdraw();check(book.protected===floor,'principal never finances claims');
 }
}

// Integer balls: smallest N respecting the funded payout budget; winning label
// is the least frequent residue under a 256-bit modulo map, as in the candidate.
for(let i=0;i<100000;i++){
 const prize=1n+random(10n**30n),budget=1n+random(prize),n=max(16n,ceil(prize,budget));
 check(prize<=n*budget,'one-in-N expected prize is within budget');
 check((M/n)*prize<=M*budget,'finite-word winning residue remains within budget');
}

const examples={
 currentFullMultiplierBlocker:{rakeBps:450,matureBonusFractionOfRakeBps:2500,maximumReturnPerStakeWhenAllSurvive:0.96625,requiredReturnAt2x:2,minimumUnderwritingGapPerStake:1.03375},
 soleSurvivor:{honestStakeWei:'1000000000000000000',attackerStakeWei:'1000000000000000',rakeBps:450,earlySurvivalResidues:8900,denominator:10000,minimumExpectedGrossWei:((1001000000000000000n*9550n/10000n)*8900n/10000n).toString()},
 commonCrash:{players:1000000,stakePerPlayer:1,winProbability:0.5,winningMultiplier:2,aggregatePayoutVariance:1000000000000},
 sublinearIdentityReward:{gamma:0.5,identities:100,splitGainFactor:10},
 proposedBudget:{edgeBps:450,initialPayoutFactorBps:9500,maturePayoutFactorBps:10000,protectedVaultBps:25,protectedLotteryBps:25,operationsBps:50,burnBps:100,prizeInflowBps:200,expectedPrizeOutflowCapBps:100,expectedFreeBufferRetentionAtMaturityBps:50,initialCrashReturnBps:9072.5,matureCrashReturnBps:9550,maximumMatureCombinedPlayerReturnBps:9650},
};
const output={schema:'plankcrash.vision-math.v1',checks,books:100,rounds:4000,accepted,rejected,examples,scope:'Research reference; no production deployment, no oracle proof, no evidence of independent audit. Uniform 256-bit entropy and valid authorization are assumptions. The alternative payout law is NOT the current 10000-residue contract.'};
const target=resolve(process.argv[2]||'artifacts/plankcrash-vision-research/invariants.json');mkdirSync(dirname(target),{recursive:true});writeFileSync(target,JSON.stringify(output,null,2));console.log(JSON.stringify(output));
