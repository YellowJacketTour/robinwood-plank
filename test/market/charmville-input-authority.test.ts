import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputAuthority} from '../../lib/charmville/input-authority';
import {createInputReconciliation} from '../../lib/charmville/input-reconciliation';
const initial={epoch:1,ack:0,revision:0,state:{x:0}};
const cloneState=(s:{x:number})=>({...s});
const step=(s:{x:number},i:number)=>({x:s.x+i});
const make=()=>createInputAuthority({initial,nowMs:0,tickMs:10,maxCatchupTicks:30,maxBatch:32,step,cloneState,readInput:raw=>{if(raw!==1&&raw!==-1)throw Error('Invalid direction');return raw;}});
test('authority and predictor stay continuous with delayed batched acknowledgments',()=>{
 const server=make();const client=createInputReconciliation({initial,maxPending:64,step,cloneState,cloneInput:(i:number)=>i});
 const replies:{at:number;s:ReturnType<typeof server.snapshot>}[]=[];
 for(let t=1;t<=6000;t++){
  client.predict(t%100<50?1:-1);
  if(t%10===0)replies.push({at:t+25,s:server.accept(1,client.unacknowledged(),t*10)});
  while(replies[0]?.at<=t)client.reconcile(replies.shift()!.s);
  const outstanding=client.unacknowledged().filter(c=>c.sequence>server.snapshot().ack);
  assert.equal(client.state().x,outstanding.reduce((x,c)=>x+c.input,server.snapshot().state.x));
 }
});
test('duplicate batches cannot move twice and caller cannot mutate authority',()=>{
 const server=make();const batch=[{sequence:1,input:1}];
 const first=server.accept(1,batch,10);first.state.x=100;
 assert.equal(server.accept(1,batch,20).state.x,1);
 assert.equal(server.snapshot().ack,1);
});
test('gaps, wrong epochs and forged timing cannot move the actor',()=>{
 const server=make();
 assert.throws(()=>server.accept(1,[{sequence:2,input:1}],20),/Missing/);
 assert.throws(()=>server.accept(2,[{sequence:1,input:1}],20),/epoch/);
 assert.throws(()=>server.accept(1,[{sequence:1,input:1}],0),/budget/);
 assert.equal(server.snapshot().ack,0);
});
test('idle credit is capped and invalid suffix cannot partly commit',()=>{
 const server=make();
 assert.throws(()=>server.accept(1,Array.from({length:31},(_,i)=>({sequence:i+1,input:1})),100000),/budget/);
 assert.throws(()=>server.accept(1,[{sequence:1,input:1},{sequence:2,input:999}],100000),/direction/);
 assert.equal(server.snapshot().state.x,0);
 assert.equal(server.accept(1,[{sequence:1,input:1}],100000).ack,1);
 assert.throws(()=>server.accept(1,[],99999),/clock/);
});
