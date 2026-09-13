import type {Pool} from "pg";
import {YardError} from "./errors";
import {homeActor} from "./home-access-store";
import {BURNING_HEART_CROP_ID} from "./native-crops";

import {FAMILY_ENTITLEMENT_VERSION,FAMILY_STARTER_SEEDS,type FamilyGiftStatus} from "./family-entitlement-contract";
export {FAMILY_ENTITLEMENT_VERSION,FAMILY_STARTER_SEEDS} from "./family-entitlement-contract";

/** Authenticated observation only. No source receipt or inventory writes. */
export async function familyGiftStatus(pool:Pool,token:string):Promise<FamilyGiftStatus> {
 const client=await pool.connect();
 try {
  await client.query("BEGIN");const profileId=await homeActor(client,token);
  if(!(await client.query("SELECT 1 FROM charmville_yards WHERE profile_id=$1",[profileId])).rowCount)throw new YardError("Claim your home first",409);
  const row=(await client.query(`SELECT e.created_at,COALESCE(s.qty,0)::text AS seeds
   FROM charmville_yards y LEFT JOIN charmville_family_entitlements e ON e.profile_id=y.profile_id AND e.version=$2
   LEFT JOIN charmville_seeds s ON s.profile_id=y.profile_id AND s.face_id=$3 WHERE y.profile_id=$1`,[profileId,FAMILY_ENTITLEMENT_VERSION,BURNING_HEART_CROP_ID])).rows[0];
  await client.query("COMMIT");return {available:true,version:FAMILY_ENTITLEMENT_VERSION,accepted:!!row.created_at,seedQuantity:FAMILY_STARTER_SEEDS,seeds:row.seeds,acceptedAt:row.created_at?.toISOString()??null};
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}

/** Internal foundation, not an API endpoint. The caller must resolve enabled
 * from trusted deployment/package policy, never from request JSON. Keep false
 * until native identity, artwork, inventory and social consumers are accepted.
 * Explicit family acceptance is required; never call from a read/poll path. */
export async function acceptFamilySeeds(pool: Pool, token: string, policy: {enabled: boolean} = {enabled: false}) {
  if (policy.enabled !== true) throw new YardError("Family opening is not available yet", 409);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const profileId = await homeActor(client, token);
    const home = await client.query("SELECT profile_id FROM charmville_yards WHERE profile_id=$1 FOR UPDATE", [profileId]);
    if (!home.rowCount) throw new YardError("Claim your home first", 409);
    const receipt = await client.query(`INSERT INTO charmville_family_entitlements
      (profile_id,version,seed_face,seed_quantity) VALUES ($1,$2,$3,$4)
      ON CONFLICT (profile_id,version) DO NOTHING RETURNING created_at`,
    [profileId,FAMILY_ENTITLEMENT_VERSION,BURNING_HEART_CROP_ID,FAMILY_STARTER_SEEDS]);
    if (receipt.rowCount) await client.query(`INSERT INTO charmville_seeds(profile_id,face_id,qty)
      VALUES ($1,$2,$3) ON CONFLICT (profile_id,face_id)
      DO UPDATE SET qty=charmville_seeds.qty+EXCLUDED.qty`, [profileId,BURNING_HEART_CROP_ID,FAMILY_STARTER_SEEDS]);
    // Return the original source receipt on replay, not a newly issued reward.
    const original = (await client.query(`SELECT version,seed_face AS "seedFace",
      seed_quantity AS "seedQuantity",created_at AS "acceptedAt"
      FROM charmville_family_entitlements WHERE profile_id=$1 AND version=$2`, [profileId,FAMILY_ENTITLEMENT_VERSION])).rows[0];
    await client.query("COMMIT");
    return {...original, acceptedAt: original.acceptedAt.toISOString()};
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
