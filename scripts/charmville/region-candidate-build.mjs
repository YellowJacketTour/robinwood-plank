import {cp,copyFile,readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
if(process.argv.slice(2).some(arg=>!['--publish-candidate','--motion'].includes(arg)))throw Error('Only --publish-candidate and --motion are supported');
const motion=process.argv.includes('--motion');
if(motion&&process.argv.includes('--publish-candidate'))throw Error('Motion diagnostic cannot be published');
const refs=path.resolve(repo,'../charmville-references');
const original=path.join(refs,'zquest-native-212/runtime');
const template=path.join(refs,'charmville-native-homestead/template.qst');
const out=path.join(repo,motion?'work/region-candidate-motion':'work/region-candidate');
const runtime=path.join(out,'runtime');
const quest=path.join(out,'RegionCandidate.qst');
const source=path.join(repo,'scripts/charmville/region-candidate.zs');
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const protectedFiles=[template,path.join(refs,'charmville-native-homestead/Homestead.qst'),path.join(original,'include/CharmvilleHomestead.zh'),path.join(repo,'scripts/charmville/zquest/Homestead.zs')];
const before=await Promise.all(protectedFiles.map(hash));
await mkdir(out,{recursive:true});
// Full physical copy: editor/compiler/player may write configuration and logs.
await cp(original,runtime,{recursive:true});
await copyFile(template,quest);
await copyFile(source,path.join(runtime,'include/CharmvilleHomestead.zh'));
if(motion){
  await copyFile(path.join(repo,'scripts/charmville/region-candidate-motion.zh'),path.join(runtime,'include/RegionCandidateMotion.zh'));
  const authored=(await readFile(source,'utf8')).replace('#include "std.zh"','#include "std.zh"\n#include "RegionCandidateMotion.zh"').replace('        printf("REGION_CANDIDATE_DONE', '        RunRegionCandidateMotion();\n        printf("REGION_CANDIDATE_DONE');
  await writeFile(path.join(runtime,'include/CharmvilleHomestead.zh'),authored);
  await writeFile(path.join(out,'RegionCandidateMotion.zs'),authored);
}
async function run(exe,args,marker){
  let log='',timedOut=false;
  await writeFile(path.join(runtime,'allegro.log'),'');
  const child=spawn(path.join(runtime,exe),args,{cwd:runtime,windowsHide:true,stdio:'pipe'});
  const receive=data=>{log+=data;};
  child.stdout.on('data',receive);child.stderr.on('data',receive);
  const timer=setTimeout(()=>{timedOut=true;child.kill();},60000);
  const watcher=marker?setInterval(async()=>{try{const native=await readFile(path.join(runtime,'allegro.log'),'utf8');if(native.includes(marker)){log+='\n'+native;child.kill();}}catch{}},200):null;
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  clearTimeout(timer);if(watcher)clearInterval(watcher);
  await writeFile(path.join(out,exe+'.log'),log);
  if(timedOut || (code!==0 && !(marker&&log.includes(marker))))throw Error(`${exe} failed (${code}, timeout=${timedOut}): ${log.slice(-2200)}`);
  return log;
}
let result;
try{
  await run('zeditor.exe',['-smart-assign',quest]);
  const log=await run('zplayer.exe',['-headless','-test',quest,'4','63'],'REGION_CANDIDATE_DONE');
  const authored=log.match(/REGION_CANDIDATE_AUTHORED dmap=4 map=(\d+) offset=(-?\d+) topLeft=46 topRight=47 bottomLeft=62 bottomRight=63 id=(\d+)/);
  const loaded=log.match(/REGION_CANDIDATE_LOADED dmap=(\d+) map=(\d+) origin=(\d+) id=(\d+) width=(\d+) height=(\d+) screensX=(\d+) screensY=(\d+) heroX=(-?\d+) heroY=(-?\d+)/);
  if(!authored||!loaded)throw Error('Missing candidate runtime evidence');
  if(loaded[1]!=='4'||loaded[2]!==authored[1]||loaded[3]!=='46'||loaded[4]!==authored[3]||loaded[5]!=='512'||loaded[6]!=='352'||loaded[7]!=='2'||loaded[8]!=='2')throw Error('Native runtime did not load the expected 2x2 region');
  const rooms=log.match(/REGION_CANDIDATE_ROOM[^\r\n]*/g)||[];
  if(rooms.length!==4 || rooms.some(room=>!room.includes('valid=1')))throw Error('All four authored rooms must be valid');
  result={status:'native-region-loaded',rooms,authored:authored[0],loaded:loaded[0],quest,sourceSha256:await hash(source),questSha256:await hash(quest),limitations:['Minimal engine proof; full Homestead scripts deliberately excluded.','Canonical region edits happen each game start and do not persist across game load.','No live deployment, movement/collision crossing proof, camera inspection, or multiplayer proof.']};
  if(motion){
    result.motion=(log.match(/REGION_MOTION_(?:BEFORE|AFTER|BLOCKED)[^\r\n]*/g)||[]);
    const motionBefore=log.match(/REGION_MOTION_BEFORE x=(\d+) y=(\d+) heroScreen=(\d+) origin=(\d+) width=(\d+) height=(\d+) cameraX=(\d+)/);
    const motionAfter=log.match(/REGION_MOTION_AFTER x=(\d+) y=(\d+) heroScreen=(\d+) origin=(\d+) width=(\d+) height=(\d+) cameraX=(\d+)/);
    if(!motionBefore||!motionAfter||motionBefore[3]!=='62'||motionAfter[3]!=='63'||motionAfter[4]!=='46'||motionAfter[5]!=='512'||motionAfter[6]!=='352'||Number(motionAfter[1])<=Number(motionBefore[1])||Number(motionAfter[7])<=Number(motionBefore[7]))throw Error('Native input seam crossing and camera movement were not proven');
    const vertical=[...log.matchAll(/REGION_VERTICAL_(BEFORE|DOWN|UP) x=(\d+) y=(\d+) heroScreen=(\d+) origin=(\d+) cameraY=(\d+)/g)];
    if(vertical.length!==3 || !['46','47'].includes(vertical[0][4]) || Number(vertical[1][4])!==Number(vertical[0][4])+16 || vertical[2][4]!==vertical[0][4] || vertical.some(row=>row[5]!=='46') || Number(vertical[1][6])<=Number(vertical[0][6]) || Number(vertical[2][6])>=Number(vertical[1][6]))throw Error('Bidirectional native vertical seam crossing and camera movement were not proven');
    result.vertical=vertical.map(row=>row[0]);
    const repeated=log.match(/REGION_REPEAT_PASSED cycles=50 frames=3600 x=(\d+) y=(\d+) origin=46/);
    if(!repeated||log.includes('REGION_REPEAT_FAILED'))throw Error('Repeated vertical crossing continuity failed');
    result.repeated=repeated[0];
    result.status='native-input-seams-crossed';
    result.motionIncludeSha256=await hash(path.join(repo,'scripts/charmville/region-candidate-motion.zh'));
    result.executedSourceSha256=await hash(path.join(runtime,'include/CharmvilleHomestead.zh'));
    result.limitations[2]='Headless diagnostic only; no real-time browser movement, visual camera inspection, or multiplayer proof.';
  }
}catch(error){result={status:'blocked',error:String(error)};process.exitCode=1;}
const after=await Promise.all(protectedFiles.map(hash));
result.protectedFiles=protectedFiles.map((file,i)=>({file,before:before[i],after:after[i],unchanged:before[i]===after[i]}));
await writeFile(path.join(out,'evidence.json'),JSON.stringify(result,null,2));
if(result.protectedFiles.some(file=>!file.unchanged))throw Error('A protected input changed during the candidate run');
if(result.status==='native-region-loaded' && process.argv.includes('--publish-candidate')){
  const proof=JSON.parse(await readFile(path.join(repo,'work/region-candidate-motion/evidence.json'),'utf8'));
  if(proof.status!=='native-input-seams-crossed'||proof.sourceSha256!==await hash(source)||proof.motionIncludeSha256!==await hash(path.join(repo,'scripts/charmville/region-candidate-motion.zh')))throw Error('Publishing requires fresh native horizontal and bidirectional vertical motion proof');
  result.motionProof={file:'work/region-candidate-motion/evidence.json',motion:proof.motion,vertical:proof.vertical};
  result.limitations[2]='Bounded four-screen candidate only; native input crossing tested, browser visual inspection and multiplayer are not proven.';
  const destination=path.join(refs,'zquest-quest-snapshots/quests/charmville/region-candidate/r01/RegionCandidate.qst.gz');
  await mkdir(path.dirname(destination),{recursive:true});
  // Server serves decoded quest bytes under the upstream .gz filename convention.
  await copyFile(quest,destination);
  const bytes=await readFile(quest),id='quests/charmville/region-candidate';
  const metadata={id,index:900003,name:'Charmville isolated region candidate',authors:[{name:'Research adaptation of The Hero of Dreams by Shoelace'}],defaultPath:id+'/r01/RegionCandidate.qst',images:[],music:[],releases:[{name:'r01',resources:['RegionCandidate.qst'],hash:createHash('sha1').update(bytes).digest('hex'),resourceHashes:[createHash('md5').update(bytes).digest('hex')]}]};
  await writeFile(path.join(refs,'zquest-quest-snapshots/region-candidate-metadata.json'),JSON.stringify(metadata,null,2));
  result.published=destination;
  result.browserUrl='http://localhost:3021/play/?test=%2Fquests%2Fcharmville%2Fregion-candidate%2Fr01%2FRegionCandidate.qst&dmap=4&screen=63&storage=idb';
  await writeFile(path.join(out,'evidence.json'),JSON.stringify(result,null,2));
}
console.log(JSON.stringify(result,null,2));
