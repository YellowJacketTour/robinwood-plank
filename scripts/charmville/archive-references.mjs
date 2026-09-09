// Archive the exact acquired working trees (including Git/LFS history) to a private release.
// Run from the app repository; no credentials or runtime environment files are copied.
import {readdir,mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import path from 'node:path';
const refs=path.resolve(process.argv[2]||'../charmville-references');
const out=path.resolve(process.argv[3]||'../charmville-backup-archives');
const repository=process.argv[4];
const tag=process.argv[5];
await mkdir(out,{recursive:true});
const run=(exe,args)=>new Promise((resolve,reject)=>{const child=spawn(exe,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});let err='';child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`${exe}: ${code}: ${err.slice(-1500)}`)));});
let archives=[];
try{const prior=JSON.parse(await readFile(path.join(out,'archive-manifest.json'),'utf8'));if(prior.repository!==repository||prior.tag!==tag)throw Error('Backup destination mismatch');archives=prior.archives;}catch(error){if(error.code!=='ENOENT')throw error;}
for(const entry of await readdir(refs,{withFileTypes:true})){
 if(!entry.isDirectory()||entry.isSymbolicLink())continue;
 if(archives.some(a=>a.source===entry.name&&a.uploaded)){console.log(`${entry.name}: already archived/uploaded`);continue;}
 const file=path.join(out,entry.name+'.tar.gz');
 await run('python',['scripts/charmville/archive-tree.py',path.join(refs,entry.name),file]);
 const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
 const info=await stat(file);
 let revision=null,remote=null;
 try{await stat(path.join(refs,entry.name,'.git'));revision=execFileSync('git',['-C',path.join(refs,entry.name),'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();remote=execFileSync('git',['-C',path.join(refs,entry.name),'remote','get-url','origin'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{/* downloaded asset directory */}
 const record={source:entry.name,file:path.basename(file),bytes:info.size,sha256:hash.digest('hex'),revision,remote};
 if(info.size>=2_000_000_000)throw Error(`Archive requires splitting before upload: ${file}`);
 if(repository&&tag){await run('gh',['release','upload',tag,file,'--repo',repository]);record.uploaded=true;}
 archives.push(record);
 await writeFile(path.join(out,'archive-manifest.json'),JSON.stringify({schema:1,createdAt:new Date().toISOString(),repository,tag,exclusions:['.env*','node_modules','.next','__pycache__'],archives},null,2));
 console.log(`${entry.name}: ${Math.round(info.size/1024/1024)} MiB${record.uploaded?' uploaded':''}`);
}
console.log(`Completed ${archives.length} archives.`);
