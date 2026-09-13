import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseSpeciesConstants, parseEvolutions } from './build-species-catalog.mjs';

test('species constants resolve only supported symbolic arithmetic without evaluation',()=>{
 const c=parseSpeciesConstants('#define SPECIES_NONE 0\n#define SPECIES_EGG 412\n#define NUM_SPECIES SPECIES_EGG\n#define SPECIES_UNOWN_B (NUM_SPECIES + 1)');
 assert.equal(c.get('SPECIES_UNOWN_B'),413);
 assert.throws(()=>parseSpeciesConstants('#define SPECIES_X process.exit()'),/Unsupported/);
});
test('evolution parser retains branching and symbolic requirements and fails closed',()=>{
 const c=new Map([['SPECIES_A',1],['SPECIES_B',2],['SPECIES_C',3]]);
 const e=parseEvolutions('{ [SPECIES_A] = {{EVO_LEVEL, 16, SPECIES_B}, {EVO_ITEM, ITEM_STONE, SPECIES_C}},\n};',c);
 assert.deepEqual(e.get('SPECIES_A').map(r=>r.parameter),[16,'ITEM_STONE']);
 assert.throws(()=>parseEvolutions('{ [SPECIES_A] = {unsupported},\n};',c),/Unparsed/);
});
test('committed catalogue distinguishes canonical species, forms, placeholders and build artifacts',async()=>{
 const c=JSON.parse(await readFile('public/charmville/catalog/species-catalog.json','utf8'));
 assert.equal(c.counts.species,386);assert.equal(c.counts.entries,440);assert.equal(c.counts.evolutionRules,184);
 assert.equal(new Set(c.species.map(s=>s.id)).size,c.species.length);
 for(const s of c.species.filter(s=>s.kind==='species')){
   assert(s.sourceName);for(const role of ['front','back','icon'])assert(s.sprites[role]);
   for(const e of s.evolutions)assert(c.species.some(t=>t.sourceSpeciesId===e.targetSpeciesId));
 }
 const byName=symbol=>c.species.find(s=>s.symbol===symbol);
 assert.equal(byName('SPECIES_TREECKO').sourceSpeciesId,277);
 assert.equal(byName('SPECIES_UNOWN_B').kind,'form');
 assert.equal(byName('SPECIES_EEVEE').evolutions.length,5);
 assert.equal(byName('SPECIES_CASTFORM').sprites.front.status,'generated-build-input');
 assert(byName('SPECIES_BULBASAUR').sprites.front.path.endsWith('/anim_front.png'));
 assert.equal(c.status,'reference-only');
});
