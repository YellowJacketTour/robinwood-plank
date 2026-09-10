import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoundStory} from '../../public/arcade/round-story.js';
test('later settlements cannot replace a flight, delayed draw or open lottery',()=>{
 const story=createRoundStory();
 for(let id=70;id<10070;id++){
  assert.equal(story.reserve(id),true);assert.equal(story.phase,'loading');
  assert.equal(story.flight(id),true);assert.equal(story.phase,'flight');
  assert.equal(story.flight(id),false);assert.equal(story.lottery(id),false);assert.equal(story.close(id),false);
  assert.equal(story.flight(id+1),false);
  story.crash(id);assert.equal(story.phase,'crash');
  assert.equal(story.reserve(id+1),false);assert.equal(story.flight(id+1),false);
  story.lottery(id);assert.equal(story.phase,'lottery');
  assert.equal(story.flight(id),false);assert.equal(story.crash(id),false);
  assert.equal(story.flight(id+1),false);assert.equal(story.close(id-1),false);
  assert.equal(story.round,String(id));assert.equal(story.close(id),true);assert.equal(story.active,false);
 }
});
test('stale close notifications cannot release a newer round after reconnect',()=>{
 const story=createRoundStory();story.flight(70);story.reset();story.flight(72);
 assert.equal(story.close(70),false);assert.equal(story.crash(70),false);assert.equal(story.lottery(70),false);
 assert.equal(story.round,'72');assert.equal(story.phase,'flight');
});
test('an observed future launch cannot deadlock earlier queued settlements after a held lottery',()=>{
 const story=createRoundStory();
 story.reserve(72);
 assert.equal(story.acceptSettlement(70),true);assert.equal(story.round,'70');
 assert.equal(story.flight(70),true);assert.equal(story.acceptSettlement(72),false);
 story.crash(70);story.lottery(70);assert.equal(story.acceptSettlement(71),false);
 story.close(70);assert.equal(story.acceptSettlement(71),true);assert.equal(story.flight(71),true);
 story.crash(71);story.lottery(71);story.close(71);
 assert.equal(story.acceptSettlement(72),true);assert.equal(story.flight(72),true);
});
