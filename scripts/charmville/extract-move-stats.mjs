import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const root=process.argv[2];if(!root)throw Error('Pass pinned pokeemerald reference directory');
const files=['include/constants/moves.h','src/data/battle_moves.h'];
const contents=await Promise.all(files.map(file=>readFile(path.join(root,file),'utf8')));
const ids=Object.fromEntries([...contents[0].matchAll(/^#define MOVE_(\w+)\s+(\d+)\s*$/gm)].map(m=>[m[1],Number(m[2])]));
const moves={};
for(const match of contents[1].matchAll(/\[MOVE_(\w+)\]\s*=\s*\{([\s\S]*?)\}/g)){
 const name=match[1],id=ids[name],body=match[2];if(!id)continue;
 const field=key=>new RegExp('\\.'+key+'\\s*=\\s*([^,]+),').exec(body)?.[1].trim();
 const numbers=Object.fromEntries(['power','accuracy','pp','secondaryEffectChance','priority'].map(key=>[key,Number(field(key))]));
 if(Object.values(numbers).some(n=>!Number.isInteger(n)))throw Error('Invalid numeric move '+name);
 const effect=field('effect'),type=field('type'),target=field('target'),flags=field('flags');
 if(!effect||!type||!target||!flags)throw Error('Incomplete move '+name);
 moves[id]={name,...numbers,effect,type:type.replace(/^TYPE_/,''),target,flags:flags==='0'?[]:flags.split(' | ')};
}
if(Object.keys(moves).length!==354)throw Error('Expected 354 moves');
const revision=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
await writeFile('lib/charmville/move-stats.json',JSON.stringify({source:'https://github.com/pret/pokeemerald',revision,files:Object.fromEntries(files.map((file,i)=>[file,createHash('sha256').update(contents[i]).digest('hex')])),moves},null,2)+'\n');
console.log('Extracted 354 move definitions. Effects are metadata, not implemented battle behaviors.');
