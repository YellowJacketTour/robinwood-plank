import {randomInt,createHash} from "node:crypto";
import type {Pool} from "pg";
import {homeActor,requireHomeRight} from "./home-access-store";
import {YardError} from "./errors";
import {creatureVitals} from "./creature-vitals";
import {moveStats} from "./move-stats";
import {combatStat,normalDamage} from "./battle-math";
import manifest from "./geometry/native-adventure-d4-s63.json";
const starterMoves:Record<number,number>={277:1,280:10,283:33,25:98,133:33,286:33};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function turnBattle(pool:Pool,token:string,raw?:unknown){await creatureVitals(pool,token);const c=await pool.connect();try{
 await c.query("BEGIN");const id=await homeActor(c,token);await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`creature-vitals:${id}`]);
 const p=(await c.query("SELECT home_owner_id::text AS owner,expires_at>clock_timestamp() AS active FROM charmville_world_presence WHERE profile_id=$1 FOR UPDATE",[id])).rows[0];if(!p?.active)throw new YardError("Enter the world",403);if(p.owner){if(!(await c.query("SELECT 1 FROM plankspace_profiles WHERE id=$1 AND moderation_status='approved'",[p.owner])).rowCount)throw new YardError("Home unavailable",403);await requireHomeRight(c,p.owner,id,"visit");}
 const region=p.owner?`home:${p.owner}`:"public:meadow",actor=(await c.query("SELECT * FROM charmville_native_actors WHERE profile_id=$1 FOR UPDATE",[id])).rows[0];
 if(!actor||actor.region_id!==region||actor.geometry_revision!==manifest.revision||Math.hypot(actor.x-4,actor.y-9)>2.5)throw new YardError("Move closer to the creature",409);
 let e=(await c.query("SELECT *,lease_until>clock_timestamp() AS live FROM charmville_encounters WHERE region_id=$1 FOR UPDATE",[region])).rows[0];if(!e||String(e.controller_id)!==id||!e.live||e.mode!=="turn"||e.geometry_revision!==manifest.revision)throw new YardError("Inspect this creature first",409);
 if(e.statuses.length)throw new YardError("Status effects are not supported by this battle subset",409);
 const owned=(await c.query("SELECT e.id,e.source_species_id AS species,v.level,v.hp,v.max_hp FROM charmville_creature_entities e JOIN charmville_creature_slots s ON s.creature_id=e.id JOIN charmville_creature_vitals v ON v.creature_id=e.id WHERE e.owner_profile_id=$1 AND e.acquisition_kind IN ('starter','local-playtest') ORDER BY e.id FOR UPDATE OF v",[id])).rows.filter(r=>starterMoves[r.species]);
 for(const r of owned)await c.query("INSERT INTO charmville_creature_combat VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",[r.id,randomInt(32),randomInt(32),randomInt(32),starterMoves[r.species],moveStats(starterMoves[r.species])!.pp]);
 await c.query("INSERT INTO charmville_wild_combat(encounter_id,attack_iv,defense_iv,speed_iv,pp) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",[e.id,randomInt(32),randomInt(32),randomInt(32),moveStats(33)!.pp]);
 let w=(await c.query("SELECT * FROM charmville_wild_combat WHERE encounter_id=$1 FOR UPDATE",[e.id])).rows[0];
 if(String(w.controller_id)!==id){w=(await c.query("UPDATE charmville_wild_combat SET controller_id=$2,partner_id=NULL WHERE encounter_id=$1 RETURNING *",[e.id,id])).rows[0];}
 let result:unknown=null;
 if(raw!==undefined){const q=raw as Record<string,unknown>|null;if(!q||!["attack","switch"].includes(String(q.action))||!uuid.test(String(q.requestId))||!uuid.test(String(q.creatureId))||typeof q.revision!=="string"||Object.keys(q).some(k=>!["action","requestId","encounterId","revision","actorEpoch","creatureId","moveId"].includes(k)))throw new YardError("Invalid attack",400);
 const hash=createHash("sha256").update(JSON.stringify([q.action,q.encounterId,q.revision,q.actorEpoch,q.creatureId,q.moveId])).digest("hex"),prior=(await c.query("SELECT * FROM charmville_battle_receipts WHERE profile_id=$1 AND request_id=$2",[id,q.requestId])).rows[0];
 if(prior){if(prior.payload_hash!==hash)throw new YardError("Request ID already used",409);result=prior.result;}
 else{if(q.encounterId!==e.id||q.revision!==String(e.revision)||q.actorEpoch!==Number(actor.region_epoch))throw new YardError("Battle changed. Refresh",409);const mon=owned.find(r=>r.id===q.creatureId);if(!mon||q.action==="attack"&&w.partner_id&&w.partner_id!==mon.id||q.action==="switch"&&w.partner_id===mon?.id)throw new YardError("Choose the bound owned starter",403);
 const stats=(await c.query("SELECT * FROM charmville_creature_combat WHERE creature_id=$1 FOR UPDATE",[mon.id])).rows[0];if(q.action==="attack"&&(q.moveId!==stats.move_id||stats.pp<=0)||mon.hp<=0||e.hp<=0||w.pp<=0)throw new YardError("This attack is unavailable",409);
 const log:{actor:string;move:string;damage:number;critical:boolean;miss:boolean}[]=[];
 const strike=(player:boolean)=>{if(mon.hp<=0||e.hp<=0)return;const move=moveStats(player?stats.move_id:33)!;if(player)stats.pp--;else w.pp--;const miss=randomInt(100)>=move.accuracy,critical=!miss&&randomInt(16)===0;const damage=miss?0:normalDamage(player?mon.level:e.level,combatStat(player?mon.species:e.species_id,"baseAttack",player?mon.level:e.level,player?stats.attack_iv:w.attack_iv),combatStat(player?e.species_id:mon.species,"baseDefense",player?e.level:mon.level,player?w.defense_iv:stats.defense_iv),move.power,critical,100-randomInt(16),player&&mon.species===133);if(player)e.hp=Math.max(0,e.hp-damage);else mon.hp=Math.max(0,mon.hp-damage);log.push({actor:player?mon.id:e.id,move:move.name,damage,critical,miss});};
 const speed= combatStat(mon.species,"baseSpeed",mon.level,stats.speed_iv)-combatStat(e.species_id,"baseSpeed",e.level,w.speed_iv);const priority=moveStats(stats.move_id)!.priority-moveStats(33)!.priority;const first=priority>0||priority===0&&(speed>0||speed===0&&randomInt(2)===0);if(q.action==="switch")strike(false);else{strike(first);strike(!first);}
 await c.query("UPDATE charmville_creature_vitals SET hp=$2,revision=revision+1 WHERE creature_id=$1",[mon.id,mon.hp]);await c.query("UPDATE charmville_creature_combat SET pp=$2 WHERE creature_id=$1",[mon.id,stats.pp]);await c.query("UPDATE charmville_wild_combat SET pp=$2,turn=turn+1,partner_id=$3 WHERE encounter_id=$1",[e.id,w.pp,mon.id]);
 e=(await c.query("UPDATE charmville_encounters SET hp=$2,revision=revision+1,lease_until=clock_timestamp()+interval '90 seconds' WHERE id=$1 RETURNING *",[e.id,e.hp])).rows[0];result={log};await c.query("INSERT INTO charmville_battle_receipts VALUES($1,$2,$3,$4::jsonb)",[id,q.requestId,hash,JSON.stringify(result)]);
 }}
 w=(await c.query("SELECT * FROM charmville_wild_combat WHERE encounter_id=$1",[e.id])).rows[0];
 const eligible=[];for(const r of owned){const v=(await c.query("SELECT v.hp,v.max_hp,c.move_id,c.pp FROM charmville_creature_vitals v JOIN charmville_creature_combat c ON c.creature_id=v.creature_id WHERE v.creature_id=$1",[r.id])).rows[0];eligible.push({id:r.id,speciesId:r.species,hp:v.hp,maxHp:v.max_hp,move:{id:v.move_id,name:moveStats(v.move_id)!.name,pp:v.pp,maxPp:moveStats(v.move_id)!.pp}});}
 const partner=eligible.find(r=>r.id===w.partner_id)??null;await c.query("COMMIT");return {encounterId:e.id,revision:String(e.revision),turn:Number(w.turn),partner,eligible,wild:{hp:e.hp,maxHp:e.max_hp},outcome:e.hp===0?"wild-fainted":partner?.hp===0?"partner-fainted":"active",result};
 }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}
