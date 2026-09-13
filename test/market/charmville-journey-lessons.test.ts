import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cropLessons} from '../../lib/charmville/journey-lessons';

test('generic crop lessons preserve old Oran achievements without inventing earlier lessons',()=>{
 assert.deepEqual(cropLessons(['home.oran.harvested']),{tilled:false,planted:false,watered:false,harvested:true});
 assert.deepEqual(cropLessons(['home.crop.planted','home.crop.watered']),{tilled:false,planted:true,watered:true,harvested:false});
 assert.deepEqual(cropLessons([]),{tilled:false,planted:false,watered:false,harvested:false});
 assert.deepEqual(cropLessons(['family.seed-gift','partner.chosen']),cropLessons([]));
});
