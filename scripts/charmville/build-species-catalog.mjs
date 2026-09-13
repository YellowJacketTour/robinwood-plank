import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseSpeciesConstants(text) {
  const constants=new Map();
  for(const match of text.matchAll(/^#define\s+((?:SPECIES_[A-Z0-9_]+)|NUM_SPECIES)\s+([^\r\n]+)/gm)) {
    const expression=match[2].replace(/\/\/.*$/,'').trim().replace(/^\((.*)\)$/,'$1');
    const parts=expression.split(/\s*\+\s*/);
    const values=parts.map(p=>/^\d+$/.test(p)?Number(p):constants.get(p));
    if(values.some(v=>v===undefined))throw Error(`Unsupported species expression: ${match[0]}`);
    constants.set(match[1],values.reduce((a,b)=>a+b,0));
  }
  return constants;
}

export function parseEvolutions(text, constants) {
  const result=new Map();
  for(const entry of text.matchAll(/\[(SPECIES_[A-Z0-9_]+)\]\s*=\s*\{([\s\S]*?)\}\s*,(?=\s*\[|\s*\};)/g)) {
    const rules=[];
    for(const rule of entry[2].matchAll(/\{\s*(EVO_[A-Z0-9_]+)\s*,\s*([A-Z0-9_]+)\s*,\s*(SPECIES_[A-Z0-9_]+)\s*\}/g)) {
      if(!constants.has(rule[3]))throw Error(`Unknown evolution target ${rule[3]}`);
      rules.push({methodSymbol:rule[1],parameter:/^\d+$/.test(rule[2])?Number(rule[2]):rule[2],targetSymbol:rule[3],targetSpeciesId:constants.get(rule[3])});
    }
    if(!rules.length)throw Error(`Unparsed evolution entry ${entry[1]}`);
    result.set(entry[1],rules);
  }
  const expected=[...text.matchAll(/\[SPECIES_[A-Z0-9_]+\]\s*=/g)].length;
  if(result.size!==expected)throw Error(`Evolution parser coverage ${result.size}/${expected}`);
  return result;
}

export async function buildSpeciesCatalog(root) {
  const files=['include/constants/species.h','src/data/text/species_names.h','src/data/pokemon/evolution.h',
    'src/data/graphics/pokemon.h','src/anim_mon_front_pics.c','src/data/pokemon_graphics/front_pic_table.h',
    'src/data/pokemon_graphics/back_pic_table.h','src/pokemon_icon.c','src/graphics.c'];
  const texts=new Map(),sourceFiles=[];
  for(const file of files){const bytes=await readFile(path.join(root,file));texts.set(file,bytes.toString());sourceFiles.push({path:file,sha256:createHash('sha256').update(bytes).digest('hex')});}
  const constants=parseSpeciesConstants(texts.get(files[0]));
  const names=new Map([...texts.get(files[1]).matchAll(/\[(SPECIES_[A-Z0-9_]+)\]\s*=\s*_\("([^"\r\n]*)"\)/g)].map(m=>[m[1],m[2]]));
  const evolutions=parseEvolutions(texts.get(files[2]),constants);
  const graphics=new Map();
  for(const file of [files[3],files[4],files[8]])for(const m of texts.get(file).matchAll(/const\s+u(?:8|16|32)\s+(\w+)\[\]\s*=\s*INCGFX_U\d+\("([^"]+)"/g))graphics.set(m[1],{path:m[2],declarationSource:file});
  const front=new Map(),back=new Map(),icons=new Map();
  for(const [file,table] of [[files[5],front],[files[6],back]])for(const m of texts.get(file).matchAll(/SPECIES_SPRITE\(([A-Z0-9_]+),\s*(\w+)\)/g))table.set('SPECIES_'+m[1],m[2]);
  for(const m of texts.get(files[7]).matchAll(/\[(SPECIES_[A-Z0-9_]+)\]\s*=\s*(gMonIcon_\w+)/g))icons.set(m[1],m[2]);
  const cache=new Map();
  async function sprite(symbol){
    if(!symbol)return null;
    const ref=graphics.get(symbol);if(!ref)throw Error(`Unresolved sprite ${symbol}`);
    if(!ref.path.endsWith('.png'))return {symbol,...ref,status:'generated-build-input',sha256:null,width:null,height:null};
    if(!cache.has(ref.path)){
      const bytes=await readFile(path.join(root,ref.path));
      cache.set(ref.path,{...ref,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,
        width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)});
    }
    return {symbol,...cache.get(ref.path)};
  }
  const species=[];
  for(const [symbol,sourceSpeciesId] of constants){
    if(!symbol.startsWith('SPECIES_'))continue;
    const kind=symbol==='SPECIES_NONE'?'sentinel':symbol==='SPECIES_EGG'?'egg':symbol.startsWith('SPECIES_OLD_UNOWN_')?'legacy-placeholder':sourceSpeciesId>constants.get('SPECIES_EGG')?'form':'species';
    species.push({id:`pokeemerald:species:${sourceSpeciesId}`,sourceSpeciesId,symbol,kind,
      sourceName:names.get(symbol)??null,
      sprites:{front:await sprite(front.get(symbol)),back:await sprite(back.get(symbol)),icon:await sprite(icons.get(symbol))},
      evolutions:evolutions.get(symbol)??[]});
  }
  species.sort((a,b)=>a.sourceSpeciesId-b.sourceSpeciesId);
  return {schemaVersion:1,source:{repository:'https://github.com/pret/pokeemerald',commit:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),files:sourceFiles},
    status:'reference-only',limitations:['Source species IDs are not National Dex numbers.','Castform front/back declarations reference generated .4bpp inputs; they are explicitly marked and have no fabricated PNG path or hash.','Sprite paths reference the source repository; assets are not served by this catalogue.','Source evolution conditions are preserved as symbols, not implemented gameplay.','Null sourceName means no explicit species_names.h entry; form names are not fabricated.','No ownership, spawn rules, statistics, battle implementation or artwork reuse permission is implied.'],
    counts:{entries:species.length,species:species.filter(s=>s.kind==='species').length,evolutionRules:species.reduce((n,s)=>n+s.evolutions.length,0)},species};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const catalog=await buildSpeciesCatalog(path.resolve('../charmville-references/pokeemerald'));
  const target='public/charmville/catalog/species-catalog.json';await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,JSON.stringify(catalog,null,2)+'\n');console.log(catalog.counts);
}
