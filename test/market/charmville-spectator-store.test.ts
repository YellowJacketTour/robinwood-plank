import {test} from 'node:test';import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';import {Pool} from 'pg';
import {spectatorView} from '../../lib/charmville/spectator-store';
test('spectator privacy enforces owner edits, allowlist identity and immediate read denial',{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;assert.ok(['localhost','127.0.0.1'].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString}),schema='spectator_'+randomUUID().replaceAll('-','');await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const name of ['090_plankspace_native.sql','142_charmville_spectator_settings.sql'])await pool.query(await readFile('deploy/inmotion/postgres/migrations/'+name,'utf8'));
  const tokens=['a'.repeat(64),'b'.repeat(64)];
  for(let i=0;i<2;i++){const wallet='0x'+String(i+1).repeat(40);await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved')",[wallet,'watch'+i]);await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash('sha256').update(tokens[i]).digest('hex'),wallet]);}
  assert.equal((await spectatorView(pool,'watch0','')).access,'allowed');
  await assert.rejects(spectatorView(pool,'watch0',tokens[1],{mode:'private',revision:'0'}),/Only the player/);
  await spectatorView(pool,'watch0',tokens[0],{mode:'allowlist',allowedHandles:['watch1'],revision:'0'});
  assert.equal((await spectatorView(pool,'watch0','')).access,'restricted');
  assert.equal((await spectatorView(pool,'watch0',tokens[1])).access,'allowed');
  await spectatorView(pool,'watch0',tokens[0],{mode:'private',revision:'1'});
  assert.equal((await spectatorView(pool,'watch0',tokens[1])).access,'restricted');
  assert.equal((await spectatorView(pool,'watch0',tokens[0])).access,'allowed');
  await assert.rejects(spectatorView(pool,'watch0',tokens[0],{mode:'public',revision:'1'}),/changed/);
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
