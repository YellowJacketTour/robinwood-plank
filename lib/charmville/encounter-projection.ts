import type {PoolClient} from "pg";
/** Read-only audience projection. One controller fights; witnesses gain no commands. */
export async function encounterProjection(c:PoolClient,encounterId:string,region:string,revision:string,owner:string|null){
 if(!(await c.query("SELECT to_regclass('charmville_battle_events') AS present")).rows[0].present)return {participants:[],events:[]};
 const rows=(await c.query(`SELECT p.id::text AS "profileId",p.handle,a.x,a.y,e.id AS creature,e.source_species_id AS species,v.hp,v.max_hp
 FROM charmville_world_presence w JOIN plankspace_profiles p ON p.id=w.profile_id JOIN charmville_native_actors a ON a.profile_id=p.id
 LEFT JOIN charmville_wild_combat b ON b.encounter_id=$1 AND b.controller_id=p.id
 LEFT JOIN charmville_encounters fight ON fight.id=$1 AND fight.controller_id=p.id AND fight.lease_until>clock_timestamp()
 LEFT JOIN charmville_creature_entities e ON e.id=b.partner_id AND fight.id IS NOT NULL
 LEFT JOIN charmville_creature_vitals v ON v.creature_id=e.id
 WHERE p.moderation_status='approved' AND w.expires_at>clock_timestamp() AND w.home_owner_id IS NOT DISTINCT FROM $4::bigint
 AND a.region_id=$2 AND a.geometry_revision=$3 AND ((a.x-4)*(a.x-4)+(a.y-9)*(a.y-9))<=6.25
 AND (w.home_owner_id IS NULL OR w.home_owner_id=w.profile_id OR EXISTS(SELECT 1 FROM charmville_home_grants g WHERE g.owner_profile_id=w.home_owner_id AND g.visitor_profile_id=w.profile_id AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND 'visit'=ANY(g.rights)))
 ORDER BY (fight.id IS NOT NULL) DESC,p.id LIMIT 16`,[encounterId,region,revision,owner])).rows;
 const participants=rows.map(r=>({profileId:r.profileId,handle:r.handle,cell:{x:r.x,y:r.y},boundCreature:r.creature?{id:r.creature,speciesId:r.species,hp:r.hp,maxHp:r.max_hp,statuses:[]}:null}));
 const events=(await c.query("SELECT id::text AS \"eventId\",turn::text,actor_profile_id::text AS \"actorProfileId\",log,created_at AS \"createdAt\" FROM charmville_battle_events WHERE encounter_id=$1 AND actor_profile_id=ANY($2::bigint[]) ORDER BY id DESC LIMIT 16",[encounterId,participants.map(p=>p.profileId)])).rows.reverse().map(r=>({...r,turn:Number(r.turn),createdAt:r.createdAt.toISOString()}));
 return {participants,events};
}
