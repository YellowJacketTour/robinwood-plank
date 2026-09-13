import type {Pool} from 'pg';
import {homeActor} from './home-access-store';
import {requireCharmvilleAdmission} from './admission';
import {YardError} from './errors';
import type {BroadcastAuthority} from './broadcast-session';

/** Server-only resolver. The gateway supplies its connection-bound session token;
 * neither profile identity nor viewing policy is accepted from a wire message.
 * A fresh transaction is required for every authorization, including renewals.
 */
export async function broadcastAuthority(pool:Pool,token:string,ownerId:string):Promise<BroadcastAuthority>{
 if(!/^[1-9]\d{0,17}$/.test(ownerId))throw new YardError('Invalid broadcast owner',400);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const profileId=await homeActor(client,token);
  const owner=await client.query("SELECT id FROM plankspace_profiles WHERE id=$1 AND moderation_status='approved' FOR SHARE",[ownerId]);
  if(!owner.rowCount)throw new YardError('Broadcast owner unavailable',404);
  await requireCharmvilleAdmission(client,ownerId);
  const result=await client.query('SELECT mode,allowed_ids::text[] AS allowed,revision::text FROM charmville_spectator_settings WHERE profile_id=$1 FOR SHARE',[ownerId]);
  const policy=result.rows[0]??{mode:'public',allowed:[],revision:'0'};
  if(!['public','private','allowlist'].includes(policy.mode)||!Array.isArray(policy.allowed)||!policy.allowed.every((id:unknown)=>typeof id==='string')||!/^\d{1,18}$/.test(policy.revision))throw new YardError('Viewing policy unavailable',503);
  await client.query('COMMIT');
  return {profileId,ownerId,revision:policy.revision,mode:policy.mode,allowedIds:policy.allowed};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
