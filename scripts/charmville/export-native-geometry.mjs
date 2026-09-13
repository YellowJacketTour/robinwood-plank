import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const runtime=path.resolve('../charmville-references/zquest-native-212/runtime');
const args=process.argv.slice(2);
for(const arg of args)if(!/^--(?:hero|work-only)$/.test(arg)&&!/^--(?:dmap|screen)=\d+$/.test(arg))throw Error('Unknown or invalid argument: '+arg);
function numberArg(name,fallback,max){const values=args.filter(arg=>arg.startsWith('--'+name+'='));if(values.length>1)throw Error('Duplicate --'+name);const value=values.length?Number(values[0].split('=')[1]):fallback;if(!Number.isSafeInteger(value)||value<0||value>max)throw Error('Invalid --'+name);return value;}
const dmap=numberArg('dmap',4,511),screen=numberArg('screen',63,127);
const heroOnly=args.includes('--hero'),workOnly=args.includes('--work-only'),farm=dmap===4&&screen===63;
const geometryId=`native-adventure-d${dmap}-s${screen}`;
const out=path.resolve(heroOnly?'work/native-hero':farm?'work/native-geometry':`work/native-geometry-d${dmap}-s${screen}`);await mkdir(out,{recursive:true});
const include=path.join(runtime,'include/CharmvilleHomestead.zh'),original=await readFile(include);
const template=path.resolve('../charmville-references/charmville-native-homestead/template.qst'),quest=path.join(out,'GeometryProbe.qst');
const probe=heroOnly?`#include "std.zh"
global script Active {void run(){for(int t=0;t<60;t++)Waitframe();for(int dir=0;dir<4;dir++){Hero->Dir=dir;Hero->Action=LA_NONE;Waitframe();Waitframe();printf("HERO_BANK %d %d %d\\n",dir,Hero->GetOriginalTile(0,dir),Hero->Flip);}printf("GEOMETRY_DONE\\n");while(true)Waitframe();}}
`:`#include "std.zh"
global script Active {
 void run(){
  for(int t=0;t<60;t++)Waitframe();
  if(${farm?'true':'false'})for(int layer=0;layer<=6;layer++){
   if(layer>0 && Screen->LayerMap[layer]<=0)continue;
   int ground=GetLayerComboD(layer,105);int cset=GetLayerComboC(layer,105);
   for(int row=4;row<=6;row++)for(int col=1;col<=6;col++){int cell=row*16+col;SetLayerComboD(layer,cell,ground);SetLayerComboC(layer,cell,cset);SetLayerComboF(layer,cell,0);}
  }
  printf("GEOMETRY_BEGIN %d %d\\n",Game->GetCurDMap(),Game->GetCurScreen());
  for(int layer=0;layer<=6;layer++){
   if(layer>0 && Screen->LayerMap[layer]<=0)continue;
   for(int cell=0;cell<176;cell++)printf("GEOMETRY_CELL %d %d %d %d %d\\n",layer,cell,GetLayerComboD(layer,cell),GetLayerComboS(layer,cell),GetLayerComboT(layer,cell));
  }
  printf("GEOMETRY_DONE\\n");while(true)Waitframe();
 }
}
`;
await writeFile(path.join(out,'GeometryProbe.zs'),probe);await copyFile(template,quest);
function run(exe,args,stopMarker){return new Promise((resolve,reject)=>{
 const child=spawn(path.join(runtime,exe),args,{cwd:runtime,windowsHide:true,stdio:'pipe'});let log='';
 const timer=setTimeout(()=>{child.kill();reject(Error('Timed out: '+log.slice(-1000)));},60000);
 const watcher=stopMarker?setInterval(async()=>{try{const fileLog=await readFile(path.join(runtime,'allegro.log'),'utf8');if(fileLog.includes(stopMarker)){log=fileLog;child.kill();}}catch{}},200):null;
 const receive=data=>{log+=data;if(stopMarker&&log.includes(stopMarker))child.kill();};
 child.stdout.on('data',receive);child.stderr.on('data',receive);child.on('error',reject);
 child.on('exit',code=>{clearTimeout(timer);clearInterval(watcher);if(code!==0&&!log.includes(stopMarker||'NEVER'))reject(Error(log.slice(-2000)));else resolve(log);});
});}
try{await writeFile(include,probe);await writeFile(path.join(out,'compile.log'),await run('zeditor.exe',['-smart-assign',quest]));}finally{await writeFile(include,original);}
await copyFile(path.join(runtime,'allegro.log'),path.join(out,'previous-allegro.log'));await writeFile(path.join(runtime,'allegro.log'),'');
const log=await run('zplayer.exe',['-headless','-test',quest,String(dmap),String(screen)],'GEOMETRY_DONE');await writeFile(path.join(out,'native.log'),log);
if(heroOnly){const banks=[...log.matchAll(/HERO_BANK (\d+) (\d+) (\d+)/g)].map(m=>({direction:+m[1],tile:+m[2],flip:+m[3]}));if(banks.length!==4)throw Error('Incomplete hero bank export');const digest=b=>createHash('sha256').update(b).digest('hex');const evidence={banks,templateSha256:digest(await readFile(template)),playerSha256:digest(await readFile(path.join(runtime,'zplayer.exe'))),probeSha256:digest(Buffer.from(probe)),method:'Pinned offline quest rendering, forced cardinal facing; no live client tile data.'};await writeFile(path.join(out,'hero.json'),JSON.stringify(evidence,null,2));if(!workOnly)await writeFile('public/charmville/catalog/native-hero-banks.json',JSON.stringify(evidence,null,2));console.log(banks);process.exit(0);}
const identity=log.match(/GEOMETRY_BEGIN (\d+) (\d+)/);if(!identity||+identity[1]!==dmap||+identity[2]!==screen)throw Error('Native probe started on an unexpected map/screen');
const rows=[...log.matchAll(/GEOMETRY_CELL (\d+) (\d+) (\d+) (\d+) (\d+)/g)].map(m=>({layer:+m[1],cell:+m[2],combo:+m[3],solidity:+m[4],type:+m[5]}));
if(rows.filter(r=>r.layer===0).length!==176)throw Error('Incomplete native map export');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const provenance={templateSha256:hash(await readFile(template)),probeSha256:hash(Buffer.from(probe)),playerSha256:hash(await readFile(path.join(runtime,'zplayer.exe'))),nativeSourceSha256:hash(await readFile('scripts/charmville/zquest/Homestead.zs'))};
const blocked=[];
for(let y=0;y<22;y++)for(let x=0;x<32;x++){
 const cell=Math.floor(y/2)*16+Math.floor(x/2),bit=1<<((x%2)*2+y%2);
 if(rows.some(r=>r.cell===cell&&(r.solidity&bit)!==0))blocked.push(`${x},${y}`);
}
const manifest={id:geometryId,revision:hash(Buffer.from(JSON.stringify({provenance,rows}))),width:32,height:22,tilePixels:8,blocked,spawn:farm?{x:2,y:9}:null,footprint:{width:2,height:2},native:{dmap,screen},policy:'Conservative union of authored solidity across every active layer; not full native movement semantics.',limitations:['Dynamic FFCs, doors, bridges, water skills, elevation and quest triggers are not simulated.','The16x16 actor footprint may reject paths native Link can traverse.','No cross-screen transition authorization is exported.'],provenance,rows};
if(farm)for(let y=9;y<11;y++)for(let x=2;x<4;x++)if(blocked.includes(`${x},${y}`))throw Error('Exported spawn footprint is blocked');
await writeFile(path.join(out,'geometry-raw.json'),JSON.stringify(manifest,null,2));
if(!workOnly){const target='lib/charmville/geometry';await mkdir(target,{recursive:true});await writeFile(target+'/'+geometryId+'.json',JSON.stringify(manifest,null,2)+'\n');}
console.log(`Exported ${rows.length} native layer cells into ${out}`);
