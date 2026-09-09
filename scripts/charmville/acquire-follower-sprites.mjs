import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const commit='db1928346e452e1a36b8ecff62f7e4d195504763';
const base=`https://raw.githubusercontent.com/PMDCollab/SpriteCollab/${commit}/`;
const root=path.resolve('../charmville-references/pmd-followers');
const files=['LICENSE.md','README.md',...['0252','0255','0258','0025','0133','0261'].flatMap(id=>['Walk-Anim.png','Walk-Offsets.png','Walk-Shadow.png','AnimData.xml','credits.txt'].map(name=>`sprite/${id}/${name}`))];
const manifest=[];
for(const file of files){
 const response=await fetch(base+file,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error(`${file}: ${response.status}`);
 const bytes=Buffer.from(await response.arrayBuffer());await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),bytes);
 manifest.push({path:file,source:base+file,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
}
await writeFile(path.join(root,'manifest.json'),JSON.stringify({repository:'https://github.com/PMDCollab/SpriteCollab',commit,files:manifest},null,2));
console.log(`Preserved ${manifest.length} pinned source files, including per-species credits and repository license.`);
