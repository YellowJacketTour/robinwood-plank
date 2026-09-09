import {readdir,readFile,stat,writeFile,mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const refs=path.resolve(process.argv[2]||'../charmville-references');
const output=path.resolve(process.argv[3]||'docs/charmville-reconstruction');
const ids=['solarus-engine','solarus-zsdx','solarus-trillium','solarus-mit-starter','solarus-online','pokeemerald','zelda3','zquest-classic','graal-reborn-server','tuxemon','memoji-market','farmvillage','fv-replowed','lincity-ng','unknown-horizons','universal-lpc'];
const exclude=new Set(['.git','node_modules','vendor','.venv','__pycache__','.next']);
async function files(dir){const out=[];for(const entry of await readdir(dir,{withFileTypes:true})){if(exclude.has(entry.name)||entry.name.startsWith('.env')||entry.isSymbolicLink())continue;const file=path.join(dir,entry.name);if(entry.isDirectory())out.push(...await files(file));else out.push(file);}return out.sort();}
async function sha(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
function git(dir,args){try{return execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return null;}}
const repos=[];
await mkdir(output,{recursive:true});
for(const id of ids){const dir=path.join(refs,id);try{await stat(dir);}catch{repos.push({id,status:'not-acquired'});continue;}const entries=[];
 for(const file of await files(dir)){const rel=path.relative(dir,file).split(path.sep).join('/');const info=await stat(file);let lfsPointer=false;if(info.size<1024){const text=await readFile(file,'utf8');lfsPointer=text.startsWith('version https://git-lfs.github.com/spec/v1');}entries.push({path:rel,bytes:info.size,sha256:await sha(file),lfsPointer});}
 const repo={id,revision:git(dir,['rev-parse','HEAD']),submodules:git(dir,['submodule','status']),fileCount:entries.length,bytes:entries.reduce((n,x)=>n+x.bytes,0),unresolvedLfs:entries.filter(x=>x.lfsPointer).map(x=>x.path),status:'acquired-and-hashed; runtime-unverified',manifest:`${id}.json`};
 await writeFile(path.join(output,repo.manifest),JSON.stringify({source:id,revision:repo.revision,files:entries}));repos.push(repo);console.log(`${id}: ${entries.length} files, ${repo.unresolvedLfs.length} unresolved LFS objects`);
}
await writeFile(path.join(output,'source-lock.json'),JSON.stringify({schema:1,note:'Exact current source snapshots. Acquisition is not a runtime or behavior verification. See manifests for content hashes; submodules prefixed - are not initialized.',repositories:repos},null,2));
