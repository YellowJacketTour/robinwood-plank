import {test} from "node:test";
import assert from "node:assert/strict";
import {facingForScreenVector,findGroundPath,walkable,moveAlongGround,plotApproach} from "../../lib/charmville/navigation";
import {STARTER_DECORATIONS} from "../../lib/charmville/layout";
test("atlas facing matches all eight screen directions, including the reversed boardwalk regression",()=>{
  [[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1],[1,0],[1,1]].forEach(([x,y],index)=>assert.equal(facingForScreenVector(x,y),index));
  assert.equal(facingForScreenVector(-40,20),1);assert.equal(facingForScreenVector(40,-20),5);
});
test("routes from boardwalk to every bed use gates and never walk through planted soil",()=>{
  for(let i=0;i<6;i++){
    const start={x:9,y:5},target=plotApproach(i,start,STARTER_DECORATIONS),path=findGroundPath(start,target,STARTER_DECORATIONS);
    assert.ok(path.length>0);assert.deepEqual(path.at(-1),target);
    for(const point of path)assert.equal(walkable(point,STARTER_DECORATIONS),true);
  }
});
test("manual movement stops at world boundaries and crop footprints",()=>{
  assert.deepEqual(moveAlongGround({x:9,y:9},0,1,.05,[]),{x:9,y:9});
  assert.deepEqual(moveAlongGround({x:1.68,y:3.5},1,1,.05,[]),{x:1.68,y:3.5});
  assert.equal(walkable({x:2.5,y:3.5},[]),false);
  assert.equal(walkable({x:8,y:4},[]),false);assert.equal(walkable({x:8,y:5},[]),true);
});
