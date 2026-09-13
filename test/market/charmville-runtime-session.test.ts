import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {RUNTIME_SESSION_COOKIE,runtimeSessionCookie,runtimeTicketFromRequest,issueRuntimeSession,renewRuntimeSession,requireRuntimeSession} from "../../lib/charmville/runtime-session";
const token="a".repeat(64);
const request=(ticket=token)=>new Request("https://example.test/charmville/runtime/play/",{headers:{cookie:`${RUNTIME_SESSION_COOKIE}=${ticket}`}});

test("native ticket cookies are scoped, HttpOnly, strict and secure except explicit development",()=>{
  const cookie=runtimeSessionCookie(token,{NODE_ENV:"production"});
  for(const attribute of ["Path=/charmville/runtime/","Max-Age=600","HttpOnly","SameSite=Strict","Secure"])assert.ok(cookie.includes(attribute));
  assert.ok(!cookie.includes("Domain="));
  assert.ok(runtimeSessionCookie(token,{}).includes("Secure"));
  assert.ok(!runtimeSessionCookie(token,{NODE_ENV:"development"}).includes("Secure"));
  assert.throws(()=>runtimeSessionCookie(`${token}; injected=x`));
});

test("runtime cookie parsing rejects ambiguity and never accepts a URL token",()=>{
  assert.equal(runtimeTicketFromRequest(request()),token);
  assert.throws(()=>runtimeTicketFromRequest(new Request(`https://example.test/?ticket=${token}`)));
  assert.throws(()=>runtimeTicketFromRequest(new Request("https://example.test",{headers:{cookie:`${RUNTIME_SESSION_COOKIE}=${token}; ${RUNTIME_SESSION_COOKIE}=${token}`}})));
  assert.throws(()=>runtimeTicketFromRequest(request("%61".repeat(64))));
});

test("closed mode rejects before DB access and invalid tickets cannot reach admission",async()=>{
  const pool={query:async()=>{throw Error("unexpected database access");},connect:async()=>{throw Error("unexpected connection");}} as unknown as Pool;
  await assert.rejects(issueRuntimeSession(pool,token,{NODE_ENV:"production"}),/closed/);
  await assert.rejects(requireRuntimeSession(pool,request(),{NODE_ENV:"production"}),/closed/);
  const missing={query:async()=>({rows:[]})} as unknown as Pool;
  await assert.rejects(requireRuntimeSession(missing,request(),{CHARMVILLE_ACCESS_MODE:"private"}),/expired/);
});

test("runtime ticket lookup revalidates current admission after session validation",async()=>{
  const calls:string[]=[];
  const db={query:async(sql:string)=>{
    calls.push(sql);
    if(sql.includes("charmville_runtime_sessions"))return {rows:[{id:"42"}]};
    if(sql.includes("plankspace_profiles"))return {rows:[{wallet:"0x"+"a".repeat(40)}]};
    return {rows:[],rowCount:0};
  }} as unknown as Pool;
  await assert.rejects(requireRuntimeSession(db,request(),{CHARMVILLE_ACCESS_MODE:"private"}),/invite-only/);
  assert.equal(calls.length,3);
  assert.match(calls[0],/s.expires_at::timestamptz>clock_timestamp\(\)/);
  assert.match(calls[0],/p.id=t.profile_id/);
});

test("renewal retains the existing cookie, matches its original session and never allocates another ticket",async()=>{
  for(const matches of [true,false]) {
    const calls:string[]=[],expiresAt=new Date(Date.now()+600000);
    const wallet="0x"+"e".repeat(40),env={CHARMVILLE_ACCESS_MODE:"private",CHARMVILLE_ALLOWED_WALLETS:wallet};
    const client={query:async(sql:string,args:unknown[]=[])=>{
      calls.push(sql);
      if(sql.startsWith("BEGIN")||sql==="COMMIT"||sql==="ROLLBACK")return {rows:[],rowCount:0};
      if(sql.includes("FOR UPDATE OF s"))return {rows:[{id:"42"}],rowCount:1};
      if(sql.startsWith("SELECT wallet"))return {rows:[{wallet}],rowCount:1};
      if(sql.startsWith("UPDATE charmville_runtime_sessions")) {
        assert.match(sql,/t.session_hash=\$2 AND t.profile_id=\$3/);
        assert.match(sql,/LEAST\(s.expires_at::timestamptz,clock_timestamp\(\)\+interval '10 minutes'\)/);
        assert.match(sql,/t.expires_at>clock_timestamp\(\)/);
        assert.equal(args[2],"42");
        return {rows:matches?[{expires_at:expiresAt}]:[],rowCount:matches?1:0};
      }
      throw Error("Unexpected renewal query");
    },release:()=>{}};
    const pool={connect:async()=>client} as unknown as Pool;
    if(matches) {
      const renewed=await renewRuntimeSession(pool,"b".repeat(64),request(token),env);
      assert.deepEqual(renewed,{ticket:token,expiresAt:expiresAt.toISOString()});
    } else await assert.rejects(renewRuntimeSession(pool,"b".repeat(64),request(token),env),/another account/);
    assert.ok(!calls.some(sql=>sql.startsWith("INSERT")));
  }
});

test("runtime ticket PostgreSQL issuance, expiry, original-session revocation and admission revocation",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
  const url=new URL(process.env.CHARMVILLE_TEST_DATABASE_URL!);assert.ok(["localhost","127.0.0.1"].includes(url.hostname));
  const admin=new Pool({connectionString:url.href});const schema=`runtime_test_${randomUUID().replaceAll("-","")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:url.href,options:`-c search_path=${schema}`});
  try {
    for(const f of ["090_plankspace_native.sql","144_charmville_private_admission.sql","146_charmville_runtime_sessions.sql"])
      await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,"utf8"));
    const wallet="0x"+"f".repeat(40),sessionHash=createHash("sha256").update(token).digest("hex");
    const id=(await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,'runtime_guest','Guest','approved') RETURNING id::text",[wallet])).rows[0].id;
    await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)",[sessionHash,wallet,new Date(Date.now()+3600000).toISOString()]);
    await pool.query("INSERT INTO charmville_admission_grants(profile_id,expires_at) VALUES($1,clock_timestamp()+interval '1 day')",[id]);
    const env={NODE_ENV:"production",CHARMVILLE_ACCESS_MODE:"private"};
    const issued=await issueRuntimeSession(pool,token,env);assert.match(issued.ticket,/^[a-f0-9]{64}$/);
    const stored=(await pool.query("SELECT ticket_hash,expires_at<=created_at+interval '10 minutes' AS bounded FROM charmville_runtime_sessions")).rows[0];
    assert.notEqual(stored.ticket_hash,issued.ticket);assert.equal(stored.bounded,true);
    assert.equal((await requireRuntimeSession(pool,request(issued.ticket),env)).profileId,id);
    const renewed=await renewRuntimeSession(pool,token,request(issued.ticket),env);
    assert.equal(renewed.ticket,issued.ticket);
    assert.equal((await pool.query("SELECT count(*)::integer AS count FROM charmville_runtime_sessions")).rows[0].count,1);
    await pool.query("UPDATE charmville_admission_grants SET revoked_at=clock_timestamp() WHERE profile_id=$1",[id]);
    await assert.rejects(requireRuntimeSession(pool,request(issued.ticket),env),/invite-only/);
    await assert.rejects(renewRuntimeSession(pool,token,request(issued.ticket),env),/invite-only/);
    await pool.query("UPDATE charmville_admission_grants SET revoked_at=NULL WHERE profile_id=$1",[id]);
    await pool.query("UPDATE plankspace_wallet_sessions SET expires_at='2000-01-01' WHERE token_hash=$1",[sessionHash]);
    await assert.rejects(requireRuntimeSession(pool,request(issued.ticket),env),/expired/);
    await assert.rejects(renewRuntimeSession(pool,token,request(issued.ticket),env),/expired/);
    await pool.query("DELETE FROM plankspace_wallet_sessions WHERE token_hash=$1",[sessionHash]);
    assert.equal((await pool.query("SELECT count(*)::integer AS count FROM charmville_runtime_sessions")).rows[0].count,0);
  } finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
