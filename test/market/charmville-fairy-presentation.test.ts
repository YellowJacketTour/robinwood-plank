import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FAIRY_SKINS,isFairySkin} from '../../lib/charmville/fairy-presentation';

test('fairy appearance accepts only internal palette IDs, never arbitrary remote or script content',()=>{
 for(const [skin] of FAIRY_SKINS)assert.equal(isFairySkin(skin),true);
 for(const value of [null,{},'https://example.com/model.svg','<svg/>','javascript:alert(1)','BLUE','gold '])assert.equal(isFairySkin(value),false);
});
test('fairy source artifact preserves its bounded original four-wing identity without external payloads',async()=>{
 const svg=await readFile('public/charmville/items/love-fairy-guide.svg','utf8');
 const manifest=JSON.parse(await readFile('public/charmville/items/love-fairy-guide.asset.json','utf8'));
 assert.equal(manifest.isExtractedNavi,false);assert.equal(manifest.affectsSimulation,false);
 assert.deepEqual(manifest.skins,FAIRY_SKINS.map(([skin])=>skin));
 assert.equal((svg.match(/<path /g)??[]).length,manifest.wingCount);
 assert.match(svg,/viewBox="0 0 96 96"/);
 assert.doesNotMatch(svg,/<(?:script|image|foreignObject|filter)\b|href=|onload=/i);
 assert.ok(Buffer.byteLength(svg)<4096);
});
