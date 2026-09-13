import { readdir, readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const references = path.resolve(process.argv[2] || '../charmville-references');
const output = path.join(root, 'public/charmville/library');
await mkdir(output, {recursive:true});
const extensions = new Set(['.png','.webp','.jpg','.jpeg','.svg','.glb','.gltf','.blend','.fbx','.obj','.ogg','.wav','.mp3','.tmx','.tsx','.vox']);
const skipped = new Set(['.git','node_modules','tooling','dream-loop','.next','vendor','venv','__pycache__']);
async function walk(dir) {
  const files=[];
  for(const item of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    if(skipped.has(item.name)||item.isSymbolicLink())continue;
    const file=path.join(dir,item.name);
    if(item.isDirectory())files.push(...await walk(file));
    else if(extensions.has(path.extname(item.name).toLowerCase()))files.push(file);
  }
  return files;
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sources=[];const assets=[];
for(const directory of (await readdir(references,{withFileTypes:true})).filter(x=>x.isDirectory()&&!skipped.has(x.name)).sort((a,b)=>a.name.localeCompare(b.name))) {
  const dir=path.join(references,directory.name);
  let revision=null;let upstream=null;
  try {await stat(path.join(dir,'.git'));revision=execFileSync('git',['-C',dir,'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();upstream=execFileSync('git',['-C',dir,'remote','get-url','origin'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();if(!/^https:\/\/(github.com|gitlab.com)\//.test(upstream))upstream=null;}catch{/* Archive source: do not inherit the enclosing repository's revision. */}
  const files=await walk(dir);const formats={};let bytes=0;
  const source={id:directory.name,revision,upstream,count:files.length,bytes:0,formats,status:'Reference indexed; per-file review required'};
  const kenney=directory.name.startsWith('kenney-');
  let license='Unreviewed';
  if(kenney){try{const notice=await readFile(path.join(dir,'source/License.txt'),'utf8');if(notice.includes('CC0')){license='CC0';source.status='CC0 source; previews available';await writeFile(path.join(output,`${directory.name}-LICENSE.txt`),notice);}}catch{}}
  let previews=0;
  for(const file of files){
    const ext=path.extname(file).toLowerCase();const relative=path.relative(dir,file).split(path.sep).join('/');
    const info=await stat(file);bytes+=info.size;formats[ext]=(formats[ext]||0)+1;
    const digest=hash(await readFile(file));
    const asset={id:`${source.id}:${relative}`,source:source.id,path:relative,format:ext,bytes:info.size,sha256:digest,license,status:license==='CC0'?'source-cleared':'review-required',preview:null};
    if(license==='CC0'&&ext==='.png'&&previews<32&&info.size<2000000){const name=digest+'.png';await copyFile(file,path.join(output,name));asset.preview='/charmville/library/'+name;previews++;}
    assets.push(asset);
  }
  source.bytes=bytes;sources.push(source);
  console.log(`${source.id}: ${files.length} assets`);
}
const memojiText=await readFile(path.join(references,'memoji-market/src/constants/index.ts'),'utf8');
const creator=memojiText.match(/FACTORY_DEPLOYER\s*=\s*"([^"]+)"/)[1];
const chain=memojiText.match(/CHAIN_ID\s*=\s*"([^"]+)"/)[1];
const charms=[...memojiText.matchAll(/\{\s*denom:[\s\S]*?\n\s*\}/g)].map(([block])=>{
 const field=name=>block.match(new RegExp(name+':\\s*"([^"]*)"'))?.[1]??'';
 const suffix=block.match(/FACTORY_DEPLOYER\}\/([^`]+)/)?.[1];
 if(!suffix)throw Error('Unrecognized denom');
 return {id:`${chain}:factory/${creator}/${suffix}`,chain,denom:`factory/${creator}/${suffix}`,name:field('name'),emoji:field('emoji'),poolId:field('poolId'),status:'testnet-reference',source:'https://github.com/nocktoshi/memoji-market'};
});
if(!charms.length||new Set(charms.map(x=>x.id)).size!==charms.length)throw Error('Empty or duplicate charm identities');
await writeFile(path.join(output,'catalog.json'),JSON.stringify({version:1,sources,assets}));
await writeFile(path.join(output,'charms.json'),JSON.stringify({version:1,scope:'Imported testnet source snapshot; not a complete live catalog or ownership record',charms},null,2));
await writeFile(path.join(output,'summary.json'),JSON.stringify({version:1,sources,assetCount:assets.length,charmCount:charms.length},null,2));
console.log(`Indexed ${assets.length} assets across ${sources.length} sources; ${charms.length} charm identities.`);
