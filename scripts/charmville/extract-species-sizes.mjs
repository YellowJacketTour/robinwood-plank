import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export function extractSizes(constants,entries){
 const ids=new Map([...constants.matchAll(/^#define SPECIES_(\w+)\s+(\d+)\s*$/gm)].map(m=>[m[1],Number(m[2])]));
 const species={};
 for(const match of entries.matchAll(/\[NATIONAL_DEX_(\w+)\]\s*=\s*\{([\s\S]*?)\}/g)){
  const name=match[1];if(name==='NONE')continue;
  const speciesId=ids.get(name),heightDm=Number(/\.height\s*=\s*(\d+)/.exec(match[2])?.[1]),weightHg=Number(/\.weight\s*=\s*(\d+)/.exec(match[2])?.[1]);
  if(!speciesId||!Number.isInteger(heightDm)||heightDm<=0||!Number.isInteger(weightHg)||weightHg<=0||species[speciesId])throw Error('Invalid or duplicate source entry '+name);
  species[speciesId]={name,heightDm,weightHg};
 }
 if(Object.keys(species).length!==386)throw Error('Expected 386 species');
 return species;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const root=process.argv[2];if(!root)throw Error('Pass pinned pokeemerald directory');
 const names=['include/constants/species.h','src/data/pokemon/pokedex_entries.h','include/pokedex.h'];
 const bytes=await Promise.all(names.map(n=>readFile(path.join(root,n))));
 const species=extractSizes(bytes[0].toString(),bytes[1].toString());
 const revision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const catalogue={source:'https://github.com/pret/pokeemerald',revision,units:{heightDm:'decimeters',weightHg:'hectograms'},files:Object.fromEntries(names.map((n,i)=>[n,createHash('sha256').update(bytes[i]).digest('hex')])),species};
 await writeFile('lib/charmville/species-sizes.json',JSON.stringify(catalogue,null,2)+'\n');
 console.log('Extracted 386 source sizes keyed by internal species ID.');
}
