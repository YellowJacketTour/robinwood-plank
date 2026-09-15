import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {charmName,itemArt,charmDescription} from '../../lib/charmville/item-display';
import {requireNativeCrop} from '../../lib/charmville/native-crops';
import {socialItem} from '../../lib/charmville/social-items';

test('Burning Heart display identity does not alias Oran or activate issuance/social spending',()=>{
 assert.equal(charmName('burning-heart'),'Burning Heart');
 assert.equal(itemArt('burning-heart'),'/charmville/items/burning-heart.svg');
 assert.equal(charmName('oran-berry'),'Oran Berry');
 assert.notEqual(itemArt('burning-heart'),itemArt('oran-berry'));
 assert.match(charmDescription('burning-heart'),/heart blossom/);
 assert.equal(socialItem('burning-heart'),undefined);
 assert.throws(()=>requireNativeCrop('burning-heart'),/unavailable/);
 assert.equal(itemArt('unknown-item'),undefined);
});

test('original heart artwork is a self-contained static vector with no network or executable content',async()=>{
 const svg=await readFile(new URL('../../public/charmville/items/burning-heart.svg',import.meta.url),'utf8');
 assert.match(svg,/viewBox="0 0 32 32"/);
 assert.match(svg,/<title>Burning Heart<\/title>/);
 assert.doesNotMatch(svg,/<(?:script|foreignObject|image|use|animate|set)\b|\son\w+=|href=|url\(/i);
 assert.match(svg,/fill="#F43F5E"/);
 assert.match(svg,/fill="#E9B43F"/);
 // The canonical redesign intentionally removes loose green stem fragments.
 // Enforce its actual silhouette contract instead of requiring an old pigment.
 const {data,info}=await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 assert.equal(info.width,32);assert.equal(info.height,32);
 const opaque=new Set<number>();
 for(let y=0;y<32;y++)for(let x=0;x<32;x++){
  const alpha=data[(y*32+x)*info.channels+3];
  if(x<2||x>=30||y<2||y>=30)assert.equal(alpha,0,`clear border at ${x},${y}`);
  if(alpha>0)opaque.add(y*32+x);
 }
 assert.ok(opaque.size>200,'Heart must render as visible artwork, not an empty SVG');
 const reached=new Set<number>(),pending=[opaque.values().next().value!];
 while(pending.length){const pixel=pending.pop()!;if(reached.has(pixel)||!opaque.has(pixel))continue;reached.add(pixel);const x=pixel%32,y=Math.floor(pixel/32);if(x>0)pending.push(pixel-1);if(x<31)pending.push(pixel+1);if(y>0)pending.push(pixel-32);if(y<31)pending.push(pixel+32);}
 assert.equal(reached.size,opaque.size,'Every visible pixel belongs to one connected heart/flame silhouette');
 const provenance=JSON.parse(await readFile(new URL('../../public/charmville/items/provenance.json',import.meta.url),'utf8'));
 assert.equal(provenance['burning-heart'].source,'Charmville original vector artwork');
 assert.equal(provenance['burning-heart'].path,'public/charmville/items/burning-heart.svg');
 assert.deepEqual(provenance['burning-heart'].nativeGrid,[32,32]);
 assert.equal(provenance['burning-heart'].derivativeOfNintendoArtwork,false);
});
