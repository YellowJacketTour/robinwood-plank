import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGameplayPeer} from './gameplay-peer.mjs';
class Peer{
 static instances=[];
 constructor(){this.transceivers=[];this.candidates=[];Peer.instances.push(this);}
 addTransceiver(track,options){this.transceivers.push({track,options});}
 async createOffer(){return {type:'offer',sdp:'offer'};}
 async createAnswer(){return {type:'answer',sdp:'answer'};}
 async setLocalDescription(d){this.localDescription=d;}
 async setRemoteDescription(d){this.remoteDescription=d;}
 async addIceCandidate(c){this.candidates.push(c);}
 close(){this.closed=true;}
}
test('publisher is send-only and closing viewer connection preserves shared source',async()=>{
 let stops=0;const track={kind:'video',readyState:'live',stop(){stops++;}},messages=[];
 const peer=createGameplayPeer({role:'publisher',stream:{getTracks:()=>[track]},send:m=>messages.push(m),Peer});
 const pc=Peer.instances.at(-1);await peer.start();assert.equal(pc.transceivers[0].options.direction,'sendonly');assert.equal(messages[0].description.type,'offer');
 await peer.receive({description:{type:'answer',sdp:'answer'}});peer.close();peer.close();assert.equal(stops,0);assert.equal(pc.closed,true);
});
test('viewer buffers candidates until offer and sends no media',async()=>{
 const messages=[];const peer=createGameplayPeer({role:'viewer',send:m=>messages.push(m),Peer});const pc=Peer.instances.at(-1);
 await peer.receive({candidate:{candidate:'first'}});assert.equal(pc.candidates.length,0);
 await peer.receive({description:{type:'offer',sdp:'offer'}});assert.equal(pc.candidates.length,1);assert.equal(messages[0].description.type,'answer');assert.equal(pc.transceivers.length,0);
 await assert.rejects(peer.receive({description:{type:'offer',sdp:'duplicate'}}));peer.close();
});
test('bounded signaling rejects overflow, wrong roles and closed work',async()=>{
 const peer=createGameplayPeer({role:'viewer',send:()=>{},Peer});
 for(let i=0;i<64;i++)await peer.receive({candidate:{candidate:String(i)}});
 await assert.rejects(peer.receive({candidate:{candidate:'overflow'}}));await assert.rejects(peer.start());peer.close();await assert.rejects(peer.receive({description:{type:'offer',sdp:'late'}}));
 assert.throws(()=>createGameplayPeer({role:'viewer',stream:{getTracks:()=>[]},send:()=>{},Peer}));
});
test('closing during offer creation cannot publish a late offer',async()=>{
 let release;class Slow extends Peer{createOffer(){return new Promise(r=>release=r);}}
 const messages=[];const peer=createGameplayPeer({role:'publisher',stream:{getTracks:()=>[{kind:'video',readyState:'live'}]},send:m=>messages.push(m),Peer:Slow});
 const started=peer.start();await Promise.resolve();peer.close();release({type:'offer',sdp:'late'});await started;assert.equal(messages.length,0);
});
