import {copyFile,readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';import path from 'node:path';import {createHash} from 'node:crypto';
const refs=path.resolve('../charmville-references');const runtime=path.join(refs,'zquest-native-212/runtime');const bundle=path.join(refs,'charmville-native-homestead');
const candidateOnly=process.argv.includes('--candidate');
const quest=path.join(bundle,candidateOnly?'Homestead.candidate.qst':'Homestead.qst');await copyFile(path.join(bundle,'template.qst'),quest);
await copyFile('scripts/charmville/zquest/Homestead.zs',path.join(runtime,'include/CharmvilleHomestead.zh'));
await copyFile('scripts/charmville/zquest/ActionPalettes.zh',path.join(runtime,'include/ActionPalettes.zh'));
await copyFile('scripts/charmville/zquest/ExtraFollowerFrames.zh',path.join(runtime,'include/ExtraFollowerFrames.zh'));
await copyFile('scripts/charmville/zquest/CommittedAttackFrames.zh',path.join(runtime,'include/CommittedAttackFrames.zh'));
const child=spawn(path.join(runtime,'zeditor.exe'),['-smart-assign',quest],{cwd:runtime,windowsHide:true,stdio:'pipe'});let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});await writeFile(path.join(bundle,'compile.log'),log);if(code!==0)throw Error(`Native compilation failed (${code}): ${log.slice(-2000)}`);
if(candidateOnly){console.log(`Compiled candidate without replacing the live quest: ${quest}`);process.exit(0);}
const root=path.join(refs,'zquest-quest-snapshots'),base='quests/charmville/homestead',bytes=await readFile(quest);await mkdir(path.join(root,base,'r01'),{recursive:true});
// The upstream URL ends in .gz, but fetch expects decoded bytes. Our local
// server does not emit Content-Encoding:gzip, so write the quest bytes directly.
await writeFile(path.join(root,base,'r01/Homestead.qst.gz'),bytes);
await writeFile(path.join(root,'homestead-metadata.json'),JSON.stringify({id:base,index:900002,name:'Charmville homestead prototype',authors:[{name:'Research adaptation of The Hero of Dreams by Shoelace'}],defaultPath:base+'/r01/Homestead.qst',images:[],music:[],releases:[{name:'r01',resources:['Homestead.qst'],hash:createHash('sha1').update(bytes).digest('hex'),resourceHashes:[createHash('md5').update(bytes).digest('hex')]}]},null,2));
await copyFile('scripts/charmville/zquest/Homestead.zs',path.join(bundle,'Homestead.zs'));
console.log('Compiled and published native guest tutorial: http://localhost:3021/charmville/tutorial/');
