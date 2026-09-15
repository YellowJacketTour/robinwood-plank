import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createWorldSocket} from '../../lib/charmville/world-socket-client';

class FakeSocket {
 static OPEN=1;
 static instances:FakeSocket[]=[];
 readyState=0;
 onopen:(()=>void)|null=null;
 onmessage:((event:{data:string})=>void)|null=null;
 onclose:(()=>void)|null=null;
 onerror:(()=>void)|null=null;
 constructor(public url:string){FakeSocket.instances.push(this);}
 send(){}
 open(){this.readyState=1;this.onopen?.();}
 message(type:string){this.onmessage?.({data:JSON.stringify({type,state:{}})});}
 close(){this.readyState=3;this.onclose?.();}
}
function fixture(t:TestContext){
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'WebSocket');
 FakeSocket.instances=[];
 Object.defineProperty(globalThis,'WebSocket',{configurable:true,writable:true,value:FakeSocket});
 t.mock.timers.enable({apis:['setTimeout']});
 let losses=0,snapshots=0,encounterClears=0;
 const client=createWorldSocket('synthetic-test-token',()=>snapshots++,()=>losses++,state=>{if(state===null)encounterClears++;});
 t.after(()=>{client.dispose();t.mock.timers.reset();if(descriptor)Object.defineProperty(globalThis,'WebSocket',descriptor);else Reflect.deleteProperty(globalThis,'WebSocket');});
 return {client,latest:()=>FakeSocket.instances.at(-1)!,counts:()=>({losses,snapshots,encounterClears})};
}

test('never-ready probes leave HTTP fallback intact across repeated reconnects',t=>{
 const f=fixture(t);
 for(let n=0;n<4;n++){
  const socket=f.latest();socket.open();socket.message('unavailable');socket.close();
  assert.equal(f.client.available(),false);
  t.mock.timers.tick(2000);
 }
 assert.equal(FakeSocket.instances.length,5);
 assert.deepEqual(f.counts(),{losses:0,snapshots:0,encounterClears:0});
});

test('established connection invalidates once, then a recovered connection can invalidate again',t=>{
 const f=fixture(t),first=f.latest();first.open();first.message('ready');
 assert.equal(f.client.available(),true);
 first.message('unavailable');first.message('unavailable');first.close();
 assert.deepEqual(f.counts(),{losses:1,snapshots:1,encounterClears:1});
 t.mock.timers.tick(2000);
 const recovered=f.latest();recovered.open();recovered.message('snapshot');
 assert.equal(f.client.available(),true);
 first.message('unavailable');first.close(); // Obsolete transport callbacks are ignored.
 assert.equal(f.client.available(),true);
 recovered.close();recovered.close();
 assert.deepEqual(f.counts(),{losses:2,snapshots:2,encounterClears:2});
 t.mock.timers.tick(2000);
 assert.equal(FakeSocket.instances.length,3);
});

test('disposing a live socket neither invalidates nor reconnects or accepts late snapshots',t=>{
 const f=fixture(t),socket=f.latest();socket.open();socket.message('ready');
 f.client.dispose();socket.message('ready');socket.message('unavailable');socket.close();
 t.mock.timers.tick(10000);
 assert.equal(f.client.available(),false);
 assert.equal(FakeSocket.instances.length,1);
 assert.deepEqual(f.counts(),{losses:0,snapshots:1,encounterClears:0});
});

