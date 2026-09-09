import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { inflateSync } from 'node:zlib';
import { compileIndexedSprite } from './indexed-sprite.mjs';

test('indexed compilation preserves opaque colors and transparency, including opaque black', () => {
  const source = new PNG({ width: 4, height: 1 });
  source.data.set([99,88,77,0, 0,0,0,255, 255,170,22,255, 255,170,22,255]);
  const result = compileIndexedSprite(PNG.sync.write(source));
  assert.equal(result.bytes[25], 3);
  assert.deepEqual(result.colors, [0,0,0, 0,0,0, 255,170,22]);
  const decoded = PNG.sync.read(result.bytes);
  assert.equal(result.bytes.includes(Buffer.from('tRNS')), false);
  let offset=8;const imageChunks=[];
  while(offset<result.bytes.length){const size=result.bytes.readUInt32BE(offset);if(result.bytes.toString('ascii',offset+4,offset+8)==='IDAT')imageChunks.push(result.bytes.subarray(offset+8,offset+8+size));offset+=size+12;}
  assert.deepEqual([...inflateSync(Buffer.concat(imageChunks))],[0,0,1,2,2]);
  assert.deepEqual(decoded.data.subarray(4), source.data.subarray(4));
});

test('refuses partial alpha rather than silently changing artwork', () => {
  const source = new PNG({ width: 1, height: 1 });
  source.data.set([255,255,255,127]);
  assert.throws(() => compileIndexedSprite(PNG.sync.write(source)), /partial alpha/);
});

test('refuses palette overflow rather than silently quantizing', () => {
  const source = new PNG({ width: 256, height: 1 });
  for(let i=0;i<256;i++) source.data.set([i,1,2,255],i*4);
  assert.throws(() => compileIndexedSprite(PNG.sync.write(source)), /255 opaque colors/);
});
