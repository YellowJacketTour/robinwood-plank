import {cp,copyFile,readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const repo=process.cwd(),refs=path.resolve(repo,'../charmville-references');
const source=path.join(repo,'scripts/charmville/dmap-source-audit.zs');
const template=path.join(refs,'charmville-native-homestead/template.qst');
const out=path.join(repo,'work/dmap-source-audit'),runtime=path.join(out,'runtime'),quest=path.join(out,'DMapAudit.qst');
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
const before=await hash(template);await mkdir(out,{recursive:true});
await cp(path.join(refs,'zquest-native-212/runtime'),runtime,{recursive:true});await copyFile(template,quest);await copyFile(source,path.join(runtime,'include/CharmvilleHomestead.zh'));
async function run(exe,args,marker){let log='';await writeFile(path.join(runtime,'allegro.log'),'');const child=spawn(path.join(runtime,exe),args,{cwd:runtime,windowsHide:true,stdio:'pipe'});child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);let timeout=false;const timer=setTimeout(()=>{timeout=true;child.kill();},120000);const watch=marker?setInterval(async()=>{try{const s=await readFile(path.join(runtime,'allegro.log'),'utf8');if(s.includes(marker)){log+='\n'+s;child.kill();}}catch{}},200):null;const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});clearTimeout(timer);if(watch)clearInterval(watch);await writeFile(path.join(out,exe+'.log'),log);if(timeout||(code!==0&&!log.includes(marker||'UNREACHABLE')))throw Error(log.slice(-3000));return log;}
await run('zeditor.exe',['-smart-assign',quest]);const log=await run('zplayer.exe',['-headless','-test',quest,'4','63'],'DMAP_AUDIT_DONE');
const entries=[...new Map(log.split(/\r?\n/).filter(l=>l.startsWith('DMAP_ENTRY|')).map(l=>{const a=l.split('|');const v={dmap:+a[1],map:+a[2],offset:+a[3],type:+a[4],palette:+a[5],midi:+a[6],continueScreen:+a[7],level:+a[8],name:a[9],title:a[10],enhancedMusic:a[11]};return [v.dmap,v];})).values()];
const rooms=[...new Map(log.split(/\r?\n/).filter(l=>l.startsWith('DMAP_ROOM|')).map(l=>{const a=l.split('|');const v={map:+a[1],screen:+a[2],palette:+a[3],roomType:+a[4],nonzero:+a[5],solid:+a[6],enemies:+a[7],centerOpen:+a[8]};return [v.map+':'+v.screen,v];})).values()];
const result={source:'isolated native audit of charmville-native-homestead/template.qst',templateSha256:before,templateUnchanged:before===await hash(template),slots:entries.length,entries,rooms,limitations:['Palette IDs alone do not establish brightness or welcoming artwork.','Zero authored enemies does not establish safety: scripts, collision, secrets and transitions require playtesting.','Template metadata must not be assumed byte-identical to untouched HeroOfDreams without comparison.']};await writeFile(path.join(out,'inventory.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({slots:entries.length,rooms:rooms.length,templateUnchanged:result.templateUnchanged}));
