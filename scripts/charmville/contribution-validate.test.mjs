import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {parseContributionManifest,verifyContributionPacks,CONTRIBUTION_MAX_BYTES} from './contribution-validate.mjs';
const bytes=p=>Buffer.from(JSON.stringify(p));
const fixture=()=>({schemaVersion:1,id:'friends.heart-bed',baseCommit:'a'.repeat(40),summary:'Improve four-direction Heart watering art.',packs:[{id:'friends.heart',version:'1.0.0',manifestSha256:'b'.repeat(64)}],evidence:[{kind:'visual',path:'evidence/watering.png',sha256:'c'.repeat(64)}]});
test('contribution pins source and proposed packs without asserting publication',()=>{
 const p=parseContributionManifest(bytes(fixture()));assert.equal(p.baseCommit,'a'.repeat(40));assert.ok(Object.isFrozen(p.packs[0]));assert.equal(p.publicationApproved,undefined);
 assert.deepEqual(verifyContributionPacks(p,new Map()),['friends.heart: missing pinned manifest']);
});
test('rejects executable authority, mutable refs, unsafe evidence and oversized input',()=>{
 for(const mutate of [p=>p.run='npm install',p=>p.approved=true,p=>p.baseCommit='master',p=>p.packs[0].version='latest',p=>p.packs.push({...p.packs[0]}),p=>p.evidence[0].path='evidence/../../secret.md',p=>p.evidence[0].path='https://example.com/a.png',p=>p.evidence[0].path='evidence/hook.js',p=>p.summary='text\n::workflow-command',p=>p.packs[0].capabilities=['mint']]){
  const p=fixture();mutate(p);assert.throws(()=>parseContributionManifest(bytes(p)));
 }
 assert.throws(()=>parseContributionManifest(Buffer.alloc(CONTRIBUTION_MAX_BYTES+1)),/byte limit/);
 assert.throws(()=>parseContributionManifest(Buffer.from([0xff])),/UTF-8/);
});
test('pack resolution verifies exact hash and delegates action authority checks',()=>{
 const p=fixture(),pack={schemaVersion:1,id:'friends.heart',version:'1.0.0',authors:['Test'],dependencies:[],assets:[],actions:[]};
 const content=bytes(pack),digest=createHash('sha256').update(content).digest('hex');p.packs[0].manifestSha256=digest;
 assert.match(verifyContributionPacks(p,new Map([[digest,Buffer.from('changed')]])).join(),/hash mismatch/);
 assert.ok(verifyContributionPacks(p,new Map([[digest,content]])).length>0); // Incomplete art cannot pass existing pack rules.
 const other=bytes({...pack,id:'other.pack'}),otherHash=createHash('sha256').update(other).digest('hex');p.packs[0].manifestSha256=otherHash;
 assert.match(verifyContributionPacks(p,new Map([[otherHash,other]])).join(),/identity mismatch/);
});
