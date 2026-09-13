import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {extractSizes} from './extract-species-sizes.mjs';
const data=JSON.parse(await readFile(new URL('../../lib/charmville/species-sizes.json',import.meta.url),'utf8'));
test('complete source dimensions retain internal IDs rather than National Dex indices',()=>{
 assert.equal(Object.keys(data.species).length,386);assert.deepEqual(data.species[277],{name:'TREECKO',heightDm:5,weightHg:50});assert.equal(data.species[252],undefined);
 assert.deepEqual(data.species[25],{name:'PIKACHU',heightDm:4,weightHg:60});assert.equal(new Set(Object.values(data.species).map(s=>s.name)).size,386);
 for(const s of Object.values(data.species)){assert.ok(Number.isInteger(s.heightDm)&&s.heightDm>0);assert.ok(Number.isInteger(s.weightHg)&&s.weightHg>0);}
 assert.match(data.revision,/^[a-f0-9]{40}$/);assert.equal(Object.keys(data.files).length,3);
});
test('generator rejects incomplete or unmapped source rather than guessing ID',()=>{
 assert.throws(()=>extractSizes('#define SPECIES_TREECKO 277','[NATIONAL_DEX_TREECKO] = { .height = 5, .weight = 50 }'),/386/);
 assert.throws(()=>extractSizes('#define SPECIES_TREECKO 277','[NATIONAL_DEX_UNKNOWN] = { .height = 5, .weight = 50 }'),/Invalid/);
});
