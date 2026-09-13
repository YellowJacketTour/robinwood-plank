import {test} from "node:test";
import assert from "node:assert/strict";
import {familyAcceptanceEnabled,readFamilyAcceptance} from "../../lib/charmville/family-acceptance-request";
import {FAMILY_ENTITLEMENT_VERSION} from "../../lib/charmville/family-entitlement";

const env={NODE_ENV:"development",CHARMVILLE_FAMILY_OPENING_VERSION:FAMILY_ENTITLEMENT_VERSION};
const token="c".repeat(64);
function request(body:unknown={accept:FAMILY_ENTITLEMENT_VERSION}, headers:Record<string,string>={}) {
  return new Request("http://localhost:3018/api/charmville/family/accept",{method:"POST",headers:{
    origin:"http://localhost:3018","content-type":"application/json",authorization:`Bearer ${token}`,...headers},body:JSON.stringify(body)});
}
test("family HTTP activation is explicit local-only, never inferred from client input",async()=>{
  for(const candidate of [{},{...env,NODE_ENV:"production"},{...env,NODE_ENV:"test"},{...env,CHARMVILLE_FAMILY_OPENING_VERSION:"1"}]) {
    assert.equal(familyAcceptanceEnabled(candidate),false);
    await assert.rejects(readFamilyAcceptance(request(),candidate),/not available/);
  }
  assert.equal(await readFamilyAcceptance(request(),env),token);
});
test("family request rejects cross-origin, missing authentication and supplied reward authority",async()=>{
  for(const headers of [{origin:"https://evil.example"},{origin:"null"},{"sec-fetch-site":"cross-site"}])
    await assert.rejects(readFamilyAcceptance(request(undefined,headers),env),/signed-in/);
  await assert.rejects(readFamilyAcceptance(request(undefined,{authorization:""}),env),/Sign in/);
  for(const payload of [null,[],{}, {accept:"other"},{accept:FAMILY_ENTITLEMENT_VERSION,quantity:999},
    {accept:FAMILY_ENTITLEMENT_VERSION,profileId:"1"},{accept:FAMILY_ENTITLEMENT_VERSION,enabled:true}])
    await assert.rejects(readFamilyAcceptance(request(payload),env),/current family/);
  await assert.rejects(readFamilyAcceptance(request("x".repeat(600)),env),/too large/);
  await assert.rejects(readFamilyAcceptance(request(undefined,{"content-type":"text/plain"}),env),/Send a family/);
});
