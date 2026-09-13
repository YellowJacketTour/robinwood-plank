import {test} from "node:test";
import assert from "node:assert/strict";
import type {Pool} from "pg";
import {readYard} from "../../lib/charmville/store";
import {readExchange} from "../../lib/charmville/exchange";
import {searchPineReputation,parsePineSearch} from "../../lib/charmville/reputation-search";
import {spectatorView} from "../../lib/charmville/spectator-store";
import {broadcastAuthority} from "../../lib/charmville/broadcast-authority";

const wallet1="0x"+"1".repeat(40),wallet2="0x"+"2".repeat(40),token="a".repeat(64);
async function privateMode(work:()=>Promise<void>,allow="") {
  const keys=["CHARMVILLE_ACCESS_MODE","CHARMVILLE_ALLOWED_WALLETS","CHARMVILLE_ADMIN_WALLETS"] as const;
  const previous=keys.map(key=>process.env[key]);
  process.env.CHARMVILLE_ACCESS_MODE="private";process.env.CHARMVILLE_ALLOWED_WALLETS=allow;process.env.CHARMVILLE_ADMIN_WALLETS="";
  try {await work();} finally {keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];});}
}
function fixture() {
  const calls:Array<{sql:string;args:unknown[]}> = [];
  const client={query:async(sql:string,args:unknown[]=[])=>{
    calls.push({sql,args});
    if(sql==="ROLLBACK"||sql.startsWith("BEGIN"))return {rows:[],rowCount:0};
    if(sql.includes("plankspace_wallet_sessions"))return {rows:[{id:"1"}],rowCount:1};
    if(sql.startsWith("SELECT wallet FROM plankspace_profiles"))return {rows:[{wallet:args[0]==="1"?wallet1:wallet2}],rowCount:1};
    if(sql.includes("charmville_admission_grants"))return {rows:[],rowCount:0};
    if(sql.includes("SELECT id FROM plankspace_profiles WHERE id=$1"))return {rows:[{id:"2"}],rowCount:1};
    if(sql.includes("SELECT id::text FROM plankspace_profiles WHERE handle=$1"))return {rows:[{id:"2"}],rowCount:1};
    throw Error("Unauthorized game data query reached");
  },release:()=>{}};
  return {calls,pool:{connect:async()=>client} as unknown as Pool};
}

test("previously public game reads deny uninvited viewers inside their own transaction",async()=>{
  await privateMode(async()=>{
    const readers=[
      (pool:Pool)=>readYard(pool,"friend",token),
      (pool:Pool)=>readExchange(pool,token),
      (pool:Pool)=>searchPineReputation(pool,parsePineSearch(new URLSearchParams()),token),
      (pool:Pool)=>spectatorView(pool,"friend",token),
    ];
    for(const read of readers) {
      const {pool,calls}=fixture();
      await assert.rejects(read(pool),/invite-only/);
      assert.match(calls[0].sql,/^BEGIN/);assert.equal(calls.at(-1)?.sql,"ROLLBACK");
      assert.ok(calls.some(call=>call.sql.includes("charmville_admission_grants")));
    }
  });
});

test("admitted viewers cannot resolve revoked hosts' spectator or broadcast policies",async()=>{
  await privateMode(async()=>{
    for(const resolve of [(pool:Pool)=>spectatorView(pool,"friend",token),(pool:Pool)=>broadcastAuthority(pool,token,"2")]) {
      const {pool,calls}=fixture();
      await assert.rejects(resolve(pool),/invite-only/);
      assert.ok(calls.some(call=>call.sql.includes("charmville_admission_grants")&&call.args[0]==="2"));
      assert.ok(!calls.some(call=>call.sql.includes("charmville_spectator_settings")));
    }
  },wallet1);
});
