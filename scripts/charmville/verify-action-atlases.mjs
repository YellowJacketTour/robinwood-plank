import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';

const root = '../charmville-references/charmville-native-homestead/action-sprites/';
const runtime = await readFile('scripts/charmville/zquest/Homestead.zs', 'utf8');
const source = await readFile('../charmville-references/universal-lpc/sources/source_index.html', 'utf8');
assert(source.includes('data-cycle-custom="0-1-4-4-4-4-5"'));
assert(runtime.includes('waterFrames[]={0,1,4,4,4,4,5}'));
const result = [];
for (const [tool, frames] of [['hoe', [0,1,2,3,4,5,6,7]], ['water', [0,1,4,4,4,4,5]]]) {
  const fg = PNG.sync.read(await readFile(root + tool + '-fg.png'));
  const bg = PNG.sync.read(await readFile(root + tool + '-bg.png'));
  assert.equal(fg.width, bg.width); assert.equal(fg.height, bg.height);
  for (const [direction, row] of [['up',4],['left',5],['down',6],['right',7]]) {
    for (const frame of frames) {
      let foreground = 0, background = 0;
      for(let y=0;y<64;y++) for(let x=0;x<64;x++) {
        const index=((row*64+y)*fg.width+frame*64+x)*4+3;
        if(fg.data[index]) foreground++;
        if(bg.data[index]) background++;
      }
      assert(foreground + background > 0, `${tool} ${direction} frame ${frame} is invisible`);
      result.push({tool,direction,frame,foreground,background});
    }
  }
}
console.log(JSON.stringify({passed:true,checks:result.length,frames:result},null,2));
