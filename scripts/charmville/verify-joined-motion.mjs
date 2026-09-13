import {cp,copyFile,readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Diagnostic only: no publishing option and no edits to the gameplay source.
if(process.argv.length>2)throw Error('This diagnostic takes no arguments');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const refs=path.resolve(repo,'../charmville-references');
const out=path.join(repo,'work/joined-motion'),runtime=path.join(out,'runtime');
const source=path.join(repo,'scripts/charmville/zquest/Homestead.zs');
const original=await readFile(source,'utf8');
const sha=text=>createHash('sha256').update(text).digest('hex');
await mkdir(out,{recursive:true});
await cp(path.join(repo,'work/joined-homestead/runtime'),runtime,{recursive:true});
const quest=path.join(out,'Homestead.qst');
await copyFile(path.join(refs,'charmville-native-homestead/template.qst'),quest);
const setup=`
        int diagnosticMap=Game->LoadDMapData(4)->Map;
        int diagnosticUsed[256];
        for(int room=0;room<128;room++){int id=Game->LoadMapData(diagnosticMap,room)->RegionID;if(id>0 && id<256)diagnosticUsed[id]=1;}
        int diagnosticId=1;while(diagnosticId<256 && diagnosticUsed[diagnosticId])diagnosticId++;
        if(diagnosticId>=256){printf("JOINED_MOTION_FAILED region_id\\n");return;}
        SetRegion(diagnosticMap,46,2,2,diagnosticId);Hero->Warp(4,63);Waitframe();
        int diagnosticFrame=-1;int diagnosticPhase=0;int diagnosticX=0;int diagnosticY=0;
        int diagnosticScreen=0;int diagnosticCrossings=0;int diagnosticLastX=0;int diagnosticLastY=0;
`;
const frame=`
            if(ticks>=60){
            // This runs at the bottom of the actual full gameplay loop, after
            // farming, peers, followers and encounter updates on every frame.
            Hero->InputLeft=false;Hero->InputRight=false;Hero->InputUp=false;Hero->InputDown=false;
            if(diagnosticFrame<0){
                for(int member=0;member<6;member++){
                    int fx=followerX[member];int fy=followerY[member];
                    bool clear=followerVisible[member];
                    for(int bed=0;bed<3;bed++)if(fx-8<plotXs[bed]+16 && fx+24>plotXs[bed] && fy-24<plotY+16 && fy+24>plotY)clear=false;
                    printf("JOINED_MOTION_FORMATION member=%d x=%d y=%d clear=%d\\n",member,fx,fy,clear?1:0);
                    if(!clear){printf("JOINED_MOTION_FAILED initial_formation\\n");return;}
                }
                int seamY=-1;
                for(int y=184;y<=320 && seamY<0;y+=8){bool clear=true;
                    for(int x=232;x<=328;x+=4)if(!followerSpace(x,y))clear=false;
                    if(clear)seamY=y;
                }
                if(seamY<0){printf("JOINED_MOTION_FAILED horizontal_corridor\\n");return;}
                Hero->X=240;Hero->Y=seamY;Hero->Action=LA_NONE;
                diagnosticX=Hero->X;diagnosticY=Hero->Y;diagnosticScreen=62;diagnosticFrame=0;
                diagnosticLastX=Hero->X;diagnosticLastY=Hero->Y;
                printf("JOINED_MOTION_START phase=0 x=%d y=%d origin=%d\\n",Hero->X,Hero->Y,Game->GetCurScreen());
            }else{
                if(Game->GetCurScreen()!=46 || Abs(Hero->X-diagnosticLastX)>4 || Abs(Hero->Y-diagnosticLastY)>4){printf("JOINED_MOTION_FAILED discontinuity frame=%d phase=%d x=%d y=%d\\n",diagnosticFrame,diagnosticPhase,Hero->X,Hero->Y);return;}
                diagnosticLastX=Hero->X;diagnosticLastY=Hero->Y;
                int phaseFrame=diagnosticFrame%72;
                if(phaseFrame==36 || (phaseFrame==0 && diagnosticFrame>0)){
                    int expected=phaseFrame==36?diagnosticScreen+(diagnosticPhase==0?1:16):diagnosticScreen;
                    if(Game->HeroScreen!=expected || (phaseFrame==0 && (Hero->X!=diagnosticX || Hero->Y!=diagnosticY))){printf("JOINED_MOTION_FAILED crossing phase=%d frame=%d x=%d y=%d screen=%d expected=%d\\n",diagnosticPhase,diagnosticFrame,Hero->X,Hero->Y,Game->HeroScreen,expected);return;}
                    diagnosticCrossings++;
                    int visible=0;for(int member=0;member<6;member++)if(followerVisible[member])visible++;
                    printf("JOINED_MOTION_CROSS phase=%d frame=%d x=%d y=%d screen=%d cameraX=%d cameraY=%d trail=%d followers=%d\\n",diagnosticPhase,diagnosticFrame,Hero->X,Hero->Y,Game->HeroScreen,Viewport->X,Viewport->Y,trailCount,visible);
                }
                if(diagnosticFrame==720){
                    if(diagnosticPhase==1){printf("JOINED_MOTION_PASSED crossings=%d frames=1440\\n",diagnosticCrossings);return;}
                    int seamX=-1;
                    for(int x=8;x<=488 && seamX<0;x+=8){bool clear=true;
                        for(int y=136;y<=232;y+=4)if(!followerSpace(x,y))clear=false;
                        if(clear)seamX=x;
                    }
                    if(seamX<0){printf("JOINED_MOTION_FAILED vertical_corridor\\n");return;}
                    Hero->X=seamX;Hero->Y=144;Hero->Action=LA_NONE;
                    diagnosticPhase=1;diagnosticFrame=0;diagnosticX=Hero->X;diagnosticY=Hero->Y;
                    diagnosticScreen=seamX<256?46:47;diagnosticLastX=Hero->X;diagnosticLastY=Hero->Y;
                    printf("JOINED_MOTION_START phase=1 x=%d y=%d origin=%d\\n",Hero->X,Hero->Y,Game->GetCurScreen());
                }
            }
            if(diagnosticPhase==0){Hero->InputRight=diagnosticFrame%72<36;Hero->InputLeft=diagnosticFrame%72>=36;}
            else{Hero->InputDown=diagnosticFrame%72<36;Hero->InputUp=diagnosticFrame%72>=36;}
            diagnosticFrame++;
            }
`;
let generated=original.replaceAll('\r\n','\n');
const entry='void run()\n    {',footer='            if(encounterFlash>0)encounterFlash--;\n            Waitframe();';
if(!generated.includes(entry)||!generated.includes(footer)||!generated.includes('if(welcome<2 && farmHere)'))throw Error('Full gameplay injection anchors changed');
generated=generated.replace(entry,entry+setup).replace('if(welcome<2 && farmHere)','welcome=2; // Diagnostic skips only the tutorial gate.\n                if(welcome<2 && farmHere)').replace(footer,footer.replace('            Waitframe();',frame+'            Waitframe();'));
await writeFile(path.join(out,'DiagnosticHomestead.zs'),generated);
await writeFile(path.join(runtime,'include/CharmvilleHomestead.zh'),generated);
const files=path.join(runtime,'Files/Homestead/charmville');
await writeFile(path.join(files,'party-followers.txt'),'277|280|283|25|133|286|18');
async function run(exe,args,watch=false){
 let log='';await writeFile(path.join(runtime,'allegro.log'),'');
 const child=spawn(path.join(runtime,exe),args,{cwd:runtime,windowsHide:true,stdio:'pipe'});
 child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
 let timeout=false;const timer=setTimeout(()=>{timeout=true;child.kill();},60000);
 const watcher=watch?setInterval(async()=>{try{const native=await readFile(path.join(runtime,'allegro.log'),'utf8');if(/JOINED_MOTION_(FAILED|PASSED)/.test(native)){log+='\n'+native;child.kill();}}catch{}},100):null;
 const exit=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});
 clearTimeout(timer);if(watcher)clearInterval(watcher);
 const native=await readFile(path.join(runtime,'allegro.log'),'utf8');if(!log.includes('JOINED_MOTION_'))log+='\n'+native;
 await writeFile(path.join(out,exe+'.log'),log);
 if(timeout||(!watch&&exit!==0))throw Error(`${exe} failed: ${log.slice(-1800)}`);
 return log;
}
let result;
try{
 await run('zeditor.exe',['-smart-assign',quest]);
 const log=await run('zplayer.exe',['-headless','-test',quest,'4','63'],true);
 const traces=[...new Set(log.match(/JOINED_MOTION_[^\r\n]*/g)||[])];
 const crossings=traces.filter(s=>s.startsWith('JOINED_MOTION_CROSS')).map(s=>Object.fromEntries([...s.matchAll(/(\w+)=(-?\d+)/g)].map(m=>[m[1],Number(m[2])])));
 const presentationContinuous=crossings.length===40&&crossings.every((c,i)=>c.followers===6&&(i===0||c.phase!==crossings[i-1].phase||c.trail>=crossings[i-1].trail));
 const cameraMoved=[0,1].every(phase=>{const samples=crossings.filter(c=>c.phase===phase);return samples.length===20&&samples[0][phase===0?'cameraX':'cameraY']>samples[1][phase===0?'cameraX':'cameraY'];});
 const passed=traces.includes('JOINED_MOTION_PASSED crossings=40 frames=1440')&&!traces.some(s=>s.includes('_FAILED'))&&presentationContinuous&&cameraMoved;
 result={status:passed?'passed':'failed',presentationContinuous,cameraMoved,traces};if(!passed)process.exitCode=1;
}catch(error){result={status:'failed',error:String(error)};process.exitCode=1;}
result.sourceSha256=sha(original);result.generatedSha256=sha(generated);
result.sourceUnchanged=sha(await readFile(source,'utf8'))===sha(original);
result.limitations=['Headless native full-loop diagnostic, not browser visual evidence.','Two diagnostic setup placements precede measured directional input; no position writes occur within either 720-frame series.','Single-player guest mode; no account admission, receipt, or multiplayer proof.'];
await writeFile(path.join(out,'evidence.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
