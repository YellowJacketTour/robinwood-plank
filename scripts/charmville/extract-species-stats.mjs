import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import path from 'node:path';
const root=process.argv[2];if(!root)throw Error('Pass the pinned pokeemerald reference directory');
const names=['include/constants/species.h','src/data/pokemon/species_info.h','src/pokemon.c'];const contents=await Promise.all(names.map(n=>readFile(path.join(root,n),'utf8')));
const ids=Object.fromEntries([...contents[0].matchAll(/^#define SPECIES_(\w+)\s+(\d+)\s*$/gm)].map(m=>[m[1],Number(m[2])]));const species={};
for(const m of contents[1].matchAll(/\[SPECIES_(\w+)\]\s*=\s*\{\r?\n([\s\S]*?)\n    \},?/g)){
 const id=ids[m[1]],body=m[2],keys=['baseHP','baseAttack','baseDefense','baseSpeed','baseSpAttack','baseSpDefense','catchRate','expYield'];const values=Object.fromEntries(keys.map(k=>[k,Number(new RegExp('\\.'+k+'\\s*=\\s*(\\d+)').exec(body)?.[1])]));
 if(!id||!Number.isInteger(values.baseHP)||values.baseHP<1)continue;if(Object.values(values).some(v=>!Number.isInteger(v)))throw Error('Incomplete '+m[1]);
 const type=/\.types\s*=\s*\{\s*TYPE_(\w+),\s*TYPE_(\w+)/.exec(body);if(!type)throw Error('Missing types');species[id]={name:m[1],...values,types:[...new Set(type.slice(1))]};
}
if(Object.keys(species).length!==386)throw Error('Expected 386 ordinary species, got '+Object.keys(species).length);
const revision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
await writeFile('lib/charmville/species-stats.json',JSON.stringify({source:'https://github.com/pret/pokeemerald',revision,files:Object.fromEntries(names.map((n,i)=>[n,createHash('sha256').update(contents[i]).digest('hex')])),species},null,2)+'\n');console.log('Extracted 386 source species with stats and provenance.');
