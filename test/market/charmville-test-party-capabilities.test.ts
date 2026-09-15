import {test} from 'node:test';
import assert from 'node:assert/strict';
import {POST} from '../../app/api/charmville/local-playtest/party/route';
import {testPartyOffered} from '../../app/charmville/world/test-party-panel';

test('disabled local party capabilities never offer profile creation or provisioning',async()=>{
 const request=(action:string)=>new Request('https://plank.love/api/charmville/local-playtest/party',{method:'POST',headers:{origin:'https://plank.love','Content-Type':'application/json'},body:JSON.stringify({action})});
 const response=await POST(request('capabilities'));
 assert.equal(response.status,200);
 const capabilities=await response.json();
 assert.deepEqual(capabilities,{enabled:false,eligible:false,granted:false});
 assert.equal(testPartyOffered(capabilities,true),false);
 assert.equal(testPartyOffered({...capabilities,eligible:true},true),false);
 assert.equal((await POST(request('provision'))).status,404);
});
test('enabled sandbox offers only eligible roster or explicit separate profile creation',()=>{
 assert.equal(testPartyOffered(null,true),false);
 assert.equal(testPartyOffered({enabled:true,eligible:false,granted:false},false),false);
 assert.equal(testPartyOffered({enabled:true,eligible:false,granted:false},true),true);
 assert.equal(testPartyOffered({enabled:true,eligible:true,granted:false},false),true);
});
