import test from 'node:test';
import assert from 'node:assert/strict';
import {createBroadcastSessions,type BroadcastAuthority} from '../../lib/charmville/broadcast-session';
function fixture(){
 let now=0,serial=0,revision='0';let mode:BroadcastAuthority['mode']='public';
 const identities:Record<string,string>={publisher:'owner',viewer:'friend',stranger:'stranger'};
 const disconnected:string[]=[];
 const sessions=createBroadcastSessions({now:()=>now,id:()=>`publication-${++serial}`,leaseMs:1000,maxViewers:1,maxPublications:1,
  disconnect:(connection,id)=>disconnected.push(`${connection}:${id}`),
  resolve:async(connection,ownerId)=>{if(!identities[connection])throw Error('Unauthenticated');return {profileId:identities[connection],ownerId,revision,mode,allowedIds:['friend']};}});
 return {sessions,disconnected,identities,time:(value:number)=>now=value,policy:(value:BroadcastAuthority['mode'])=>{mode=value;revision=String(Number(revision)+1);}};
}
test('identity cannot self-grant publication or signal without subscription',async()=>{
 const f=fixture();await assert.rejects(f.sessions.start('viewer','owner'),/owner/);
 const p=await f.sessions.start('publisher','owner');
 await assert.rejects(f.sessions.authorizeSignal('stranger',p.id,'publisher'),/subscriber/);
 await f.sessions.subscribe('viewer',p.id);
 assert.deepEqual(await f.sessions.authorizeSignal('viewer',p.id,'publisher'),{from:'viewer',to:'publisher'});
 await assert.rejects(f.sessions.authorizeSignal('viewer',p.id,'stranger'),/subscriber/);
 assert.deepEqual(await f.sessions.authorizeSignal('publisher',p.id,'viewer'),{from:'publisher',to:'viewer'});
});
test('policy revision invalidates existing publication and all subscriptions',async()=>{
 const f=fixture(),p=await f.sessions.start('publisher','owner');await f.sessions.subscribe('viewer',p.id);
 f.policy('private');await assert.rejects(f.sessions.authorizeSignal('viewer',p.id,'publisher'),/policy changed/);
 assert.equal(f.disconnected.length,2);await assert.rejects(f.sessions.subscribe('viewer',p.id),/offline/);
 const next=await f.sessions.start('publisher','owner');await assert.rejects(f.sessions.subscribe('viewer',next.id),/restricted/);
});
test('active revoke, disconnect and expiry fail closed; renewal cannot resurrect',async()=>{
 const f=fixture(),p=await f.sessions.start('publisher','owner');await f.sessions.subscribe('viewer',p.id);
 f.sessions.revokeOwner('owner');assert.equal(f.disconnected.length,2);
 await assert.rejects(f.sessions.renew('publisher',p.id),/offline/);
 const next=await f.sessions.start('publisher','owner');f.time(1000);f.sessions.sweep();
 await assert.rejects(f.sessions.subscribe('viewer',next.id),/offline/);
});
test('bounded viewer capacity is released; changed connection identity cannot reuse subscription',async()=>{
 const f=fixture(),p=await f.sessions.start('publisher','owner');await f.sessions.subscribe('viewer',p.id);
 await assert.rejects(f.sessions.subscribe('stranger',p.id),/capacity/);
 f.identities.viewer='stranger';await assert.rejects(f.sessions.authorizeSignal('viewer',p.id,'publisher'),/subscriber/);
 f.sessions.close('viewer');await f.sessions.subscribe('stranger',p.id);
 f.sessions.close('publisher');await assert.rejects(f.sessions.authorizeSignal('stranger',p.id,'publisher'),/offline/);
});
