import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildReferenceAssetIndex} from './build-reference-asset-index.mjs';

test('deduplicates content while retaining item and palette presentation identities',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'charmville-art-index-'));
 try{
  await mkdir(path.join(root,'pokeemerald'),{recursive:true});
  const bytes=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.write('IHDR',12);bytes.writeUInt32BE(24,16);bytes.writeUInt32BE(24,20);bytes[24]=4;bytes[25]=3;
  const files=[['icon.png',bytes],['same.png',bytes],['a.pal',Buffer.from('palette A')],['b.pal',Buffer.from('palette B')]];
  const artifacts=[];
  for(const [file,data] of files){await writeFile(path.join(root,'pokeemerald',file),data);artifacts.push({source:'pokeemerald',path:file,sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length,url:`/charmville/reference-items/pokeemerald/${file}`});}
  const item=(id,file,palette)=>({id,source:'pokeemerald',sourceId:id,name:id,category:'POCKET_ITEMS',revision:'a'.repeat(40),art:{path:file},palette:{path:palette}});
  const catalog={revisions:{pokeemerald:'a'.repeat(40)},artifacts,items:[item('A','icon.png','a.pal'),item('B','same.png','b.pal'),item('C','same.png','a.pal')]};
  await writeFile(path.join(root,'catalog.json'),JSON.stringify(catalog));
  const result=await buildReferenceAssetIndex(root);
  assert.equal(result.counts.sourceItems,3);assert.equal(result.counts.uniqueContentAssets,3);assert.equal(result.counts.presentations,2);
  assert.notEqual(result.items[0].presentationId,result.items[1].presentationId);assert.equal(result.items[0].presentationId,result.items[2].presentationId);
  assert.ok(result.items.every(item=>item.charmIdentity===null&&!item.ownershipGranted));
  await writeFile(path.join(root,'pokeemerald','a.pal'),'changed');await assert.rejects(buildReferenceAssetIndex(root),/Artifact changed/);
 }finally{const resolved=await realpath(root);assert.equal(path.dirname(resolved),await realpath(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('charmville-art-index-'));await rm(resolved,{recursive:true,force:true});}
});

