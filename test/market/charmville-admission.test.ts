import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { charmvilleAdmissionMode, requireCharmvilleAdmission } from "../../lib/charmville/admission";

const wallet="0x"+"a".repeat(40);
function fixture(approved=true, granted=false) {
  const calls:string[]=[];
  const db={query:async(sql:string,args:unknown[])=>{
    calls.push(sql); assert.deepEqual(args,["42"]);
    if(sql.includes("plankspace_profiles")) return {rows:approved?[{wallet}]:[],rowCount:approved?1:0};
    assert.match(sql,/revoked_at IS NULL AND expires_at>clock_timestamp\(\)/);
    return {rows:granted?[{}]:[],rowCount:granted?1:0};
  }} as unknown as PoolClient;
  return {db,calls};
}

test("private admission fails closed in production and malformed deployment modes",()=>{
  assert.equal(charmvilleAdmissionMode({NODE_ENV:"production"}),"disabled");
  assert.equal(charmvilleAdmissionMode({NODE_ENV:"test"}),"disabled");
  assert.equal(charmvilleAdmissionMode({NODE_ENV:"development"}),"local-development");
  for(const mode of ["public","enabled","local-development"])
    assert.equal(charmvilleAdmissionMode({NODE_ENV:"production",CHARMVILLE_ACCESS_MODE:mode}),"disabled");
  assert.equal(charmvilleAdmissionMode({NODE_ENV:"production",CHARMVILLE_ACCESS_MODE:"private"}),"private");
});

test("verified explicit admin and wallet allowlists authorize without grant-table dependencies",async()=>{
  for(const [key,role] of [["CHARMVILLE_ADMIN_WALLETS","admin"],["CHARMVILLE_ALLOWED_WALLETS","player"]]) {
    const f=fixture();
    const admitted=await requireCharmvilleAdmission(f.db,"42",{NODE_ENV:"production",CHARMVILLE_ACCESS_MODE:"private",[key]:wallet.toUpperCase()});
    assert.equal(admitted.role,role);assert.equal(admitted.wallet,wallet);assert.equal(f.calls.length,1);
  }
});

test("no global admin fallback, malformed lists do not partially authorize, absent grant rejects",async()=>{
  for(const env of [{PLANK_ADMIN_ADDRESSES:wallet},{CHARMVILLE_ADMIN_WALLETS:`${wallet},bad`}]) {
    const f=fixture();
    await assert.rejects(requireCharmvilleAdmission(f.db,"42",{NODE_ENV:"production",CHARMVILLE_ACCESS_MODE:"private",...env}),/invite-only/);
    assert.equal(f.calls.length,2);
  }
});

test("revocable expiring profile grants authorize only approved profiles",async()=>{
  const env={NODE_ENV:"production",CHARMVILLE_ACCESS_MODE:"private"};
  assert.equal((await requireCharmvilleAdmission(fixture(true,true).db,"42",env)).role,"player");
  await assert.rejects(requireCharmvilleAdmission(fixture(false,true).db,"42",{...env,CHARMVILLE_ADMIN_WALLETS:wallet}),/unavailable/);
  await assert.rejects(requireCharmvilleAdmission(fixture().db,"0",env),/Sign in/);
});

test("disabled deployment rejects before reading account data; development preserves approved accounts",async()=>{
  const f=fixture();
  await assert.rejects(requireCharmvilleAdmission(f.db,"42",{NODE_ENV:"production"}),/not open/);
  assert.equal(f.calls.length,0);
  const result=await requireCharmvilleAdmission(f.db,"42",{NODE_ENV:"development"});
  assert.equal(result.mode,"local-development");assert.equal(f.calls.length,1);
});

test("missing private grant schema never becomes an implicit admission",async()=>{
  const f=fixture();const query=f.db.query.bind(f.db);
  f.db.query=(async(sql:string,args:unknown[])=>{
    if(sql.includes("admission_grants")) throw new Error("missing grant schema");
    return query(sql,args);
  }) as typeof f.db.query;
  await assert.rejects(requireCharmvilleAdmission(f.db,"42",{CHARMVILLE_ACCESS_MODE:"private"}),/missing grant schema/);
});
