import {test} from 'node:test';
import assert from 'node:assert/strict';
import {atlasPoint} from '../../lib/charmville/native-atlas';
test('physical map positions share an atlas without conflating their local coordinates',()=>{
 assert.deepEqual(atlasPoint('native-adventure-d4-s62',{x:30,y:9}),{x:30,y:9});
 assert.deepEqual(atlasPoint('native-adventure-d4-s63',{x:0,y:9}),{x:32,y:9});
 assert.equal(atlasPoint('unknown',{x:0,y:0}),null);
 assert.equal(atlasPoint('native-adventure-d4-s63',{x:32,y:0}),null);
 assert.equal(atlasPoint('native-adventure-d4-s63',{x:NaN,y:0}),null);
});
