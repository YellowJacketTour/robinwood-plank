import test from 'node:test';
import assert from 'node:assert/strict';
import {moveStats} from '../../lib/charmville/move-stats';
test('source move definitions retain accuracy, PP and special effect distinctions',()=>{
 assert.equal(Array.from({length:354},(_,i)=>moveStats(i+1)).filter(Boolean).length,354);
 assert.equal(moveStats(33)?.name,'TACKLE');
 assert.equal(moveStats(33)?.power,35);
 assert.equal(moveStats(33)?.accuracy,95);
 assert.equal(moveStats(33)?.pp,35);
 assert.equal(moveStats(45)?.power,0);
 assert.notEqual(moveStats(45)?.effect,'EFFECT_HIT');
 assert.equal(moveStats(0),null);assert.equal(moveStats(355),null);assert.equal(moveStats(1.1),null);
});
