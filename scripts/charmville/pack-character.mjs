import sharp from 'sharp';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve('public/images/charmville/quaternius-farmer');
const output=join(root,'atlases');
await mkdir(output,{recursive:true});
const actions={idle:1,walk:8,pickup:8};
for(const [action,count] of Object.entries(actions)){
  for(let direction=0;direction<8;direction++){
    const composite=[];
    for(let frame=0;frame<count;frame++){
      const input=join(root,action,String(direction),`${frame}.png`);
      const metadata=await sharp(input).metadata();
      if(metadata.width!==128||metadata.height!==160)throw Error(`Unexpected character frame size: ${input}`);
      composite.push({input,left:frame*128,top:0});
    }
    await sharp({create:{width:128*count,height:160,channels:4,background:{r:0,g:0,b:0,alpha:0}}})
      .composite(composite).webp({lossless:true}).toFile(join(output,`${action}-${direction}.webp`));
  }
}
await writeFile(join(output,'manifest.json'),JSON.stringify({frameWidth:128,frameHeight:160,directions:8,actions,encoding:'lossless WebP'},null,2));
console.log('Packed 136 character frames into 24 lossless atlases.');
