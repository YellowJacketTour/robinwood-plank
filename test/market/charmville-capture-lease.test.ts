// Explicit approved test admission; production policy remains fail-closed.
process.env.CHARMVILLE_ACCESS_MODE='private';
process.env.CHARMVILLE_ALLOWED_WALLETS='0x1111111111111111111111111111111111111111';
import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import crypto,{randomUUID} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import type {Pool} from 'pg';
import {captureCreature} from '../../lib/charmville/capture';
import manifest from '../../lib/charmville/geometry/native-adventure-d4-s63.json';

// Application-path coverage without a database. PostgreSQL locking and timestamp
// behavior are exercised separately by charmville-capture.test.ts when configured.
function fixture(){
 const encounterId=randomUUID(),partnerId=randomUUID();
 const statements:string[]=[];
 let receipt:unknown=null;
 const query=async(sql:string,args:unknown[]=[])=>{
  statements.push(sql);
  let rows:unknown[]=[];
  if(sql.includes('FROM plankspace_wallet_sessions'))rows=[{id:'1'}];
  else if(sql.includes('SELECT wallet FROM plankspace_profiles'))rows=[{wallet:'0x1111111111111111111111111111111111111111'}];
  else if(sql.includes('to_regclass'))rows=[{present:null}];
  else if(sql.includes('SELECT COALESCE'))rows=[{qty:'0'}];
  else if(sql.includes('FROM charmville_capture_receipts'))rows=receipt?[receipt]:[];
  else if(sql.includes('FROM charmville_capture_supply'))rows=[{balls:3}];
  else if(sql.includes('FROM charmville_world_presence'))rows=[{owner:null,active:true}];
  else if(sql.includes('FROM charmville_native_actors'))rows=[{x:3,y:9,region_id:'public:meadow',geometry_revision:manifest.revision,region_epoch:1}];
  else if(sql.includes('FROM charmville_encounters'))rows=[{id:encounterId,hp:12,max_hp:14,hp_iv:2,level:2,species_id:286,live:true,controller_id:'1',mode:'world',geometry_revision:manifest.revision,statuses:[],revision:'7'}];
  else if(sql.includes('FROM charmville_wild_combat'))rows=[{controller_id:'1',partner_id:partnerId,pp:35,turn:0,attack_iv:0,defense_iv:0,speed_iv:0}];
  else if(sql.includes('SELECT v.*,e.source_species_id'))rows=[{creature_id:partnerId,source_species_id:277,level:5,hp:20,defense_iv:0}];
  else if(sql.startsWith('INSERT INTO charmville_capture_receipts'))receipt={payload_hash:args[2],result:JSON.parse(String(args[3]))};
  else if(!/^(BEGIN|COMMIT|ROLLBACK|UPDATE|INSERT|SELECT pg_advisory)/.test(sql)&&!sql.includes('FROM charmville_creature_entities'))throw new Error(`Unhandled fixture query: ${sql}`);
  return {rows,rowCount:rows.length};
 };
 return {pool:{connect:async()=>({query,release(){}})} as unknown as Pool,statements,command:{action:'throw',requestId:randomUUID(),encounterId,revision:'7',actorEpoch:1}};
}

test('committed failed capture renews the lease; receipt replay never renews or spends again',async()=>{
 const f=fixture();const rng=mock.method(crypto,'randomInt',((max:number)=>max-1) as typeof crypto.randomInt);syncBuiltinESMExports();
 try{
  const result=await captureCreature(f.pool,'a'.repeat(64),f.command);
  assert.equal(result.captured,false);assert.equal(result.balls,2);
  const settlement=f.statements.find(sql=>sql.startsWith('UPDATE charmville_encounters SET revision=revision+1'));
  assert.match(settlement!,/lease_until=CASE WHEN captured THEN NULL ELSE clock_timestamp\(\)\+interval '90 seconds' END/);
  const before=f.statements.length;
  assert.deepEqual(await captureCreature(f.pool,'a'.repeat(64),f.command),result);
  assert.equal(f.statements.slice(before).some(sql=>sql.startsWith('UPDATE')),false);
  await assert.rejects(captureCreature(f.pool,'a'.repeat(64),{...f.command,actorEpoch:2}),/already used/);
  assert.equal(f.statements.at(-1),'ROLLBACK');
 }finally{rng.mock.restore();syncBuiltinESMExports();}
});

test('successful capture clears custody reservation before common turn settlement',async()=>{
 const f=fixture();const rng=mock.method(crypto,'randomInt',(()=>0) as typeof crypto.randomInt);syncBuiltinESMExports();
 try{
  const result=await captureCreature(f.pool,'a'.repeat(64),f.command);
  assert.equal(result.captured,true);assert.equal(result.creatureId,f.command.encounterId);
  const end=f.statements.findIndex(sql=>sql.includes('SET captured=true,controller_id=NULL,lease_until=NULL'));
  const settle=f.statements.findIndex(sql=>sql.startsWith('UPDATE charmville_encounters SET revision=revision+1'));
  assert.ok(end>=0&&settle>end);assert.match(f.statements[settle],/WHEN captured THEN NULL/);
  assert.equal(f.statements.at(-1),'COMMIT');
 }finally{rng.mock.restore();syncBuiltinESMExports();}
});
