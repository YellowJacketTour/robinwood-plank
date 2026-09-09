import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const catalog=JSON.parse(await readFile('public/charmville/library/catalog.json','utf8'));
const {charms}=JSON.parse(await readFile('public/charmville/library/charms.json','utf8'));
assert.equal(new Set(catalog.assets.map(a=>a.id)).size,catalog.assets.length);
assert.equal(new Set(charms.map(c=>c.id)).size,charms.length);
assert.equal(charms.length,78);
assert.ok(charms.some(c=>c.emoji===''),'Empty emoji must not remove an identity');
assert.ok(charms.some(c=>c.name==='uowo'&&c.poolId===''),'Base asset without a pool must remain discoverable');
let previews=0;
for(const asset of catalog.assets){assert.match(asset.sha256,/^[a-f0-9]{64}$/);assert.ok(asset.bytes>=0);if(asset.preview){assert.equal(asset.license,'CC0');assert.match(asset.preview,/^\/charmville\/library\/[a-f0-9]{64}\.png$/);const bytes=await readFile('public'+asset.preview);assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);previews++;}}
for(const source of catalog.sources)assert.equal(source.count,catalog.assets.filter(a=>a.source===source.id).length);
console.log(`Verified ${catalog.assets.length} unique file identities, ${charms.length} charm identities, ${previews} preview hashes.`);
