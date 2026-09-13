import test from 'node:test';
import assert from 'node:assert/strict';
import {createInputReconciliation} from '../../lib/charmville/input-reconciliation';
const setup=(maxPending=64)=>createInputReconciliation({initial:{epoch:1,ack:0,revision:0,state:{x:0}},maxPending,cloneState:s=>({...s}),cloneInput:(i:{dx:number})=>({...i}),step:(s,i)=>({x:s.x+i.dx})});
test('250ms delayed acknowledgments do not drag present prediction backwards over ten minutes',()=>{
 const client=setup();let serverX=0;
 const snapshots:{at:number;epoch:number;ack:number;revision:number;state:{x:number}}[]=[];
 for(let tick=0;tick<36000;tick++){
  const dx=tick%120<60?1:-1;
  const command=client.predict({dx});assert.ok(command);
  serverX+=dx;snapshots.push({at:tick+15,epoch:1,ack:command.sequence,revision:command.sequence,state:{x:serverX}});
  while(snapshots[0]?.at<=tick){const s=snapshots.shift()!;client.reconcile(s);}
  assert.equal(client.state().x,serverX);
  assert.ok(client.unacknowledged().length<=15);
 }
});
test('authoritative collision replays later inputs and ignores stale acknowledgments',()=>{
 const client=setup();client.predict({dx:1});client.predict({dx:1});client.predict({dx:-1});
 client.reconcile({epoch:1,ack:1,revision:1,state:{x:0}});
 assert.equal(client.state().x,0);
 assert.equal(client.reconcile({epoch:1,ack:0,revision:1,state:{x:900}}),'stale');
 assert.equal(client.state().x,0);
 assert.throws(()=>client.reconcile({epoch:1,ack:4,revision:2,state:{x:900}}));
});
test('out-of-order snapshots with the same ack cannot undo an authoritative impulse',()=>{
 const client=setup();client.predict({dx:1});
 client.reconcile({epoch:1,ack:0,revision:2,state:{x:10}});
 assert.equal(client.state().x,11);
 assert.equal(client.reconcile({epoch:1,ack:0,revision:1,state:{x:0}}),'stale');
 assert.equal(client.state().x,11);
});
test('full prediction buffer stops accepting without throwing away the path',()=>{
 const client=setup(2);client.predict({dx:1});client.predict({dx:1});
 assert.equal(client.predict({dx:1}),null);assert.equal(client.state().x,2);
 client.reconcile({epoch:1,ack:1,revision:1,state:{x:1}});
 assert.equal(client.predict({dx:-1})?.sequence,3);
 assert.equal(client.state().x,1);
});
test('only explicit newer-epoch reset discards pending input',()=>{
 const client=setup();client.predict({dx:1});
 assert.equal(client.reconcile({epoch:2,ack:0,revision:1,state:{x:40}}),'wrong-epoch');
 assert.equal(client.unacknowledged().length,1);
 client.reset({epoch:2,ack:0,revision:1,state:{x:40}});
 assert.equal(client.state().x,40);assert.equal(client.unacknowledged().length,0);
 assert.throws(()=>client.reset({epoch:1,ack:0,revision:1,state:{x:0}}));
});
test('caller mutation cannot corrupt replay history',()=>{
 const client=setup();const input={dx:1};const command=client.predict(input)!;
 input.dx=100;command.input.dx=100;client.unacknowledged()[0].input.dx=100;
 client.state().x=100;
 client.reconcile({epoch:1,ack:0,revision:1,state:{x:0}});
 assert.equal(client.state().x,1);
});
