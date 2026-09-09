import {test} from "node:test";import assert from "node:assert/strict";
import {spawnActor,stepActor,beginAction,advanceAction,cancelAction} from "../../lib/charmville/native-action-domain";
const map={width:8,height:8,blocked:new Set(["2,1"])};const policy={stepMs:100,windupMs:400,range:1,actions:["harvest"]};
test("bounded movement jitter preserves average rate and cannot bank idle or spam steps",()=>{
 const g={width:8,height:8,blocked:new Set<string>()},p={...policy,jitterMs:20};let s=spawnActor(g,{x:1,y:1},0,1000);
 for(const now of [1095,1199,1294,1400,1496,1598])s=stepActor(s,{x:s.cell.x===1?2:1,y:1,sequence:s.sequence+1,regionEpoch:0},g,now,p).state;
 assert.equal(s.lastMoveAt,1600);
 for(let i=0;i<1000;i++)assert.throws(()=>stepActor(s,{x:2,y:1,sequence:s.sequence+1,regionEpoch:0},g,1598,p),/fast/);
 s=stepActor(s,{x:2,y:1,sequence:s.sequence+1,regionEpoch:0},g,100000,p).state;
 assert.throws(()=>stepActor(s,{x:1,y:1,sequence:s.sequence+1,regionEpoch:0},g,100000,p),/fast/);
 let d=spawnActor(g,{x:1,y:1},0,0);d=stepActor(d,{x:2,y:2,sequence:1,regionEpoch:0},g,122,p).state;
 assert.equal(d.lastMoveAt,142);assert.throws(()=>stepActor(d,{x:1,y:1,sequence:2,regionEpoch:0},g,240,p),/fast/);
 const next=stepActor(d,{x:1,y:1,sequence:2,regionEpoch:0},g,264,p).state;assert.equal(next.lastMoveAt,284);
});
test("server movement rejects teleport, speed, stale epoch/sequence and diagonal corner cuts",()=>{const start=spawnActor(map,{x:1,y:1},3,1000);const move={x:1,y:2,sequence:1,regionEpoch:3};assert.throws(()=>stepActor(start,move,map,1050,policy),/fast/);const moved=stepActor(start,move,map,1100,policy).state;assert.deepEqual(moved.cell,{x:1,y:2});assert.throws(()=>stepActor(moved,move,map,1200,policy),/Stale/);assert.throws(()=>stepActor(start,{...move,regionEpoch:2},map,1200,policy));assert.throws(()=>stepActor(start,{...move,x:7},map,1200,policy),/neighbor/);assert.throws(()=>stepActor(start,{...move,x:2,y:2},map,1200,policy),/corner/);assert.throws(()=>stepActor(start,{...move,elapsed:9999},map,1200,policy));});
test("windup contact emits once and movement or invalid resource cancels",()=>{const start=spawnActor(map,{x:1,y:1},3,1000);const intention={id:"action1",kind:"harvest",target:{x:1,y:2},regionEpoch:3};const active=beginAction(start,intention,1100,policy);assert.equal(advanceAction(active,1499,policy,true).contact,null);const hit=advanceAction(active,1500,policy,true);assert.equal(hit.contact?.actionId,"action1");assert.equal(advanceAction(hit.state,1600,policy,true).contact,null);assert.equal(advanceAction(active,1500,policy,false).contact,null);const moved=stepActor(active,{x:0,y:1,sequence:1,regionEpoch:3},map,1200,policy);assert.equal(moved.cancelledActionId,"action1");assert.equal(advanceAction(moved.state,1600,policy,true).contact,null);assert.equal(cancelAction(active,1200,policy).action,null);assert.throws(()=>beginAction(start,{...intention,target:{x:7,y:7}},1200,policy),/range/);assert.throws(()=>beginAction(start,{...intention,reward:999},1200,policy));assert.throws(()=>advanceAction(active,900,policy,true),/clock/);});
