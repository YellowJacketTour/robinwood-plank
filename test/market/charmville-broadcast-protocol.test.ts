import test from 'node:test';
import assert from 'node:assert/strict';
import {createBroadcastProtocol,readBroadcastSignal} from '../../lib/charmville/broadcast-protocol';
// @ts-expect-error Browser ESM module intentionally has no TypeScript declaration.
import {createGameplayPeer} from '../../scripts/charmville/gameplay-peer.mjs';
test('signal schema projects supported bounded fields and rejects arbitrary data',()=>{
 assert.deepEqual(readBroadcastSignal({type:'offer',sdp:'v=0\r\n'}),{description:{type:'offer',sdp:'v=0\r\n'}});
 for(const raw of [{type:'offer',sdp:'v=0',ownerId:'other'},{type:'offer',sdp:'v=0'+'x'.repeat(32768)},{type:'candidate',candidate:'bad',sdpMid:null,sdpMLineIndex:null},{type:'candidate',candidate:'',sdpMid:null,sdpMLineIndex:256}])assert.equal(readBroadcastSignal(raw),null);
 assert.ok(readBroadcastSignal({type:'candidate',candidate:'',sdpMid:null,sdpMLineIndex:null}));
});
test('server connection identity controls routing and rejects claimed sender',async()=>{
 const sent:Array<{to:string;message:any}>=[];
 const protocol=createBroadcastProtocol({id:()=> 'pub',now:()=>0,disconnect:()=>{},send:(to,message)=>sent.push({to,message}),resolve:async(connection,ownerId)=>({profileId:connection,ownerId,revision:'0',mode:'public',allowedIds:[]})});
 const owner=protocol.connect('owner'),viewer=protocol.connect('viewer');
 await owner.receive({type:'start',requestId:1,ownerId:'owner'});
 await viewer.receive({type:'subscribe',requestId:1,publicationId:'pub'});
 await viewer.receive({type:'signal',requestId:2,publicationId:'pub',target:'owner',signal:{type:'offer',sdp:'v=0'}});
 assert.ok(sent.some(s=>s.to==='owner'&&s.message.type==='broadcast:signal'&&s.message.from==='viewer'));
 const count=sent.filter(s=>s.message.type==='broadcast:signal').length;
 await viewer.receive({type:'signal',requestId:3,publicationId:'pub',target:'owner',from:'owner',signal:{type:'offer',sdp:'v=0'}});
 assert.equal(sent.filter(s=>s.message.type==='broadcast:signal').length,count);
});
test('concurrent commands are bounded and closing during authentication cleans late creation',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);const sent:any[]=[];const disconnected:string[]=[];
 const protocol=createBroadcastProtocol({id:()=> 'pub',now:()=>0,disconnect:c=>disconnected.push(c),send:(_c,m)=>sent.push(m),resolve:async(_c,ownerId)=>{await gate;return {profileId:'owner',ownerId,revision:'0',mode:'public',allowedIds:[]};}});
 const owner=protocol.connect('owner');const pending=owner.receive({type:'start',requestId:1,ownerId:'owner'});
 await owner.receive({type:'start',requestId:2,ownerId:'owner'});assert.equal(sent[0].code,'busy');
 owner.close();release();await pending;assert.ok(disconnected.includes('owner'));assert.equal(sent.length,1);
});

test('authenticated discovery completes actual gameplay-peer offer answer and ICE through protocol',async()=>{
 const messages:Array<{to:string;message:any}>=[];
 const protocol=createBroadcastProtocol({id:()=> 'pub',now:()=>0,disconnect:()=>{},send:(to,message)=>messages.push({to,message}),resolve:async(connection,ownerId)=>({profileId:connection,ownerId,revision:'0',mode:'public',allowedIds:[]})});
 const owner=protocol.connect('owner'),viewer=protocol.connect('viewer');
 await owner.receive({type:'start',requestId:1,ownerId:'owner'});
 await viewer.receive({type:'subscribe',requestId:1,publicationId:'pub'});
 const discovery=messages.find(m=>m.to==='owner'&&m.message.type==='broadcast:subscriber')!.message;
 const subscription=messages.find(m=>m.to==='viewer'&&m.message.type==='broadcast:result')!.message.result;
 assert.equal(discovery.viewerConnectionId,'viewer');assert.equal(subscription.publisherConnectionId,'owner');
 class Peer {
  static instances:Peer[]=[];localDescription:any;remoteDescription:any;onicecandidate:any;candidates:any[]=[];
  constructor(){Peer.instances.push(this);}addTransceiver(){}close(){}
  async createOffer(){return {type:'offer',sdp:'v=0\r\no=publisher'};}
  async createAnswer(){return {type:'answer',sdp:'v=0\r\no=viewer'};}
  async setLocalDescription(d:any){this.localDescription=d;}
  async setRemoteDescription(d:any){this.remoteDescription=d;}
  async addIceCandidate(c:any){this.candidates.push(c);}
 }
 const wire:Array<{sender:'owner'|'viewer';signal:any}>=[];
 const pub=createGameplayPeer({role:'publisher',Peer,stream:{getTracks:()=>[{kind:'video',readyState:'live'}]},send:(signal:any)=>wire.push({sender:'owner',signal})});
 const sub=createGameplayPeer({role:'viewer',Peer,send:(signal:any)=>wire.push({sender:'viewer',signal})});
 let requestId=2;
 async function deliver(){while(wire.length){const next=wire.shift()!;const start=messages.length;
  await (next.sender==='owner'?owner:viewer).receive({type:'signal',requestId:requestId++,publicationId:'pub',target:next.sender==='owner'?discovery.viewerConnectionId:subscription.publisherConnectionId,signal:next.signal});
  for(const event of messages.slice(start).filter(m=>m.message.type==='broadcast:signal'))await (event.to==='owner'?pub:sub).receive(event.message.signal);
 }}
 await pub.start();await deliver();
 assert.equal(Peer.instances[0].remoteDescription.type,'answer');assert.equal(Peer.instances[1].remoteDescription.type,'offer');
 Peer.instances[0].onicecandidate({candidate:{toJSON:()=>({candidate:'candidate:1 1 UDP 1 127.0.0.1 1234 typ host',sdpMid:'0',sdpMLineIndex:0,usernameFragment:'u'})}});
 await deliver();assert.equal(Peer.instances[1].candidates[0].usernameFragment,'u');pub.close();sub.close();
});
