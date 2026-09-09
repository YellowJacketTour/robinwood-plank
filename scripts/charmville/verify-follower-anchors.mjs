import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {PNG} from 'pngjs';
const script=await readFile('scripts/charmville/zquest/Homestead.zs','utf8');
const array=name=>script.match(new RegExp(`int ${name}\\[\\]=\\{([^}]+)\\}`))[1].split(',').map(Number);
const ax=array('mudkipAnchorX'),ay=array('mudkipAnchorY');let checked=0;
for(const [id,w,h,frames] of [['0252',32,32,4],['0255',24,32,4],['0258',32,40,6]]){
 const png=PNG.sync.read(await readFile(`public/charmville/creatures/followers/sprite/${id}/Walk-Shadow.png`));
 assert.equal(png.width,w*frames);assert.equal(png.height,h*8);
 for(let row=0;row<8;row++)for(let frame=0;frame<frames;frame++){
  const markers=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const offset=((row*h+y)*png.width+frame*w+x)*4;
   if(png.data.subarray(offset,offset+4).every(value=>value===255))markers.push([x,y]);
  }
  const expected=id==='0258'?[ax[row*6+frame],ay[row*6+frame]]:[w/2,20];
  assert.deepEqual(markers,[expected],`${id} row${row} frame${frame}`);checked++;
 }
}
console.log(`${checked} native ground anchors match exact source markers.`);
