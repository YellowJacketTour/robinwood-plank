import type {PoolClient} from 'pg';
import {experienceAtLevel,experienceLevel} from './experience';
import {maxHp} from './creature-stats';
import source from './species-stats.json';
export async function awardDefeat(c:PoolClient,encounterId:string,creatureId:string,assisted:boolean){
 if(!(await c.query("SELECT to_regclass('charmville_defeat_awards') AS present")).rows[0].present)return null;
 const prior=(await c.query('SELECT result FROM charmville_defeat_awards WHERE encounter_id=$1',[encounterId])).rows[0];if(prior)return prior.result;
 let result;
 if(assisted)result={reason:'party-allocation-pending',xpGained:0};
 else{
  const e=(await c.query('SELECT species_id,level,hp FROM charmville_encounters WHERE id=$1',[encounterId])).rows[0];if(!e||e.hp!==0)throw Error('Defeat not settled');
  const v=(await c.query('SELECT v.*,e.source_species_id AS species FROM charmville_creature_vitals v JOIN charmville_creature_entities e ON e.id=v.creature_id WHERE v.creature_id=$1 FOR UPDATE OF v',[creatureId])).rows[0];
  await c.query('INSERT INTO charmville_creature_experience VALUES($1,$2) ON CONFLICT DO NOTHING',[creatureId,experienceAtLevel(v.species,v.level)]);
  const previous=(await c.query('SELECT xp FROM charmville_creature_experience WHERE creature_id=$1 FOR UPDATE',[creatureId])).rows[0].xp;
  const yieldValue=(source.species as Record<string,{expYield:number}>)[e.species_id].expYield;
  const totalXp=Math.min(experienceAtLevel(v.species,100),previous+Math.max(1,Math.floor(yieldValue*e.level/7))),level=experienceLevel(v.species,totalXp);
  const maximum=maxHp(v.species,level,v.hp_iv,v.hp_ev),hp=v.hp===0?0:Math.max(1,maximum-(v.max_hp-v.hp));
  await c.query('UPDATE charmville_creature_experience SET xp=$2 WHERE creature_id=$1',[creatureId,totalXp]);
  await c.query('UPDATE charmville_creature_vitals SET level=$2,max_hp=$3,hp=$4,revision=revision+1 WHERE creature_id=$1',[creatureId,level,maximum,hp]);
  result={reason:'controller-finishing-strike',creatureId,xpGained:totalXp-previous,totalXp,previousLevel:v.level,level,nextLevelXp:level<100?experienceAtLevel(v.species,level+1):null};
 }
 await c.query('INSERT INTO charmville_defeat_awards VALUES($1,$2::jsonb)',[encounterId,JSON.stringify(result)]);return result;
}
