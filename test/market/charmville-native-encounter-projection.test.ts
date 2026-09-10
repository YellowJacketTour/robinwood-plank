import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeEncounterProjection,nativeCaptureProjection} from '../../lib/charmville/native-encounter-projection';
test('native encounter projects only wild-target committed damage and newest event',()=>{
 const encounter={id:'wild',speciesId:286,cell:{x:4,y:9},hp:8,maxHp:14,revision:'2'};
 const result=nativeEncounterProjection({encounter,events:[{eventId:'12',log:[{targetId:'wild',damage:4}]},{eventId:'13',log:[{targetId:'partner',damage:9}]},{eventId:'11',log:[{targetId:'wild',damage:2}]}]});
 assert.deepEqual(result.damageEvent,{eventId:'12',damage:4});
 assert.equal(nativeEncounterProjection({encounter:{...encounter,hp:15}}).active,false);
 assert.equal(nativeEncounterProjection(null).active,false);
});

test('committed single strike carries only complete anchored source metadata',()=>{
 const encounter={id:'wild',speciesId:286,cell:{x:4,y:9},hp:8,maxHp:14,revision:'2'};
 const hit={targetId:'wild',damage:9,appliedDamage:3,actor:'11111111-1111-4111-8111-111111111111',actorSpeciesId:277,moveId:1,actorCell:{x:5,y:9}};
 const project=(log:unknown[])=>nativeEncounterProjection({encounter,events:[{eventId:'14',log}]}).damageEvent;
 assert.deepEqual(project([hit]),{eventId:'14',damage:3,actorId:hit.actor,actorSpeciesId:277,moveId:1,actorCell:{x:5,y:9}});
 assert.deepEqual(project([{...hit,actorCell:{x:-1,y:9}}]),{eventId:'14',damage:3});
 assert.deepEqual(project([hit,hit]),{eventId:'14',damage:6});
 assert.equal(project([{...hit,appliedDamage:0}]),undefined);
});

test('malformed projection input remains inert without throwing',()=>{
 const encounter={id:'wild',speciesId:286,cell:{x:4,y:9},hp:8,maxHp:14,revision:'2'};
 for(const events of [null,{},[null], [{eventId:'9',log:[null,{},'oops']}], [{eventId:'9'.repeat(10000),log:[]}]] ){
  assert.equal(nativeEncounterProjection({encounter,events}).damageEvent,undefined);
 }
});

test('multiple committed strikes are ordered and deduplicated for playback',()=>{
 const encounter={id:'wild',speciesId:286,cell:{x:4,y:9},hp:8,maxHp:14,revision:'2'};
 const event=(eventId:string)=>({eventId,log:[{targetId:'wild',damage:1}]});
 const result=nativeEncounterProjection({encounter,events:[event('11'),event('9'),event('10'),event('9')]});
 assert.deepEqual(result.damageEvents?.map(e=>e.eventId),['9','10','11']);
 assert.equal(result.damageEvent?.eventId,'11');
 assert.equal(nativeEncounterProjection({encounter,events:Array.from({length:20},(_,i)=>event(String(i+1)))}).damageEvents?.length,16);
});

test('captured creature leaves native world even while its preserved HP and old attacks remain',()=>{
 const encounter={id:'wild',speciesId:286,cell:{x:4,y:9},hp:8,maxHp:14,revision:'3',captured:true};
 assert.deepEqual(nativeEncounterProjection({encounter,events:[{eventId:'12',log:[{targetId:'wild',damage:4}]}]}),{type:'charmville:world-encounter',active:false});
 assert.equal(nativeEncounterProjection({encounter:{...encounter,captured:false}}).active,true);
});

test('capture presentation accepts only consistent recorded outcome and bounded anchors',()=>{
 const receipt={eventId:'11111111-1111-4111-8111-111111111111',actorCell:{x:3,y:9},targetCell:{x:4,y:9},captured:true,shakes:4};
 assert.equal(nativeCaptureProjection(receipt)?.type,'charmville:capture-event');
 for(const bad of [null,{}, {...receipt,captured:false},{...receipt,shakes:5},{...receipt,actorCell:{x:-1,y:9}},{...receipt,eventId:'guess'}])assert.equal(nativeCaptureProjection(bad),null);
 assert.equal(nativeCaptureProjection({...receipt,captured:false,shakes:2})?.shakes,2);
});