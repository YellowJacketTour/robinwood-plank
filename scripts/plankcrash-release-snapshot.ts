import {writeFile} from 'node:fs/promises';
import {releaseSnapshot} from './lib/plankcrash-release-binding.js';
const snapshot=await releaseSnapshot();
const text=JSON.stringify({...snapshot,generatedAt:new Date().toISOString()},null,2)+'\n';
const output=process.argv.find(a=>a.startsWith('--out='))?.slice(6);
if(output)await writeFile(output,text,{flag:'wx'});
process.stdout.write(text);
