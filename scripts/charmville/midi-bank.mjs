import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function parseMidiPatches(config) {
 const names=[...config.matchAll(/^\s*\d+\s+(\S+\.pat)(?:\s|$)/gm)].map(m=>m[1]);
 for(const name of names)if(!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.pat$/.test(name)||name.includes('..'))throw Error('Unsafe MIDI patch path');
 return [...new Set(names)].sort();
}
export async function midiBankManifest(root) {
 const names=parseMidiPatches(await readFile(path.join(root,'zc.cfg'),'utf8'));
 const patches=await Promise.all(names.map(async name=>{const bytes=await readFile(path.join(root,name));return {name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}));
 return {config:'zc.cfg',virtualRoot:'/etc',patches,totalBytes:patches.reduce((n,p)=>n+p.bytes,0)};
}
