import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../public/arcade/crash.html", import.meta.url), "utf8");
const start = source.indexOf("async function keeperTick(");
const end = source.indexOf("let roundRefreshBusy", start);
function keeper(crash: object, available: boolean | (()=>Promise<boolean>) = false, invite=false, signer: object|null=null) {
  return new Function("crash", "beaconContract", "INVITE_TEST", "signer", `let attemptedLockThisRound=false, attemptedSettleThisRound=false, attemptedRegisterThisRound=false, attemptedClaimThisRound=false; const refundTimeoutCache=100,bankMode=false; ${source.slice(start,end)}; return keeperTick;`)(crash, {isRoundAvailable: typeof available==='function'?available:async()=>available},invite,signer);
}

test('invite guests leave round operations to the server while still collecting their own winnings',async()=>{
  let roundOperations=0,withdrawals=0;
  const operation=async()=>{roundOperations++;return{wait:async()=>({status:1})};};
  const tick=keeper({lockRound:operation,settleRound:operation,freezeStalledRound:operation,owed:async()=>5n,withdraw:async()=>{withdrawals++;return{wait:async()=>({status:1})};}},true,true,{address:'guest'});
  await tick({phase:0,bettingEndsAt:10,revealNotBefore:70,targetDrandRound:1},1n,1,200);
  await tick({phase:1,bettingEndsAt:10,revealNotBefore:70,targetDrandRound:1},1n,1,201);
  assert.equal(roundOperations,0);assert.equal(withdrawals,1);
});
test("a failed browser beacon read freezes without refunding or replacing the draw",async()=>{
  let freezes=0;
  const tick=keeper({freezeStalledRound:async()=>{freezes++;return{wait:async()=>({status:1})};}},async()=>{throw Error('beacon offline');});
  await tick({phase:1,bettingEndsAt:10,revealNotBefore:70,targetDrandRound:1},1n,1,170);
  assert.equal(freezes,1);
});
test("browser freeze recovery waits from reveal time and retries failed transactions", async () => {
  let calls=0;
  const tick=keeper({freezeStalledRound:async()=>{calls++;if(calls===1)throw Error("temporary RPC failure");return {wait:async()=>({status:1})};}});
  const round={phase:1,bettingEndsAt:10,revealNotBefore:70,targetDrandRound:1};
  await tick(round,1n,1,110); assert.equal(calls,0,"betting-end timeout is too early");
  await tick(round,1n,1,170); assert.equal(calls,1);
  await tick(round,1n,1,171); assert.equal(calls,2,"retry after failure");
  await tick(round,1n,1,172); assert.equal(calls,2,"successful attempt stays guarded");
});
test("browser lock and settlement recover after a transient rejected attempt", async () => {
  for(const [operation,phase,available] of [["lockRound",0,false],["settleRound",1,true]] as const){
    let calls=0;
    const tick=keeper({[operation]:async()=>{calls++;if(calls===1)throw Error("temporary");return{wait:async()=>({status:1})};}},available);
    const round={phase,bettingEndsAt:10,revealNotBefore:70,targetDrandRound:1};
    await tick(round,1n,1,100);await tick(round,1n,1,101);await tick(round,1n,1,102);
    assert.equal(calls,2,operation);
  }
});
