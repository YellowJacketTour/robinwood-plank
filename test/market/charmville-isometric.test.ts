import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { cropStage, projectCell, unprojectPoint } from "../../integrations/plankspace-app/app/charmville/isometric";

test("isometric projection preserves cell identity across the yard and negative coordinates",()=>{
  for(const [x,y] of [[0,0],[8,8],[2.5,3.5],[-3,7],[1.25,-2.5]]){
    const point=projectCell(x,y);assert.deepEqual(unprojectPoint(point.x,point.y),{x,y});
  }
});
test("crop art changes at server-time growth, ripe and compost boundaries",()=>{
  const ripe=Date.parse("2026-09-01T04:00:00Z");
  const plot={plotIndex:0,crop:"stalk",ripeAt:new Date(ripe).toISOString(),compostAfter:new Date(ripe+48*3600000).toISOString(),revision:"0"};
  assert.equal(cropStage({...plot,crop:null},ripe),"empty");
  assert.equal(cropStage(plot,ripe-4*3600000),"seedling");
  assert.equal(cropStage(plot,ripe-3600000),"growing");
  assert.equal(cropStage(plot,ripe),"ripe");
  assert.equal(cropStage(plot,ripe+48*3600000-1),"ripe");
  assert.equal(cropStage(plot,ripe+48*3600000),"compost");
});
test("rendered atlases have eight distinct frames, alpha and a stable ground anchor",async()=>{
  const root="public/images/charmville/original/";
  const manifest=JSON.parse(await readFile(root+"manifest.json","utf8"));
  assert.equal(manifest.frames,8);assert.equal(manifest.anchor[0],128);
  assert.ok(manifest.anchor[1]>0&&manifest.anchor[1]<192);
  for(const species of ["stalk","splinter"]){
    for(const stage of ["seedling","growing","ripe"]){
      const atlas=await sharp(root+`${species}-${stage}.png`).metadata();
      assert.equal(atlas.width,2048);assert.equal(atlas.height,192);assert.equal(atlas.hasAlpha,true);
      const frames=await Promise.all(Array.from({length:8},(_,i)=>readFile(root+`${species}/${stage}/${String(i).padStart(2,"0")}.png`)));
      assert.equal(new Set(frames.map(frame=>frame.toString("base64"))).size,8,"Animation must contain eight distinct renders");
    }
    assert.notDeepEqual(await readFile(root+`${species}/seedling/00.png`),await readFile(root+`${species}/ripe/00.png`));
  }
});
