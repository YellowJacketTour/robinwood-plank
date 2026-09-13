import {test} from 'node:test';
import assert from 'node:assert/strict';
import {subscribePlankLoveWalletState,type PlankLoveWalletState} from '../../integrations/plankspace-app/app/plank-love-wallet';

test('wallet change events outrank delayed initial snapshots and unsolicited replies',async()=>{
 const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),oldStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 const events=new EventTarget(),values=new Map<string,string>();let requestId='';
 const browser=Object.assign(events,{setTimeout,clearTimeout,location:{pathname:'/charmville/world',hostname:'localhost'}});
 Object.defineProperty(globalThis,'window',{configurable:true,value:browser});
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)}});
 events.addEventListener('plank:wallet-request',event=>{requestId=(event as CustomEvent).detail.requestId;});
 let stop=()=>{};
 try{
  const seen:PlankLoveWalletState[]=[];stop=subscribePlankLoveWalletState(state=>seen.push(state));assert(requestId);
  const connected={address:'0x'+'a'.repeat(40),chainId:null,status:'connected' as const,isConnected:true};
  const disconnected={address:null,chainId:null,status:'disconnected' as const,isConnected:false};
  events.dispatchEvent(new CustomEvent('plank:wallet-state',{detail:connected}));
  events.dispatchEvent(new CustomEvent('plank:wallet-response',{detail:{requestId,result:{state:disconnected}}}));
  await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(seen,[connected]);
  events.dispatchEvent(new CustomEvent('plank:wallet-response',{detail:{requestId:'other-request',result:{state:disconnected}}}));assert.deepEqual(seen,[connected]);
  events.dispatchEvent(new CustomEvent('plank:wallet-state',{detail:disconnected}));assert.deepEqual(seen,[connected,disconnected]);
 }finally{stop();for(const [key,descriptor]of [['window',oldWindow],['localStorage',oldStorage]] as const){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
