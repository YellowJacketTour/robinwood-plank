import {test} from 'node:test';import assert from 'node:assert/strict';
import {nativeResourceRequestPolicy} from '../../lib/charmville/native-resource-negotiation';
const request=(headers:Record<string,string>={})=>new Request('http://localhost:3018/api/charmville/world/resources',{headers});
const headers={'x-charmville-resource-protocol':'2','x-charmville-resource-crops':'oran-berry,burning-heart'};
test('native crop negotiation needs both explicit client capability and local server opt-in',()=>{
 assert.equal(nativeResourceRequestPolicy(request(),{NODE_ENV:'development',CHARMVILLE_NATIVE_CROP_PROTOCOL:'2'}),undefined);
 assert.equal(nativeResourceRequestPolicy(request(headers),{NODE_ENV:'production',CHARMVILLE_NATIVE_CROP_PROTOCOL:'2'}),undefined);
 assert.equal(nativeResourceRequestPolicy(request(headers),{NODE_ENV:'development'}),undefined);
 assert.deepEqual(nativeResourceRequestPolicy(request(headers),{NODE_ENV:'development',CHARMVILLE_NATIVE_CROP_PROTOCOL:'2'}),{protocolVersion:2,burningHeartEnabled:true});
 for(const h of [{'x-charmville-resource-protocol':'2'},{...headers,'x-charmville-resource-crops':'anything'},{...headers,'x-charmville-resource-protocol':'3'}])assert.throws(()=>nativeResourceRequestPolicy(request(h),{NODE_ENV:'development',CHARMVILLE_NATIVE_CROP_PROTOCOL:'2'}),/Update the game/);
});
