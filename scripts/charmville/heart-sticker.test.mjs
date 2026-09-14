import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
test('Heart sticker preserves every canonical path and binds both source hashes',async()=>{
 const master=await readFile('public/charmville/items/burning-heart.svg','utf8');
 const sticker=await readFile('public/charmville/stickers/burning-heart.svg','utf8');
 const metadata=JSON.parse(await readFile('public/charmville/stickers/burning-heart.json','utf8'));
 assert.equal(hash(master),metadata.master.sha256);assert.equal(hash(sticker),metadata.animated.sha256);
 const paths=s=>[...s.matchAll(/<path\s[^>]*\/>/g)].map(m=>m[0].replace(/ class="[^"]*"/g,''));
 assert.deepEqual(paths(sticker),paths(master));
 assert.match(sticker,/@media\(prefers-reduced-motion:reduce\)/);
 assert.match(sticker,/animation:none!important/);
 assert.doesNotMatch(sticker,/<script|<foreignObject|(?:href|src)=|@import|url\(/i);
 assert.equal(metadata.authority,'presentation-only');
 assert.equal(metadata.acceptance.browserPlaybackReviewed,false);
});
