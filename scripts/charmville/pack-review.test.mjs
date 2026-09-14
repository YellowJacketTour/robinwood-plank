import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildPackReview,frameAt,escapeMarkup} from './pack-review.mjs';
import {sha256} from './pack-validate.mjs';
test('timing honours exact frame boundaries and loops deterministically',()=>{
 const frames=[{durationMs:80},{durationMs:120}];
 assert.equal(frameAt(frames,79).index,0);assert.equal(frameAt(frames,80).index,1);
 assert.equal(frameAt(frames,200).index,0);assert.equal(frameAt(frames,-1).index,1);
});
test('review verifies bytes, embeds no remote art, escapes source strings, and does not certify gameplay',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'charmville-review-'));
 try{
  const png=await readFile('public/charmville/items/oran-berry.png');await writeFile(path.join(root,'item.png'),png);
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  const frame={asset:'test.art',region:{x:0,y:0,width,height},durationMs:100,origin:{x:0,y:0},grip:{x:0,y:0},collision:{x:0,y:0,width:1,height:1},flipX:false,flipY:false};
  const pack={schemaVersion:1,id:'test.review',version:'1.0.0',authors:['</script><script>bad()</script>'],dependencies:[],assets:[{id:'test.art',path:'item.png',sha256:sha256(png),width,height,provenance:{source:'local test',revision:'1',sourcePath:'item.png',attribution:'test only'},rights:{status:'unreviewed',license:'unknown',evidence:'unknown'}}],actions:[{id:'test.action',meaning:'Test only',itemDefinition:'test.item',authority:'server-contact',contactMs:50,recoveryMs:50,interruptPolicy:'cancel-before-contact',directions:Object.fromEntries(['up','down','left','right'].map(d=>[d,[frame]]))}]};
  const manifest=path.join(root,'pack.json');await writeFile(manifest,JSON.stringify(pack));
  const output=path.join(root,'review');const result=await buildPackReview(manifest,root,output);
  assert.equal(result.frames,4);assert.equal(result.visualAcceptance,false);assert.equal(result.gameplayAuthority,false);
  const html=await readFile(path.join(output,'review.html'),'utf8');
  assert.ok(html.includes('data:image/png;base64,'));assert.ok(!html.includes('</script><script>bad()'));
  assert.ok(html.includes('\\u003c/script>'));assert.ok(html.includes('server-contact'));
  await assert.rejects(buildPackReview(manifest,root,output),/EEXIST/);
  await writeFile(path.join(root,'item.png'),'tampered');await assert.rejects(buildPackReview(manifest,root,path.join(root,'bad')),/SHA-256 mismatch/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('metadata escapes XML markup',()=>assert.equal(escapeMarkup('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;'));
