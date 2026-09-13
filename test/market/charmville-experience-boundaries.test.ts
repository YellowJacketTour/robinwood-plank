import test from 'node:test';
import assert from 'node:assert/strict';
import {experienceAtLevel,experienceLevel} from '../../lib/charmville/experience';
test('all six source growth families retain terminal totals and exact level boundaries',()=>{
 for(const [species,total] of [[1,1059860],[10,1000000],[35,800000],[58,1250000],[301,600000],[306,1640000]]){
  assert.equal(experienceAtLevel(species,100),total);
  for(let level=2;level<=100;level++){
   const threshold=experienceAtLevel(species,level);
   assert.ok(threshold>experienceAtLevel(species,level-1));
   assert.equal(experienceLevel(species,threshold-1),level-1);
   assert.equal(experienceLevel(species,threshold),level);
  }
 }
});