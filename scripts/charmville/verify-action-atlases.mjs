import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

// The native compiler deliberately omits tRNS: Allegro masks index zero.
// Browser RGBA decoders would therefore count every transparent pixel opaque.
function nativeIndices(bytes) {
  assert.equal(bytes[24],8,'Native atlas must use eight-bit indices');
  assert.equal(bytes[25],3,'Native atlas must be palette indexed');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),chunks=[];
  for(let offset=8;offset<bytes.length;){
    const size=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);
    assert.notEqual(type,'tRNS','tRNS causes incompatible native alpha expansion');
    if(type==='IDAT')chunks.push(bytes.subarray(offset+8,offset+8+size));
    offset+=size+12;
  }
  const scanlines=inflateSync(Buffer.concat(chunks)),data=Buffer.alloc(width*height);
  assert.equal(scanlines.length,(width+1)*height);
  for(let y=0;y<height;y++){
    assert.equal(scanlines[y*(width+1)],0,'Compiler emits unfiltered index rows');
    scanlines.copy(data,y*width,y*(width+1)+1,(y+1)*(width+1));
  }
  assert(data.includes(0),'Atlas needs native transparent pixels');
  return {width,height,data};
}

const root = '../charmville-references/charmville-native-homestead/action-sprites/';
const runtime = await readFile('scripts/charmville/zquest/Homestead.zs', 'utf8');
const source = await readFile('../charmville-references/universal-lpc/sources/source_index.html', 'utf8');
assert(source.includes('data-cycle-custom="0-1-4-4-4-4-5"'));
assert(runtime.includes('waterFrames[]={0,1,4,4,4,4,5}'));
const result = [];
for (const [tool, frames] of [['hoe', [0,1,2,3,4,5,6,7]], ['water', [0,1,4,4,4,4,5]]]) {
  const fg = nativeIndices(await readFile(root + tool + '-fg.png'));
  const bg = nativeIndices(await readFile(root + tool + '-bg.png'));
  assert.equal(fg.width, bg.width); assert.equal(fg.height, bg.height);
  for (const [direction, row] of [['up',4],['left',5],['down',6],['right',7]]) {
    for (const frame of frames) {
      let foreground = 0, background = 0;
      for(let y=0;y<64;y++) for(let x=0;x<64;x++) {
        const index=(row*64+y)*fg.width+frame*64+x;
        if(fg.data[index]) foreground++;
        if(bg.data[index]) background++;
      }
      assert(foreground + background > 0, `${tool} ${direction} frame ${frame} is invisible`);
      result.push({tool,direction,frame,foreground,background});
    }
  }
}
console.log(JSON.stringify({passed:true,checks:result.length,frames:result},null,2));
