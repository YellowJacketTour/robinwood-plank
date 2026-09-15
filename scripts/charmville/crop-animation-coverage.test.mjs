import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const manifest=JSON.parse(await readFile(new URL('../../docs/charmville-reconstruction/CROP-ANIMATION-COVERAGE.json',import.meta.url),'utf8'));
const source=await readFile(new URL('../../'+manifest.source,import.meta.url),'utf8');
test('crop animation matrix ties its structural claims to current native source',()=>{
 assert.deepEqual(manifest.crops,['oran-berry','burning-heart']);
 assert.equal(new Set(manifest.directions).size,4);
 assert.equal(new Set(manifest.actions.map(action=>action.nativeCode)).size,4);
 for(const invariant of manifest.invariants)assert.ok(source.includes(invariant.anchor),`Review changed native invariant: ${invariant.id}`);
 assert.deepEqual(manifest.actions.find(action=>action.id==='water').frameSequence,[0,1,4,4,4,4,5]);
 assert.equal(manifest.coveragePolicy.visualFrames,'unverified');
 assert.equal(manifest.coveragePolicy.allDirectionsLive,'unverified');
});
test('distinct Heart stages retain soil anchor and never alter collision or the global palette',async()=>{
 const heart=await readFile(new URL('./zquest/HeartCrop.zh',import.meta.url),'utf8');
 for(const marker of ['if(stage<2)return;','if(stage==2)','phase==0','phase==1','if(stage==4)','y+14'])assert.ok(heart.includes(marker),marker);
 assert.doesNotMatch(heart,/Screen->ComboD\s*\[|Hero->(?:X|Y)\s*=|SetMainPalette|SetLevelPalette/);
});
