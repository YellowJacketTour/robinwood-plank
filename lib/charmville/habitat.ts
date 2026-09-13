import type {PoolClient} from 'pg';import {randomInt,randomUUID} from 'node:crypto';import {maxHp} from './creature-stats';
export const HABITAT_SPAWN_LIMIT=12;
/** region_id is the current routing slot; origin_region_id preserves archived provenance. */
export async function habitatRefresh(c:PoolClient,region:string,geometry:string){
 if(!(await c.query("SELECT to_regclass('charmville_habitat_budget') AS present")).rows[0].present)return null;
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`habitat:${region}`]);
 await c.query('INSERT INTO charmville_habitat_budget(region_id) VALUES($1) ON CONFLICT DO NOTHING',[region]);
 let budget=(await c.query('SELECT *,clock_timestamp() AS now FROM charmville_habitat_budget WHERE region_id=$1 FOR UPDATE',[region])).rows[0];
 let e=(await c.query('SELECT * FROM charmville_encounters WHERE region_id=$1 FOR UPDATE',[region])).rows[0];
 if(!e)return null;
 const now=budget.now.getTime();let readyAt:number|null=null;
 if(e.hp===0||e.captured){
  readyAt=Math.max(new Date(e.terminal_at).getTime()+60000,budget.spawn_count>=HABITAT_SPAWN_LIMIT?new Date(budget.window_started_at).getTime()+3600000:0);
  if(now>=readyAt){
   if(now>=new Date(budget.window_started_at).getTime()+3600000)budget=(await c.query('UPDATE charmville_habitat_budget SET spawn_count=1,window_started_at=clock_timestamp() WHERE region_id=$1 RETURNING *,clock_timestamp() AS now',[region])).rows[0];
   else await c.query('UPDATE charmville_habitat_budget SET spawn_count=spawn_count+1 WHERE region_id=$1',[region]);
   await c.query("UPDATE charmville_encounters SET region_id='archive:'||id::text,controller_id=NULL,lease_until=NULL,mode='world' WHERE id=$1",[e.id]);
   const iv=randomInt(32),hp=maxHp(286,2,iv,0);
   e=(await c.query('INSERT INTO charmville_encounters(id,region_id,geometry_revision,species_id,level,hp_iv,hp,max_hp) VALUES($1,$2,$3,286,2,$4,$5,$5) RETURNING *',[randomUUID(),region,geometry,iv,hp])).rows[0];readyAt=null;
  }
 }
 const current=(await c.query('SELECT spawn_count FROM charmville_habitat_budget WHERE region_id=$1',[region])).rows[0];
 return {serverNow:new Date(now).toISOString(),nextSpawnAt:readyAt===null?null:new Date(readyAt).toISOString(),spawnCount:current.spawn_count,spawnLimit:HABITAT_SPAWN_LIMIT,windowSeconds:3600,cooldownSeconds:60};
}
