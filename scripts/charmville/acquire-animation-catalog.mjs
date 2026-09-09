import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {parseAnimationXml,readAnimationSheets} from './animation-source.mjs';
const root=path.resolve('../charmville-references/pmd-followers'),manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
const commit='db1928346e452e1a36b8ecff62f7e4d195504763';if(manifest.commit!==commit)throw Error('Unexpected source revision');
const base=`https://raw.githubusercontent.com/PMDCollab/SpriteCollab/${commit}/`,sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const species=[['0252','Treecko',277],['0255','Torchic',280],['0258','Mudkip',283]],files=new Map(manifest.files.map(file=>[file.path,file])),parsed=[];
for(const [id,name,speciesId] of species){const file=`sprite/${id}/AnimData.xml`,bytes=await readFile(path.join(root,file));if(sha(bytes)!==files.get(file)?.sha256)throw Error('Changed preserved AnimData');parsed.push({id,name,speciesId,...parseAnimationXml(bytes.toString('utf8'))});}
const tasks=parsed.flatMap(species=>species.animations.filter(anim=>!anim.copyOf).flatMap(anim=>['Anim','Offsets','Shadow'].map(kind=>`sprite/${species.id}/${anim.name}-${kind}.png`)));
let cursor=0;
await Promise.all(Array.from({length:4},async()=>{while(cursor<tasks.length){const file=tasks[cursor++];let bytes;
 if(files.has(file)){bytes=await readFile(path.join(root,file));if(sha(bytes)!==files.get(file).sha256)throw Error(`Changed ${file}`);}
 else{const response=await fetch(base+file,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error(`${file}: ${response.status}`);bytes=Buffer.from(await response.arrayBuffer());await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),bytes);files.set(file,{path:file,source:base+file,sha256:sha(bytes),bytes:bytes.length});}
 }}));
for(const species of parsed){const physical=new Map();for(const anim of species.animations.filter(anim=>!anim.copyOf)){
 const paths=Object.fromEntries([['anim','Anim'],['offsets','Offsets'],['shadow','Shadow']].map(([key,suffix])=>[key,`sprite/${species.id}/${anim.name}-${suffix}.png`]));
 const sheets={};for(const [key,file] of Object.entries(paths))sheets[key]=await readFile(path.join(root,file));physical.set(anim.name,{assets:Object.fromEntries(Object.entries(paths).map(([key,file])=>[key,files.get(file)])),...readAnimationSheets(anim,sheets)});
 }species.animations=species.animations.map(anim=>({...anim,...physical.get(anim.sourceAnimation),gameplay:{moveId:null,damage:null,effectAssets:[],status:'unbound-source-animation'}}));}
const catalog={schemaVersion:1,repository:manifest.repository,commit,formatSource:'https://wiki.pmdo.pmdcollab.org/PMD_Sprite_Format',notes:['Exact source images; aliases use the resolved physical animation files.','Rows are preserved source direction indices; runtime direction mapping must be explicit.','Attack, Shoot and SpAttack are animation labels, not named moves, projectiles, damage or capture mechanics.','Anchor coordinates are frame-local pixels; red/blue names preserve channels because tool documentation differs on handedness.','Head falls back to body when no black marker exists. Missing anchors remain null; do not invent them.'],species:parsed};
await writeFile(path.join(root,'animation-manifest.json'),JSON.stringify({...manifest,files:[...files.values()].sort((a,b)=>a.path.localeCompare(b.path))},null,2));
await writeFile(path.join(root,'animation-catalog.json'),JSON.stringify(catalog,null,2));
await cp(root,path.resolve('public/charmville/creatures/followers'),{recursive:true});
console.log(JSON.stringify({species:parsed.length,animations:parsed.reduce((n,s)=>n+s.animations.length,0),physicalAnimations:tasks.length/3,sourceFiles:files.size,catalog:path.join(root,'animation-catalog.json')}));
