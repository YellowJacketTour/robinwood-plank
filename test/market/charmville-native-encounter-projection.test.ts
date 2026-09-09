import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeEncounterProjection} from '../../lib/charmville/native-encounter-projection';
test('native encounter projects only wild-target committed damage and newest event',()=>{
 const encounter={id:'wild',speciesId:286,cell:{x:4,y:9},hp:8,maxHp:14,revision:'2'};
 const result=nativeEncounterProjection({encounter,events:[{eventId:'12',log:[{targetId:'wild',damage:4}]},{eventId:'13',log:[{targetId:'partner',damage:9}]},{eventId:'11',log:[{targetId:'wild',damage:2}]}]});
 assert.deepEqual(result.damageEvent,{eventId:'12',damage:4});
 assert.equal(nativeEncounterProjection({encounter:{...encounter,hp:15}}).active,false);
 assert.equal(nativeEncounterProjection(null).active,false);
});
