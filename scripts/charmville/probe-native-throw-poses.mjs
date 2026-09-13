import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const runtime=path.resolve('../charmville-references/zquest-native-212/runtime');
const out=path.resolve('work/native-throw-poses');await mkdir(out,{recursive:true});
const include=path.join(runtime,'include/CharmvilleHomestead.zh'),original=await readFile(include);
const template=path.resolve('../charmville-references/charmville-native-homestead/template.qst'),quest=path.join(out,'GeometryProbe.qst');
const probe=`#include "std.zh"
global script Active {void run(){for(int t=0;t<60;t++)Waitframe();int poses[]={0,1,2,3,6,7,10,27,28};for(int p=0;p<9;p++)for(int dir=0;dir<4;dir++)printf("POSE %d %d %d\\n",poses[p],dir,Hero->GetOriginalTile(poses[p],dir));printf("GEOMETRY_DONE\\n");while(true)Waitframe();}}
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
const log=await run('zplayer.exe',['-headless','-test',quest,'4','63'],'GEOMETRY_DONE');await writeFile(path.join(out,'native.log'),log);
const poses=[...log.matchAll(/POSE (\d+) (\d+) (\d+)/g)].map(m=>({pose:+m[1],direction:+m[2],tile:+m[3]}));if(poses.length!==36)throw Error('Incomplete pose export');await writeFile(path.join(out,'poses.json'),JSON.stringify({poses,templateSha256:createHash('sha256').update(await readFile(template)).digest('hex'),source:'hero_tiles.h enum; no ls_throw member'},null,2));await copyFile(path.join(out,'poses.json'),'public/charmville/catalog/native-throw-pose-audit.json');console.log(poses);
