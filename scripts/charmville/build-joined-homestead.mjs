import {cp,copyFile,readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const repo=process.cwd(),refs=path.resolve('../charmville-references');
const out=path.join(repo,'work/joined-homestead'),runtime=path.join(out,'runtime');
await mkdir(out,{recursive:true});
await cp(path.join(refs,'zquest-native-212/runtime'),runtime,{recursive:true});
const quest=path.join(out,'Homestead.qst');
await copyFile(path.join(refs,'charmville-native-homestead/template.qst'),quest);
for(const name of ['ActionPalettes','ExtraFollowerFrames','FollowerScale','CommittedAttackFrames','CaptureBall','FaintFrames'])await copyFile(`scripts/charmville/zquest/${name}.zh`,path.join(runtime,`include/${name}.zh`));
const setup=`
        int joinedMap=Game->LoadDMapData(4)->Map;
        int joinedScreen=Game->HeroScreen;
        int occupied[256];
        for(int room=0;room<128;room++){int id=Game->LoadMapData(joinedMap,room)->RegionID;if(id>0 && id<256)occupied[id]=1;}
        int joinedId=1;while(joinedId<256 && occupied[joinedId])joinedId++;
        if(joinedId>=256){printf("JOINED_HOMESTEAD_FAILED no_region_id\\n");return;}
        SetRegion(joinedMap,46,2,2,joinedId);
        Hero->Warp(4,joinedScreen);
        Waitframe();
        printf("JOINED_HOMESTEAD_READY origin=%d width=%d height=%d\\n",Game->GetCurScreen(),Region->Width,Region->Height);
`;
const original=await readFile('scripts/charmville/zquest/Homestead.zs','utf8');
const needle='void run()\n    {';
const normalized=original.replaceAll('\r\n','\n');
if(!normalized.includes(needle))throw Error('Missing run entry');
await writeFile(path.join(runtime,'include/CharmvilleHomestead.zh'),normalized.replace(needle,needle+setup));
// Native file sandbox resolves assets below the quest basename.
await mkdir(path.join(runtime,'Files/Homestead/charmville'),{recursive:true});
await cp(path.join(refs,'charmville-native-homestead/action-sprites'),path.join(runtime,'Files/Homestead/charmville'),{recursive:true});
async function run(exe,args,marker){
 let log='';await writeFile(path.join(runtime,'allegro.log'),'');
 const child=spawn(path.join(runtime,exe),args,{cwd:runtime,windowsHide:true,stdio:'pipe'});
 child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
 let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;child.kill();},60000);
 const watch=marker?setInterval(async()=>{try{const s=await readFile(path.join(runtime,'allegro.log'),'utf8');if(s.includes(marker)){log+='\n'+s;child.kill();}}catch{}},100):null;
 const exit=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});clearTimeout(timeout);if(watch)clearInterval(watch);
 await writeFile(path.join(out,exe+'.log'),log);
 if(timedOut || (exit!==0 && !log.includes(marker)))throw Error(`${exe}: ${log.slice(-1800)}`);
 return log;
}
await run('zeditor.exe',['-smart-assign',quest]);
const log=await run('zplayer.exe',['-headless','-test',quest,'4','63'],'CHARMVILLE_PRESENTATION_READY');
if(!log.includes('JOINED_HOMESTEAD_READY origin=46 width=512 height=352')||!log.includes('CHARMVILLE_FARM_CLEARING')||!log.includes('CHARMVILLE_PRESENTATION_READY'))throw Error('Joined gameplay startup not proven');
const bytes=await readFile(quest),id='quests/charmville/homestead-region';
await writeFile(path.join(out,'evidence.json'),JSON.stringify({compiled:true,regionLoaded:true,farmPrepared:true,sourceSha256:createHash('sha256').update(original).digest('hex'),limitations:['Headless startup only; browser play acceptance still required.','Standalone local progression; shared account admission not enabled.']},null,2));
if(process.argv.includes('--publish')){
 const dest=path.join(refs,'zquest-quest-snapshots',id,'r01/Homestead.qst.gz');await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,bytes);
 await writeFile(path.join(refs,'zquest-quest-snapshots/joined-homestead-metadata.json'),JSON.stringify({id,index:900004,name:'Charmville joined homestead',authors:[{name:'Research adaptation of The Hero of Dreams by Shoelace'}],defaultPath:id+'/r01/Homestead.qst',images:[],music:[],releases:[{name:'r01',resources:['Homestead.qst'],hash:createHash('sha1').update(bytes).digest('hex'),resourceHashes:[createHash('md5').update(bytes).digest('hex')]}]},null,2));
}
console.log('Joined full Homestead compiled and startup verified. '+(process.argv.includes('--publish')?'Published separate quest.':'Not published.'));
