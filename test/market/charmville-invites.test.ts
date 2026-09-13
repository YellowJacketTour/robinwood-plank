import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {parseInviteCommand,parseInviteRedemption,manageCharmvilleInvites,redeemCharmvilleInvite} from "../../lib/charmville/invites";

test("invitation command bounds prevent unlimited grants and ambiguous account targets",()=>{
  assert.deepEqual(parseInviteCommand({action:"create"}),{action:"create",inviteHours:24,accessDays:30});
  for(const raw of [null,[],{action:"create",inviteHours:169},{action:"create",accessDays:91},{action:"create",accessDays:"30"},{action:"create",recipientHandle:"*"},{action:"revoke",inviteId:"bad"},{action:"revokeGrant",profileId:"0"}])
    assert.throws(()=>parseInviteCommand(raw));
  assert.equal(parseInviteCommand({action:"revoke",inviteId:randomUUID()}).action,"revoke");
});

test("invitation secrets require exact token bodies instead of arbitrary URLs or objects",()=>{
  const token="a".repeat(64);
  assert.equal(parseInviteRedemption({inviteToken:token}),token);
  for(const raw of [null,[],{inviteToken:`https://example.com/${token}`},{inviteToken:token+"x"},{inviteToken:42}])assert.throws(()=>parseInviteRedemption(raw));
});

test("closed deployment does not inspect tokens or write invitations",async()=>{
  const statements:string[]=[];
  const pool={connect:async()=>({query:async(sql:string)=>{statements.push(sql);return {rows:[]};},release:()=>{}})} as unknown as Pool;
  await assert.rejects(manageCharmvilleInvites(pool,"a".repeat(64),{action:"create"},{NODE_ENV:"production"}),/closed/);
  await assert.rejects(redeemCharmvilleInvite(pool,"a".repeat(64),{inviteToken:"b".repeat(64)},{NODE_ENV:"production"}),/closed/);
  assert.deepEqual(statements,["BEGIN","ROLLBACK","BEGIN","ROLLBACK"]);
});

test("private invitations issue hashed, redeem once across accounts, replay without extending and honor revocation",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
  const url=new URL(process.env.CHARMVILLE_TEST_DATABASE_URL!);assert.ok(["localhost","127.0.0.1"].includes(url.hostname));
  const adminPool=new Pool({connectionString:url.href});const schema=`invite_test_${randomUUID().replaceAll("-","")}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:url.href,options:`-c search_path=${schema}`,max:6});
  try {
    for(const f of ["090_plankspace_native.sql","144_charmville_private_admission.sql","145_charmville_private_invites.sql"])
      await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,"utf8"));
    const adminWallet="0x"+"a".repeat(40),env={NODE_ENV:"production",CHARMVILLE_ACCESS_MODE:"private",CHARMVILLE_ADMIN_WALLETS:adminWallet};
    const tokens=["1".repeat(64),"2".repeat(64),"3".repeat(64)],ids:string[]=[];
    for(let n=0;n<3;n++) {
      const wallet=n===0?adminWallet:"0x"+String(n).repeat(40);
      ids.push((await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id::text",[wallet,`invite_actor_${n}`])).rows[0].id);
      await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)",[createHash("sha256").update(tokens[n]).digest("hex"),wallet,new Date(Date.now()+3600000).toISOString()]);
    }
    await assert.rejects(manageCharmvilleInvites(pool,tokens[1],{action:"create"},env));
    const invite=await manageCharmvilleInvites(pool,tokens[0],{action:"create"},env);
    assert.ok("inviteToken" in invite);
    if(!("inviteToken" in invite))throw new Error("Missing fixture invitation");
    const stored=(await pool.query("SELECT token_hash FROM charmville_admission_invites WHERE id=$1",[invite.inviteId])).rows[0].token_hash;
    assert.notEqual(stored,invite.inviteToken);assert.equal(stored,createHash("sha256").update(invite.inviteToken).digest("hex"));
    const command={inviteToken:invite.inviteToken};
    const race=await Promise.allSettled([1,2].map(n=>redeemCharmvilleInvite(pool,tokens[n],command,env)));
    assert.equal(race.filter(r=>r.status==="fulfilled").length,1);
    const winner=race.findIndex(r=>r.status==="fulfilled")+1;
    const first=race[winner-1];assert.equal(first.status,"fulfilled");if(first.status!=="fulfilled")throw Error("No winner");
    const retry=await redeemCharmvilleInvite(pool,tokens[winner],command,env);
    assert.equal(retry.alreadyRedeemed,true);assert.equal(retry.expiresAt,first.value.expiresAt);
    const list=await manageCharmvilleInvites(pool,tokens[0],undefined,env);
    assert.ok(!JSON.stringify(list).includes(invite.inviteToken));assert.ok(!JSON.stringify(list).includes(stored));
    await manageCharmvilleInvites(pool,tokens[0],{action:"revokeGrant",profileId:ids[winner]},env);
    await assert.rejects(redeemCharmvilleInvite(pool,tokens[winner],command,env),/revoked/);
    const revoked=await manageCharmvilleInvites(pool,tokens[0],{action:"create",recipientHandle:"invite_actor_1"},env);
    if(!("inviteToken" in revoked))throw Error("Missing token");
    await manageCharmvilleInvites(pool,tokens[0],{action:"revoke",inviteId:revoked.inviteId},env);
    await assert.rejects(redeemCharmvilleInvite(pool,tokens[1],{inviteToken:revoked.inviteToken},env),/unavailable/);
    const bound=await manageCharmvilleInvites(pool,tokens[0],{action:"create",recipientHandle:"invite_actor_1"},env);
    if(!("inviteToken" in bound))throw Error("Missing bound token");
    await assert.rejects(redeemCharmvilleInvite(pool,tokens[2],{inviteToken:bound.inviteToken},env),/unavailable/);
    assert.equal((await pool.query("SELECT redeemed_at FROM charmville_admission_invites WHERE id=$1",[bound.inviteId])).rows[0].redeemed_at,null);
    await assert.rejects(redeemCharmvilleInvite(pool,tokens[1],{inviteToken:bound.inviteToken},{...env,CHARMVILLE_ADMIN_WALLETS:""}));
    assert.equal((await pool.query("SELECT redeemed_at FROM charmville_admission_invites WHERE id=$1",[bound.inviteId])).rows[0].redeemed_at,null);
    // An invitation can expire while redemption waits for its row lock.
    await pool.query("UPDATE charmville_admission_invites SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",[bound.inviteId]);
    const locker=await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM charmville_admission_invites WHERE id=$1 FOR UPDATE",[bound.inviteId]);
      const waiting=assert.rejects(redeemCharmvilleInvite(pool,tokens[1],{inviteToken:bound.inviteToken},env),/expired/);
      await new Promise(resolve=>setTimeout(resolve,1200));
      await locker.query("COMMIT");await waiting;
    } finally {await locker.query("ROLLBACK");locker.release();}
    assert.equal((await pool.query("SELECT redeemed_at FROM charmville_admission_invites WHERE id=$1",[bound.inviteId])).rows[0].redeemed_at,null);
  } finally {await pool.end();await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);await adminPool.end();}
});
