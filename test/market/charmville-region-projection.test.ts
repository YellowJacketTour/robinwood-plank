import {test} from 'node:test';
import assert from 'node:assert/strict';
import {acceptsRegionProjection,retainRegionMapDuringReconnect} from '../../lib/charmville/region-projection';
import type {SavedActor} from '../../lib/charmville/native-movement-client';
const actor:SavedActor={profileId:'p',regionId:'home:p',presenceRevision:'r',geometryId:'g',geometryRevision:'1',tilePixels:8,cell:{x:4,y:5},sequence:10,regionEpoch:2,version:20};
const accepts=(next:SavedActor)=>acceptsRegionProjection(actor,next,'p','home:p');
test('late movement responses cannot rewind the region projection',()=>{
 assert.equal(accepts({...actor,version:19}),false);
 assert.equal(accepts({...actor,sequence:9}),false);
 assert.equal(accepts({...actor,regionEpoch:1,version:99}),false);
 assert.equal(accepts({...actor,regionEpoch:3,sequence:0,version:0}),true);
 assert.equal(accepts({...actor}),true); // equal actor versions can carry new peer positions
});
test('travel and account boundaries reject unrelated and malformed projections',()=>{
 assert.equal(accepts({...actor,regionId:'public:meadow'}),false);
 assert.equal(accepts({...actor,profileId:'other'}),false);
 assert.equal(accepts({...actor,cell:{x:NaN,y:1}}),false);
 assert.equal(accepts({...actor,version:NaN}),false);
});


test('a reconnect retains same-admission scenery but removes live positions and peers',()=>{
 const previous={admission:'home:p:ticket',state:{...actor,peers:[{profileId:'friend'}],stale:false}};
 const stale=retainRegionMapDuringReconnect(previous,'p',previous.admission);
 assert.ok(stale);
 assert.deepEqual(stale.state.cell,actor.cell);
 assert.equal(stale.state.geometryId,actor.geometryId);
 assert.equal(stale.state.stale,true);
 assert.deepEqual(stale.state.peers,[]);
 assert.equal(previous.state.stale,false);
 assert.equal(previous.state.peers.length,1);
 assert.equal(acceptsRegionProjection(stale.state,actor,'p','home:p'),true);
 assert.equal(acceptsRegionProjection(stale.state,{...actor,version:19},'p','home:p'),false);
});

test('retained maps cannot cross account or admission boundaries or invent an initial map',()=>{
 const previous={admission:'home:p:ticket',state:actor};
 assert.equal(retainRegionMapDuringReconnect(previous,'other',previous.admission),null);
 assert.equal(retainRegionMapDuringReconnect(previous,'p','home:p:new-ticket'),null);
 assert.equal(retainRegionMapDuringReconnect(null,'p',previous.admission),null);
});
