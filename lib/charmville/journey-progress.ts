import type {Pool} from 'pg';
import {homeActor} from './home-access-store';

export type JourneyProgress = {version:1;completed:string[]};

/** Read historical accomplishments, never infer them from spendable balances.
 * No grants or visits are synthesized. Keep source receipts if pruning is added.
 */
export async function journeyProgress(pool:Pool,token:string):Promise<JourneyProgress>{
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const id=await homeActor(c,token);
  const {rows}=await c.query<{key:string}>(`
   SELECT 'home.claimed' AS key WHERE EXISTS (
    SELECT 1 FROM charmville_receipts WHERE profile_id=$1 AND actor_profile_id=$1 AND action='claim'
   ) UNION ALL
   SELECT 'partner.chosen' WHERE EXISTS (
    SELECT 1 FROM charmville_companions WHERE owner_profile_id=$1
   ) UNION ALL
   SELECT 'home.soil.tilled' WHERE EXISTS (
    SELECT 1 FROM charmville_native_actions WHERE profile_id=$1 AND region_id='home:' || $1::text AND status='committed' AND kind='till'
   ) UNION ALL
   SELECT 'home.oran.planted' WHERE EXISTS (
    SELECT 1 FROM charmville_native_actions WHERE profile_id=$1 AND region_id='home:' || $1::text AND status='committed' AND kind='plant' AND crop_id='oran-berry'
   ) UNION ALL
   SELECT 'home.oran.watered' WHERE EXISTS (
    SELECT 1 FROM charmville_native_actions WHERE profile_id=$1 AND region_id='home:' || $1::text AND status='committed' AND kind='water' AND crop_id='oran-berry'
   ) UNION ALL
   SELECT 'home.oran.harvested' WHERE EXISTS (
    SELECT 1 FROM charmville_native_actions WHERE profile_id=$1 AND region_id='home:' || $1::text AND status='committed' AND kind='harvest' AND crop_id='oran-berry'
    AND result->'yield'->>'face'='oran-berry'
    AND CASE WHEN jsonb_typeof(result->'yield'->'quantity')='number'
      THEN (result->'yield'->>'quantity')::numeric>0 ELSE false END
   )`,[id]);
  await c.query('COMMIT');
  return {version:1,completed:rows.map(row=>row.key)};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
