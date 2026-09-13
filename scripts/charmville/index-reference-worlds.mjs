import {readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const refs=path.resolve(process.argv[2]||'../charmville-references');
const maps=[];
for(const entry of await readdir(path.join(refs,'pokeemerald/data/maps'),{withFileTypes:true})){
 if(!entry.isDirectory())continue;
 try{const raw=JSON.parse(await readFile(path.join(refs,'pokeemerald/data/maps',entry.name,'map.json'),'utf8'));maps.push({id:raw.id,name:raw.name,layout:raw.layout,connections:raw.connections||[],warps:raw.warp_events||[],objects:raw.object_events||[],coordinateEvents:raw.coord_events||[],backgroundEvents:raw.bg_events||[],source:`data/maps/${entry.name}/map.json`});}catch(e){if(e.code!=='ENOENT')throw e;}
}
maps.sort((a,b)=>a.id.localeCompare(b.id));
const ids=new Set(maps.map(m=>m.id));
const unresolved=[];
for(const map of maps)for(const warp of map.warps)if(warp.dest_map&&!ids.has(warp.dest_map))unresolved.push({map:map.id,destination:warp.dest_map});
const report={source:'https://github.com/pret/pokeemerald',revision:execFileSync('git',['-C',path.join(refs,'pokeemerald'),'rev-parse','HEAD'],{encoding:'utf8'}).trim(),status:'Source definitions indexed. Not executed, ported, or integrated into the MMO.',counts:{maps:maps.length,warps:maps.reduce((n,m)=>n+m.warps.length,0),objects:maps.reduce((n,m)=>n+m.objects.length,0)},unresolvedDestinations:unresolved,maps};
await mkdir('public/charmville/library',{recursive:true});
await writeFile('public/charmville/library/emerald-worlds.json',JSON.stringify(report));
console.log(JSON.stringify({counts:report.counts,unresolved:unresolved.length,revision:report.revision}));
