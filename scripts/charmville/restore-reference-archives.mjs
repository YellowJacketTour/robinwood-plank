// Restore only to a new/empty directory. Never overwrite a user's existing references.
import {readFile,readdir,mkdir,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const [archiveDirectory,destination]=process.argv.slice(2);
if(!archiveDirectory||!destination)throw Error('Usage: node scripts/charmville/restore-reference-archives.mjs <download-directory> <empty-reference-directory>');
const source=path.resolve(archiveDirectory),target=path.resolve(destination);
await mkdir(target,{recursive:true});
if((await readdir(target)).length)throw Error('Restore destination must be empty. Existing files will not be overwritten.');
const manifest=JSON.parse(await readFile(path.join(source,'archive-manifest.json'),'utf8'));
for(const entry of manifest.archives){
 if(path.basename(entry.file)!==entry.file)throw Error('Unsafe archive filename');
 const file=path.join(source,entry.file),info=await stat(file),hash=createHash('sha256');
 for await(const chunk of createReadStream(file))hash.update(chunk);
 if(info.size!==entry.bytes||hash.digest('hex')!==entry.sha256)throw Error(`Archive integrity failure: ${entry.file}`);
 console.log(`Verified ${entry.file}`);
}
// Python's data filter rejects absolute/outside paths and unsafe links or devices.
for(const entry of manifest.archives){
 execFileSync('python',['-c','import sys,tarfile; a=tarfile.open(sys.argv[1]); a.extractall(sys.argv[2],filter="data")',path.join(source,entry.file),target],{stdio:'inherit',windowsHide:true});
 console.log(`Restored ${entry.source}`);
}
