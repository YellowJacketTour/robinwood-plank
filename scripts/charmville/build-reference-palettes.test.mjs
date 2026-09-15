import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {applyPalette,chunks} from './build-reference-palettes.mjs';
const base='public/charmville/reference-items/pokeemerald/graphics/items/';
test('native palettes change colors while preserving indices, alpha and all other chunks',async()=>{
 const image=await readFile(base+'icons/status_heal.png');const original=Buffer.from(image);
 const burn=applyPalette(image,await readFile(base+'icon_palettes/burn_heal.pal'));
 const ice=applyPalette(image,await readFile(base+'icon_palettes/ice_heal.pal'));
 assert.deepEqual(image,original);assert.notDeepEqual(burn,ice);
 const sourceChunks=chunks(image),resultChunks=chunks(ice);
 assert.deepEqual(sourceChunks.map(p=>p.type),resultChunks.map(p=>p.type));
 for(let i=0;i<sourceChunks.length;i++)if(sourceChunks[i].type!=='PLTE')assert.deepEqual(sourceChunks[i].raw,resultChunks[i].raw);
 assert.notDeepEqual(sourceChunks.find(p=>p.type==='PLTE').data,resultChunks.find(p=>p.type==='PLTE').data);
 const corrupt=Buffer.from(image);corrupt[20]^=1;assert.throws(()=>applyPalette(corrupt,Buffer.alloc(0)),/CRC/);
 assert.throws(()=>applyPalette(image,Buffer.from('JASC-PAL\n0100\n1\n999 0 0')),/RGB/);
});
