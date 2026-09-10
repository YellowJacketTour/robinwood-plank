import test from 'node:test';
import assert from 'node:assert/strict';
import {adventureUrl,homesteadUrl} from './adventure-entry.mjs';
test('homestead arrival keeps starter equipment separate from explicit endgame tests',()=>{
  const starter=new URL(homesteadUrl(),'http://localhost:3021');
  assert.equal(starter.searchParams.get('test'),'/quests/charmville/homestead/r01/Homestead.qst');
  const data=starter.searchParams.get('testInitData');
  assert.match(data,/items\[5\]=1/);
  assert.match(data,/mcounter\[0\]=48/);
  assert(!data.includes('items[36]'));
  assert(!data.includes('999'));
  const laboratory=new URL(adventureUrl('endgame'),'http://localhost:3021');
  assert.match(laboratory.searchParams.get('testInitData'),/items\[36\]=1/);
});
