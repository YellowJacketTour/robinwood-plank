import {expect} from 'chai';
import {writeFile} from 'node:fs/promises';
import {ethers} from './helpers/hardhat.js';
import {deployCasino,assertConserved} from './helpers/casino.js';
import {fetchRoundFromApis,parseG1} from '../../scripts/relay-drand.js';

// Explicit live-network probe: ordinary deterministic CI does not need HTTP.
(process.env.PLANK_REAL_BEACON==='1'?describe:describe.skip)('Indexed crash with published drand evmnet entropy',()=>{
 it('commits before publication, verifies signatures, settles, claims and rolls twice',async function(){
  this.timeout(360000);
  const hash='04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3';
  const origins=['https://api.drand.sh','https://api2.drand.sh','https://api3.drand.sh'];
  const info=await Promise.all(origins.map(async origin=>{
   const response=await fetch(`${origin}/${hash}/info`,{signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw new Error(`drand info ${response.status}`);return response.json();
  }));
  for(const entry of info){expect(entry).deep.eq(info[0]);expect(entry.hash).eq(hash);expect(entry.schemeID).eq('bls-bn254-unchained-on-g1');}
  const key=info[0].public_key.match(/.{64}/g).map((x:string)=>BigInt(`0x${x}`));
  const beacon:any=await (await ethers.getContractFactory('DrandBeacon')).deploy(`0x${hash}`,key,info[0].genesis_time,info[0].period,ethers.toUtf8Bytes('BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_'));
  const e=await deployCasino({beaconInstance:beacon,numberedLottery:true,scalable:{maxRoundStakeWei:10n**18n,maxUnderwritingWei:10n**15n},crash:{minStakeWei:10000n,bettingDurationSeconds:15n,maxSeats:1000000000n}});
  const results=[];
  for(let i=0;i<2;i++){
   const id=await e.crash.currentRoundId(),r=await e.crash.currentRound();
   await e.crash.connect(e.alice).placeBet(10100n,{value:10n**12n});
   await e.crash.connect(e.bob).placeBet(20000n,{value:2n*10n**12n});
   const published=await fetchRoundFromApis(origins,hash,'latest');
   expect(BigInt(published.round)).lessThan(r.targetDrandRound);
   expect(await beacon.randomnessOrZero(r.targetDrandRound)).eq(ethers.ZeroHash);
   // No local time travel can publish entropy: wait for the actual network.
   while(Date.now()<Number(r.revealNotBefore)*1000+4000)await new Promise(resolve=>setTimeout(resolve,1000));
   const entropy=await fetchRoundFromApis(origins,hash,r.targetDrandRound);
   const sig=parseG1(entropy.signature);
   await expect(beacon.submitRound(r.targetDrandRound+1n,sig)).revertedWithCustomError(beacon,'InvalidSignature');
   const relay=await (await beacon.submitRound(r.targetDrandRound,sig)).wait();
   const random=ethers.keccak256(`0x${entropy.signature.replace(/^0x/,'')}`);
   expect(await beacon.randomnessAt(r.targetDrandRound)).eq(random);
   const settlement=await (await e.crash.settleRound()).wait();
   const done=await e.crash.rounds(id);
   expect(done.crashBps).eq(await e.crash._deriveCrash(await e.crash.resultSeed(id,r.targetDrandRound,random)));
   const claims=[];
   for(const p of [e.alice,e.bob])if(await e.crash.targetOf(id,p.address)<=done.crashBps){
    const quote=await e.crash.paidOf(id,p.address);
    const claim=await (await e.crash.connect(e.keeper).claimPayout(id,p.address)).wait();
    const withdrawal=await (await e.crash.connect(p).withdraw()).wait();
    claims.push({player:p.address,payout:quote.toString(),claim:claim.hash,withdrawal:withdrawal.hash});
   }
   await e.crash.flushRake();await assertConserved(e,expect);
   expect(await e.crash.claimEscrow(id)).eq(0n);expect(await e.crash.currentRoundId()).eq(id+1n);
   results.push({round:id.toString(),targetDrandRound:r.targetDrandRound.toString(),publishedAtCommit:published.round,entropy,relay:relay.hash,settlement:settlement.hash,settlementGas:settlement.gasUsed.toString(),crashBps:done.crashBps.toString(),claims});
   console.log(`real drand round ${r.targetDrandRound}: crash ${done.crashBps}, settlement ${settlement.gasUsed} gas`);
  }
  if(process.env.PLANK_REAL_BEACON_OUTPUT)await writeFile(process.env.PLANK_REAL_BEACON_OUTPUT,JSON.stringify({schema:'plankcrash.real-beacon-local.v1',generatedAt:new Date().toISOString(),chainId:31337,scope:'real public signatures on local EVM; NOT public-testnet soak',origins,info:info[0],results},null,2));
 });
});
