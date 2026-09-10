import {readFile,writeFile,cp} from 'node:fs/promises';
import {PNG} from 'pngjs';
import assert from 'node:assert/strict';
const root='../charmville-references/pmd-followers';
let source='// Generated from pinned PMD walking durations and ground markers.\n';
const metadata=[];
for(const [id,name,species] of [['0025','pikachu',25],['0133','eevee',133],['0261','poochyena',286]]){
 const xml=await readFile(`${root}/sprite/${id}/AnimData.xml`,'utf8');
 const walk=xml.match(/<Anim>\s*<Name>Walk<\/Name>([\s\S]*?)<\/Anim>/)[1];
 const w=Number(walk.match(/<FrameWidth>(\d+)/)[1]),h=Number(walk.match(/<FrameHeight>(\d+)/)[1]);
 const durations=[...walk.matchAll(/<Duration>(\d+)/g)].map(m=>Number(m[1])),frames=durations.length;
 const shadow=PNG.sync.read(await readFile(`${root}/sprite/${id}/Walk-Shadow.png`)),ax=[],ay=[];
 assert.equal(shadow.width,w*frames);assert.equal(shadow.height,h*8);
 for(let row=0;row<8;row++)for(let frame=0;frame<frames;frame++){
  const points=[];for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=((row*h+y)*shadow.width+frame*w+x)*4;if(shadow.data.subarray(i,i+4).every(v=>v===255))points.push([x,y]);}
  assert.equal(points.length,1,`${name} ${row}/${frame} ground marker`);ax.push(points[0][0]);ay.push(points[0][1]);
 }
 source+=`int ${name}AnchorX[]={${ax}};\nint ${name}AnchorY[]={${ay}};\n`;
 let cumulative=0;const expression=durations.slice(0,-1).map((d,i)=>{cumulative+=d;return `phase<${cumulative}?${i}:(`;}).join('')+(frames-1)+')'.repeat(frames-1);
 metadata.push({id,name,species,w,h,frames,durations,draw:`if(follower==${species}){int phase=(stepX==0 && stepY==0)?0:followerClock%${durations.reduce((a,b)=>a+b,0)};int frame=${expression};int anchor=row*${frames}+frame;drawCompanionScaled(${name},${species},layer,frame*${w},row*${h},${w},${h},fx+8,fy+72,${name}AnchorX[anchor],${name}AnchorY[anchor]);}`});
}
await writeFile('scripts/charmville/zquest/ExtraFollowerFrames.zh',source);
await writeFile('public/charmville/catalog/extra-follower-frames.json',JSON.stringify(metadata,null,2)+'\n');
await cp(root,'public/charmville/creatures/followers',{recursive:true});
console.log(metadata);
