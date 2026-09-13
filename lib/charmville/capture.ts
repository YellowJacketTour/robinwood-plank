import {createHash,randomInt} from 'node:crypto';
import type {Pool} from 'pg';
import {homeActor,requireHomeRight} from './home-access-store';
import {YardError} from './errors';
import {creatureVitals} from './creature-vitals';
import {ordinaryBallThreshold,captureShakes} from './capture-math';
import {combatStat,normalDamage} from './battle-math';
import {moveStats} from './move-stats';
import species from './species-stats.json';
import manifest from './geometry/native-adventure-d4-s63.json';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Provision caller must enforce the local-playtest request policy. No client RNG or reward quantities. */
export async function captureCreature(pool:Pool,token:string,raw?:unknown,allowProvision=false){
 await creatureVitals(pool,token);
 const c=await pool.connect();try{await c.query('BEGIN');const id=await homeActor(c,token);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`creature-vitals:${id}`]);
 const q=raw as Record<string,unknown>|undefined;
 if(q?.action==='provision'){
  if(!allowProvision||!(await c.query('SELECT 1 FROM charmville_local_playtest_accounts WHERE profile_id=$1',[id])).rowCount)throw new YardError('Test balls are available only to local sandbox profiles',403);
  await c.query('INSERT INTO charmville_capture_supply(profile_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
 }else if(q){
  if(q.action!=='throw'||!uuid.test(String(q.requestId))||!uuid.test(String(q.encounterId))||typeof q.revision!=='string'||!/^\d{1,18}$/.test(q.revision)||!Number.isInteger(q.actorEpoch)||Object.keys(q).some(k=>!['action','requestId','encounterId','revision','actorEpoch'].includes(k)))throw new YardError('Invalid capture request',400);
  const hash=createHash('sha256').update(JSON.stringify([q.encounterId,q.revision,q.actorEpoch])).digest('hex');const prior=(await c.query('SELECT * FROM charmville_capture_receipts WHERE profile_id=$1 AND request_id=$2',[id,q.requestId])).rows[0];
  if(prior){if(prior.payload_hash!==hash)throw new YardError('Request ID already used',409);await c.query('COMMIT');return prior.result;}
 }
 const supply=(await c.query('SELECT balls FROM charmville_capture_supply WHERE profile_id=$1 FOR UPDATE',[id])).rows[0];
 const p=(await c.query("SELECT home_owner_id::text AS owner,expires_at>clock_timestamp() AS active FROM charmville_world_presence WHERE profile_id=$1 FOR UPDATE",[id])).rows[0];
 let reason:string|null=null;if(!p?.active)reason='Enter the world first';
 if(p?.owner){if(!(await c.query("SELECT 1 FROM plankspace_profiles WHERE id=$1 AND moderation_status='approved'",[p.owner])).rowCount)throw new YardError('Home unavailable',403);await requireHomeRight(c,p.owner,id,'visit');}
 const region=p?.owner?`home:${p.owner}`:'public:meadow';const actor=(await c.query('SELECT * FROM charmville_native_actors WHERE profile_id=$1 FOR UPDATE',[id])).rows[0];
 if(!actor||actor.region_id!==region||actor.geometry_revision!==manifest.revision||Math.hypot(actor.x-4,actor.y-9)>2.5)reason='Move closer to the creature';
 const e=(await c.query('SELECT *,lease_until>clock_timestamp() AS live FROM charmville_encounters WHERE region_id=$1 FOR UPDATE',[region])).rows[0];
 if(!e||e.captured||e.hp<=0||!e.live||String(e.controller_id)!==id||!['turn','world'].includes(e.mode)||e.geometry_revision!==manifest.revision||e.statuses.length)reason='Approach a living creature';
 let w=e?(await c.query('SELECT * FROM charmville_wild_combat WHERE encounter_id=$1 FOR UPDATE',[e.id])).rows[0]:null;
 // Bind the first supported living party member only if no current controller binding exists.
 // Existing injured/fainted bindings are never silently swapped by a capture request.
 if(!reason&&(!w||String(w.controller_id)!==id||!w.partner_id)){
  const candidate=(await c.query('SELECT e.id,e.source_species_id FROM charmville_creature_entities e JOIN charmville_creature_slots s ON s.creature_id=e.id JOIN charmville_creature_vitals v ON v.creature_id=e.id WHERE e.owner_profile_id=$1 AND v.hp>0 AND e.source_species_id=ANY($2::integer[]) ORDER BY s.slot_index LIMIT 1',[id,[277,280,283,25,133,286]])).rows[0];
  if(candidate){
   const moves:Record<number,number>={277:1,280:10,283:33,25:98,133:33,286:33};const moveId=moves[candidate.source_species_id];
   await c.query('INSERT INTO charmville_creature_combat(creature_id,attack_iv,defense_iv,speed_iv,move_id,pp) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[candidate.id,randomInt(32),randomInt(32),randomInt(32),moveId,moveStats(moveId)!.pp]);
   await c.query('INSERT INTO charmville_wild_combat(encounter_id,attack_iv,defense_iv,speed_iv,pp) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[e.id,randomInt(32),randomInt(32),randomInt(32),moveStats(33)!.pp]);
   w=(await c.query('UPDATE charmville_wild_combat SET controller_id=$2,partner_id=$3 WHERE encounter_id=$1 RETURNING *',[e.id,id,candidate.id])).rows[0];
  }
 }
 const partner=w?.partner_id?(await c.query('SELECT v.*,e.source_species_id,c.defense_iv FROM charmville_creature_vitals v JOIN charmville_creature_entities e ON e.id=v.creature_id JOIN charmville_creature_combat c ON c.creature_id=e.id JOIN charmville_creature_slots s ON s.creature_id=e.id WHERE e.id=$1 AND e.owner_profile_id=$2 FOR UPDATE OF v',[w.partner_id,id])).rows[0]:null;
 if(!partner||String(w.controller_id)!==id||partner.hp<=0||w.pp<=0)reason='Bring a living supported party companion';
 if(!supply?.balls)reason='No test balls remaining';
 if(q?.action==='throw'){
  if(reason)throw new YardError(reason,409);if(q.encounterId!==e.id||q.revision!==String(e.revision)||q.actorEpoch!==Number(actor.region_epoch))throw new YardError('Encounter changed. Refresh first',409);
  const source=(species.species as Record<string,{catchRate:number;name:string}>)[e.species_id];if(!source)throw new YardError('Capture species unsupported',409);
  if((await c.query("SELECT to_regclass('charmville_creature_rest') AS present")).rows[0].present)await c.query("UPDATE charmville_creature_rest SET status='cancelled' WHERE profile_id=$1 AND status='pending'",[id]);
  const roll=captureShakes(ordinaryBallThreshold(source.catchRate,e.hp,e.max_hp).threshold,Array.from({length:4},()=>randomInt(65536)));
  let retaliation=null;
  if(roll.captured){
   await c.query("INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind) VALUES($1,$2,$3,$4,'capture')",[e.id,id,e.species_id,source.name]);
   await c.query('INSERT INTO charmville_creature_vitals(creature_id,level,hp_iv,hp_ev,hp,max_hp) VALUES($1,$2,$3,0,$4,$5)',[e.id,e.level,e.hp_iv,e.hp,e.max_hp]);
   await c.query('INSERT INTO charmville_creature_combat(creature_id,attack_iv,defense_iv,speed_iv,move_id,pp) VALUES($1,$2,$3,$4,33,$5)',[e.id,w.attack_iv,w.defense_iv,w.speed_iv,w.pp]);
   await c.query("UPDATE charmville_encounters SET captured=true,controller_id=NULL,lease_until=NULL,mode='world' WHERE id=$1",[e.id]);
  }else{
   const move=moveStats(33)!,miss=randomInt(100)>=move.accuracy,critical=!miss&&randomInt(16)===0;
   const damage=miss?0:normalDamage(e.level,combatStat(e.species_id,'baseAttack',e.level,w.attack_iv),combatStat(partner.source_species_id,'baseDefense',partner.level,partner.defense_iv),move.power,critical,100-randomInt(16));
   retaliation={actor:e.id,targetId:partner.creature_id,actorSpeciesId:e.species_id,speciesId:e.species_id,actorCell:{x:4,y:9},moveId:33,actionKind:'capture',move:move.name,damage,appliedDamage:Math.min(partner.hp,damage),critical,miss};
   await c.query('UPDATE charmville_creature_vitals SET hp=GREATEST(0,hp-$2),revision=revision+1 WHERE creature_id=$1',[partner.creature_id,damage]);
   await c.query('UPDATE charmville_wild_combat SET pp=pp-1 WHERE encounter_id=$1',[e.id]);
  }
  await c.query('UPDATE charmville_wild_combat SET turn=turn+1 WHERE encounter_id=$1',[e.id]);await c.query('UPDATE charmville_encounters SET revision=revision+1 WHERE id=$1',[e.id]);await c.query('UPDATE charmville_capture_supply SET balls=balls-1 WHERE profile_id=$1',[id]);
  if(retaliation)await c.query('INSERT INTO charmville_battle_events(encounter_id,actor_profile_id,turn,log) VALUES($1,$2,$3,$4::jsonb)',[e.id,id,Number(w.turn)+1,JSON.stringify([retaliation])]);
  if((await c.query("SELECT to_regclass('charmville_capture_events') AS present")).rows[0].present)await c.query('INSERT INTO charmville_capture_events(encounter_id,actor_profile_id,event_id,actor_x,actor_y,target_x,target_y,captured,shakes) VALUES($1,$2,$3,$4,$5,4,9,$6,$7)',[e.id,id,q.requestId,actor.x,actor.y,roll.captured,roll.shakes]);
  const result={eventId:q.requestId,actorCell:{x:actor.x,y:actor.y},targetCell:{x:4,y:9},encounterId:e.id,...roll,creatureId:roll.captured?e.id:null,balls:supply.balls-1,revision:String(BigInt(e.revision)+1n),retaliation,storage:roll.captured?'owned-storage':null};
  const hash=createHash('sha256').update(JSON.stringify([q.encounterId,q.revision,q.actorEpoch])).digest('hex');await c.query('INSERT INTO charmville_capture_receipts VALUES($1,$2,$3,$4::jsonb)',[id,q.requestId,hash,JSON.stringify(result)]);await c.query('COMMIT');return result;
 }
 const canProvision=!supply&&!!(await c.query('SELECT 1 FROM charmville_local_playtest_accounts WHERE profile_id=$1',[id])).rowCount;
 await c.query('COMMIT');return {available:!reason,balls:supply?.balls??0,reason,canProvision};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
