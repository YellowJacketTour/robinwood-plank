import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';

// Read-only: verify preserved inputs without downloading or regenerating evidence.
const catalog=JSON.parse(await readFile('public/charmville/catalog/committed-attack-provenance.json','utf8'));
const root='public/charmville/creatures/followers/sprite';
let files=0,frames=0;
for(const entry of catalog.provenance.filter(p=>p.url)){
  const url=new URL(entry.url);
  const prefix=`/PMDCollab/SpriteCollab/${catalog.commit}/sprite/`;
  assert.equal(url.hostname,'raw.githubusercontent.com');
  assert(url.pathname.startsWith(prefix));
  const relative=url.pathname.slice(prefix.length);
  assert(/^\d{4}\/Attack-(Anim|Shadow|Offsets)\.png$/.test(relative));
  const bytes=await readFile(`${root}/${relative}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256,relative);
  files++;
}
for(const entry of catalog.provenance.filter(p=>p.species)){
  const xml=await readFile(`${root}/${entry.id}/AnimData.xml`,'utf8');
  const anim=xml.match(/<Anim>\s*<Name>Attack<\/Name>([\s\S]*?)<\/Anim>/)?.[1];
  assert(anim,entry.id);
  const durations=[...anim.matchAll(/<Duration>(\d+)/g)].map(m=>Number(m[1]));
  assert.deepEqual(durations,entry.durations);
  assert(durations.every(d=>Number.isInteger(d)&&d>0));
  assert.equal(Number(anim.match(/<FrameWidth>(\d+)/)[1]),entry.w);
  assert.equal(Number(anim.match(/<FrameHeight>(\d+)/)[1]),entry.h);
  assert.equal(Number(anim.match(/<HitFrame>(\d+)/)[1]),entry.hitFrame);
  assert(entry.hitFrame>=0&&entry.hitFrame<durations.length);
  assert.equal(durations.length,entry.frames);
  assert.equal(durations.reduce((n,d)=>n+d,0),entry.totalTicks);
  assert.equal(durations.slice(0,entry.hitFrame).reduce((n,d)=>n+d,0),entry.contactTick);
  for(const kind of ['Anim','Shadow','Offsets']){
    const png=PNG.sync.read(await readFile(`${root}/${entry.id}/Attack-${kind}.png`));
    assert.equal(png.width,entry.w*entry.frames,`${entry.id}/${kind} width`);
    assert.equal(png.height,entry.h*8,`${entry.id}/${kind} directions`);
  }
  frames+=entry.frames*8;
}
assert.equal(files,18);
assert.equal(frames,504);
console.log(`${files} preserved source files and ${frames} directional attack frames verified, including durations and contact timing. Visual playback remains a separate check.`);
