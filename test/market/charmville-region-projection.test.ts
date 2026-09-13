import {test} from 'node:test';
import assert from 'node:assert/strict';
import {acceptsRegionProjection} from '../../lib/charmville/region-projection';
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
