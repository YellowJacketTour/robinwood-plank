// Preserve source IDs, behavior entry points and sprite metadata together.
// This catalog neither grants ownership nor implements imported item behavior.
import {readFile,readdir,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const refs=path.resolve('../charmville-references'),out=path.resolve('public/charmville/reference-items');
await mkdir(out,{recursive:true});
const revision=id=>execFileSync('git',['-C',path.join(refs,id),'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const revisions={pokeemerald:revision('pokeemerald'),'solarus-zsdx':revision('solarus-zsdx')};
const read=(source,file)=>readFile(path.join(refs,source,file),'utf8');
const artifacts=new Map();
async function artifact(source,file){
 const key=`${source}/${file}`;if(artifacts.has(key))return artifacts.get(key);
 const bytes=await readFile(path.join(refs,source,file));
 const sha256=createHash('sha256').update(bytes).digest('hex');
 const output=`${source}/${file}`;await mkdir(path.dirname(path.join(out,output)),{recursive:true});await copyFile(path.join(refs,source,file),path.join(out,output));
 const record={source,path:file,sha256,bytes:bytes.length,url:`/charmville/reference-items/${output}`};artifacts.set(key,record);return record;
}
const definitions=await read('pokeemerald','src/data/items.h');
const graphics=await read('pokeemerald','src/data/graphics/items.h');
const table=await read('pokeemerald','src/data/item_icon_table.h');
const iconPaths=new Map([...graphics.matchAll(/const u32 (gItemIcon_\w+)\[\] = INCGFX_U32\("([^"]+)"/g)].map(m=>[m[1],m[2]]));
const iconTable=new Map([...table.matchAll(/\[(ITEM_\w+)\]\s*=\s*\{(gItemIcon_\w+),\s*(gItemIconPalette_\w+)/g)].map(m=>[m[1],{sprite:m[2],palette:m[3]}]));
const palettePaths=new Map([...graphics.matchAll(/const u32 (gItemIconPalette_\w+)\[\] = INC(?:GFX|BIN)_U32\("([^"]+)"/g)].map(m=>[m[1],m[2]]));
const items=[];
for(const match of definitions.matchAll(/^\s*\[(ITEM_\w+)\]\s*=\s*\{([\s\S]*?)^    \},/gm)){
 const [,sourceId,body]=match;
 const fields=Object.fromEntries([...body.matchAll(/^\s*\.(\w+) = (.+),/gm)].map(m=>[m[1],m[2]]));
 const icon=iconTable.get(sourceId),file=iconPaths.get(icon?.sprite);
 const art=file?await artifact('pokeemerald',file):null;
 if(icon&&palettePaths.get(icon.palette))await artifact('pokeemerald',palettePaths.get(icon.palette));
 items.push({id:`pokeemerald:${sourceId}`,source:'pokeemerald',sourceId,name:fields.name?.match(/_\("(.*)"\)/)?.[1]||sourceId,category:fields.pocket||'unspecified',definition:'src/data/items.h',line:definitions.slice(0,match.index).split('\n').length,revision:revisions.pokeemerald,fields,art,palette:icon?{symbol:icon.palette,path:palettePaths.get(icon.palette)||null}:null,implementationStatus:'reference-only'});
}
const animationText=await read('solarus-zsdx','data/sprites/entities/items.dat');
for(const file of (await readdir(path.join(refs,'solarus-zsdx/data/items'))).filter(f=>f.endsWith('.lua')).sort()){
 const sourceId=file.slice(0,-4),script=await read('solarus-zsdx',`data/items/${file}`);
 const block=animationText.split(/(?=animation\{)/).find(b=>b.match(/name\s*=\s*"([^"]+)"/)?.[1]===sourceId);
 const directions=block?[...block.matchAll(/\{\s*x\s*=([^}]+)\}/g)].map(m=>Object.fromEntries([...('x ='+m[1]).matchAll(/(\w+)\s*=\s*(-?\d+)/g)].map(p=>[p[1],Number(p[2])]))):[];
 const imagePath=block?.match(/src_image\s*=\s*"([^"]+)"/)?.[1];
 const art=imagePath?await artifact('solarus-zsdx',`data/sprites/${imagePath}`):null;
 const behavior=await artifact('solarus-zsdx',`data/items/${file}`);
 items.push({id:`solarus-zsdx:${sourceId}`,source:'solarus-zsdx',sourceId,name:sourceId.replaceAll('_',' '),category:script.includes('on_using')?'usable item':'equipment / resource',definition:`data/items/${file}`,line:1,revision:revisions['solarus-zsdx'],fields:{callbacks:[...script.matchAll(/function item:(\w+)\(/g)].map(m=>m[1]).join(', '),assignable:script.includes('set_assignable(true)')?'true':'not declared'},art,directions,behavior,implementationStatus:'reference-only'});
}
await writeFile(path.join(out,'catalog.json'),JSON.stringify({schema:1,note:'Original item definitions and source artwork. Reference catalog only; not player inventory. Sprite previews retain source PNG palettes; runtime palette substitutions are separately identified.',revisions,items,artifacts:[...artifacts.values()]},null,2));
console.log(JSON.stringify({items:items.length,sources:Object.fromEntries(Object.keys(revisions).map(s=>[s,items.filter(i=>i.source===s).length])),artifacts:artifacts.size}));
