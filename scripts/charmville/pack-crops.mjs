import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('public/images/charmville/original');
const manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
for(const [species,states] of Object.entries(manifest.species))for(const [state,files] of Object.entries(states)){
 await sharp({create:{width:256*files.length,height:192,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(files.map((file,i)=>({input:path.join(root,file),left:i*256,top:0}))).png().toFile(path.join(root,`${species}-${state}.png`));
}
console.log('Packed six animated crop atlases.');
