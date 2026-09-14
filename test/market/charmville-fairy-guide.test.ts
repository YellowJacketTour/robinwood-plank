import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fairyGuidePage,FAMILY_OPENING} from '../../lib/charmville/fairy-guide';

test('guide waits for saved journey and does not mistake unavailable progress for a new account',()=>{
 assert.equal(fairyGuidePage(null,false).id,'loading');
 assert.equal(fairyGuidePage([],false).action,'setup');
});
test('gardening lessons precede partner selection and only receipts advance the guide',()=>{
 const done=['home.claimed'];
 assert.equal(fairyGuidePage(done,true).id,'soil');
 assert.equal(fairyGuidePage(done,false).action,'home');
 done.push('home.soil.tilled');assert.equal(fairyGuidePage(done,true).id,'seed');
 done.push('home.crop.planted');assert.equal(fairyGuidePage(done,true).id,'water');
 done.push('home.crop.watered');assert.equal(fairyGuidePage(done,true).id,'harvest');
 done.push('home.crop.harvested');assert.equal(fairyGuidePage(done,true).id,'partner');
 done.push('partner.chosen');assert.equal(fairyGuidePage(done,true).action,'public');
 assert.equal(fairyGuidePage(done,false).id,'together');
});
test('legacy Oran receipts retain progress and returning players are not sent into the intro again',()=>{
 const done=['home.claimed','partner.chosen','home.oran.harvested'];
 const before=[...done];
 assert.equal(fairyGuidePage(done,false).id,'together');
 assert.deepEqual(done,before);
 assert.ok(FAMILY_OPENING.every(beat=>beat.text.length<180));
});
