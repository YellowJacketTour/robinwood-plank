import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {settleCappedPool} from '../../lib/casino/economics-capped-pool.js';
const stake=10n**18n,rake=stake*450n/10000n,player=stake-rake;
// Current router's 69% community leg, 65% lottery subdivision; kappa=2.
const lotteryInflow=(rake*6900n/10000n)*6500n/10000n;
const lotteryExpectedCeiling=lotteryInflow/2n;
const cases=[];
for(const target of [10100n,20000n,100000n])for(const funding of [0n,rake/2n,stake*target/10000n-player]){
  let sum=0n,bonusSum=0n,survivors=0;
  const seats=[{id:'coalition',stake,targetBps:target}];
  for(let residue=0n;residue<10000n;residue++){
    const crash=100000000n/(10000n-residue),r=settleCappedPool(player,funding,crash,seats);
    assert.equal(r.totalPayout+r.houseReturned+r.bustedToReserve,player+funding);
    assert.ok(r.totalBonus<=funding);sum+=r.totalPayout;bonusSum+=r.totalBonus;
    if(crash>=target)survivors++;
  }
  cases.push({targetBps:target.toString(),seedWei:funding.toString(),survivalOutcomes:survivors,totalOutcomes:10000,expectedCrashReturnWei:(sum/10000n).toString(),expectedSubsidySpentWei:(bonusSum/10000n).toString(),lotteryExpectedCeilingWei:lotteryExpectedCeiling.toString(),combinedExpectedNetCeilingWei:(sum/10000n+lotteryExpectedCeiling-stake).toString()});
}
assert.ok(BigInt(cases[2].combinedExpectedNetCeilingWei)>0n,'fully funded true multipliers plus lottery need an explicit subsidy policy');
assert.ok(BigInt(cases[0].combinedExpectedNetCeilingWei)<0n);
const report={schema:'plankcrash.subsidy-envelope.v1',assumptions:['Uniform crash residue model; finite hash modulo bias is negligible but not a literal uniformity proof.','One principal owns the whole round. Gas excluded. Rake 4.5%, keeper 0, community 69%, lottery share 65%, kappa 2.','Lottery number rounding and jackpot caps can reduce its expectation below the reported upper bound.','The positive upper bound is a counterexample to blanket non-farming claims, not a claim that every live jackpot realizes that bound.','Solvency and positive protected contributions do not imply monotonic spendable rewards.'],cases};
const text=JSON.stringify(report,null,2)+'\n';if(process.argv[2])await writeFile(process.argv[2],text);process.stdout.write(text);
