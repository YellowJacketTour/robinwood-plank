import {cp,copyFile,readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileWorldTopology} from './world-topology.mjs';
import {compileWorldGeometry} from './compile-world-geometry.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const refs=path.resolve(repo,'../charmville-references');
const original=path.join(refs,'zquest-native-212/runtime');
const template=path.join(refs,'charmville-native-homestead/template.qst');
const out=path.join(repo,'work/whole-map-audit');
const runtime=path.join(out,'runtime');
const quest=path.join(out,'WholeMapAudit.qst');
const source=path.join(repo,'scripts/charmville/whole-map-audit.zs');
if(process.argv.length>2)throw Error('Read-only isolated audit accepts no arguments');
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
const protectedFiles=[template,path.join(refs,'charmville-native-homestead/Homestead.qst'),path.join(original,'include/CharmvilleHomestead.zh'),path.join(repo,'scripts/charmville/zquest/Homestead.zs')];
const before=await Promise.all(protectedFiles.map(hash));
await mkdir(out,{recursive:true});
await cp(original,runtime,{recursive:true});
await copyFile(template,quest);
await copyFile(source,path.join(runtime,'include/CharmvilleHomestead.zh'));
async function run(exe,args,marker){
 let log='',timedOut=false;
 await writeFile(path.join(runtime,'allegro.log'),'');
 const child=spawn(path.join(runtime,exe),args,{cwd:runtime,windowsHide:true,stdio:'pipe'});
 child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
 const timer=setTimeout(()=>{timedOut=true;child.kill();},60000);
 const watcher=marker?setInterval(async()=>{try{const native=await readFile(path.join(runtime,'allegro.log'),'utf8');if(native.includes(marker)){log+='\n'+native;child.kill();}}catch{}},200):null;
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 clearTimeout(timer);if(watcher)clearInterval(watcher);
 await writeFile(path.join(out,exe+'.log'),log);
 if(timedOut||(code!==0&&!(marker&&log.includes(marker))))throw Error(`${exe} failed (${code}, timeout=${timedOut}): ${log.slice(-2200)}`);
 return log;
}
let result;
try{
 await run('zeditor.exe',['-smart-assign',quest]);
 const log=await run('zplayer.exe',['-headless','-test',quest,'4','63'],'WHOLE_MAP_DONE');
 const parse=line=>Object.fromEntries([...line.matchAll(/(\w+)=(-?\d+)/g)].map(m=>[m[1],Number(m[2])]));
 const meta=parse(log.match(/WHOLE_MAP_META[^\r\n]*/)?.[0]||'');
 const rooms=[...new Map((log.match(/WHOLE_MAP_ROOM[^\r\n]*/g)||[]).map(l=>{const r=parse(l);return [r.screen,r];})).values()].sort((a,b)=>a.screen-b.screen);
 const warps=(log.match(/WHOLE_MAP_WARP[^\r\n]*/g)||[]).map(parse);
 const layers=(log.match(/WHOLE_MAP_LAYER[^\r\n]*/g)||[]).map(parse);
 const cells=(log.match(/WHOLE_MAP_CELL[^\r\n]*/g)||[]).map(parse);
 const terrain=rooms.map(room=>({screen:room.screen,x:room.screen%16*256,y:Math.floor(room.screen/16)*176,layers:layers.filter(l=>l.screen===room.screen).map(layer=>{
  const rows=cells.filter(c=>c.screen===room.screen&&c.layer===layer.layer);
  if(rows.length!==176||new Set(rows.map(c=>c.cell)).size!==176||rows.some(c=>c.cell<0||c.cell>=176))throw Error('Incomplete terrain layer '+room.screen+':'+layer.layer);
  return {...layer,cells:rows};
 })}));
 if(terrain.length!==128||terrain.some(r=>!r.layers.some(l=>l.layer===0)))throw Error('Incomplete base terrain');
 const terrainArtifact={map:meta.map,dmap:meta.dmap,templateSha256:before[0],sourceSha256:await hash(source),screens:terrain,limitations:['Raw authored combo solidity is not full native collision: dynamic objects, bridges, water abilities and scripted state require native evaluation.','Cells retain screen-major indices and source-layer references. No live world admission is changed.']};
 const terrainBytes=JSON.stringify(terrainArtifact,null,2);
 await writeFile(path.join(out,'terrain.json'),terrainBytes);
 if(meta.map!==10||rooms.length!==128||rooms.some((r,i)=>r.screen!==i))throw Error('Canonical map10 complete inventory not proven');
 for(const r of rooms){r.x=r.screen%16;r.y=Math.floor(r.screen/16);r.authored=(r.valid & 1)!==0&&r.nonzero>0;r.warps=warps.filter(w=>w.screen===r.screen).slice(0,4);}
 const topology=compileWorldTopology({meta,rooms});
 const topologyBytes=JSON.stringify(topology,null,2);
 await writeFile(path.join(out,'topology.json'),topologyBytes);
 const geometry=compileWorldGeometry(terrainArtifact,topology);
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 geometry.provenance.terrainSha256=digest(terrainBytes);
 geometry.provenance.topologySha256=digest(topologyBytes);
 const geometryBytes=JSON.stringify(geometry)+'\n';
 await writeFile(path.join(out,'geometry.json'),geometryBytes);
 const artifacts={terrain:{screens:terrain.length,layers:layers.length,cells:cells.length,sha256:digest(terrainBytes)},topology:{nodes:topology.nodes.length,sha256:digest(topologyBytes)},geometry:{chunks:Object.keys(geometry.chunks).length,blockedQuadrants:Object.values(geometry.chunks).reduce((sum,chunk)=>sum+chunk.blocked.length,0),sha256:digest(geometryBytes)}};
 if(artifacts.geometry.chunks!==rooms.filter(room=>room.authored).length)throw Error('Geometry authored-screen coverage mismatch');
 const rectangles=[];
 for(let top=0;top<=2;top++)for(let bottom=3;bottom<8;bottom++)for(let left=0;left<=14;left++){
  const screens=[];for(let y=top;y<=bottom;y++)for(let x=left;x<16;x++)screens.push(y*16+x);
  if(screens.every(s=>rooms[s].authored))rectangles.push({left,right:15,top,bottom,width:16-left,height:bottom-top+1,area:screens.length,screens});
 }
 rectangles.sort((a,b)=>b.area-a.area);
 const maximal=rectangles.filter(a=>!rectangles.some(b=>b.area>a.area&&b.left<=a.left&&b.top<=a.top&&b.bottom>=a.bottom));
 result={status:'native-canonical-inventory-complete',artifacts,meta,sourceSha256:await hash(source),templateSha256:before[0],questSha256:await hash(quest),authoredPredicate:'(Valid & 1) != 0 && nonzero ComboD count > 0',authoredCount:rooms.filter(r=>r.authored).length,rooms,maximalRectanglesContaining:[46,47,62,63],maximalRectangles:maximal,largestRectangle:rectangles[0]||null,grid: Array.from({length:8},(_,y)=>rooms.slice(y*16,y*16+16).map(r=>r.authored?'#':'.').join('')),limitations:['Authored/nonempty terrain is not proof of playable, connected, passable, or safe continuous-region geometry.','RoomType, warp, enemy and layer metadata are evidence only; dungeon/interior classification and crossing behavior require further inspection.','No canonical data mutation, region assignment, live/candidate deployment, browser, or multiplayer test.']};
}catch(e){result={status:'blocked',error:String(e)};process.exitCode=1;}
const after=await Promise.all(protectedFiles.map(hash));
result.protectedFiles=protectedFiles.map((file,i)=>({file,before:before[i],after:after[i],unchanged:before[i]===after[i]}));
await writeFile(path.join(out,'inventory.json'),JSON.stringify(result,null,2));
if(result.protectedFiles.some(r=>!r.unchanged))throw Error('Protected input changed');
console.log(JSON.stringify({...result,rooms:result.rooms?.length},null,2));


