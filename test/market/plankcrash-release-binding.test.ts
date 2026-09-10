import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseDigest,validateReleaseBinding} from '../../scripts/lib/plankcrash-release-binding.js';
test('release binding is key-order independent and rejects source/config drift',()=>{
 const config={chainId:4663,limits:{roundStakeWei:'100000000000000000',underwritingWei:'1000000000000000'}};
 const source='a'.repeat(64);
 const review={schema:'plankcrash.review-binding.v1',sourceFingerprint:source,configFingerprint:releaseDigest(config),contractAuditSha256:'b'.repeat(64),mathReviewSha256:'c'.repeat(64)};
 assert.deepEqual(validateReleaseBinding(review,source,config),[]);
 assert.equal(releaseDigest({a:1,b:2}),releaseDigest({b:2,a:1}));
 assert.ok(validateReleaseBinding(review,'d'.repeat(64),config).some(e=>e.includes('source')));
 assert.ok(validateReleaseBinding(review,source,{...config,chainId:31337}).some(e=>e.includes('configuration')));
 assert.ok(validateReleaseBinding({...review,contractAuditSha256:''},source,config).length);
});
