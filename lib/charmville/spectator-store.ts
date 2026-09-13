import {requireCharmvilleViewer} from './admission-viewer';
import {requireCharmvilleAdmission} from './admission';
import type {Pool} from 'pg';
import {homeActor} from './home-access-store';
import {YardError} from './errors';
import {parseSpectatorPolicy,canSpectate} from './spectator-policy';
export async function spectatorView(pool:Pool,handle:string,token:string,raw?:unknown){
 if(!/^[a-z0-9_]{1,40}$/.test(handle))throw new YardError('Profile not found',404);
 const c=await pool.connect();try{
  await c.query('BEGIN');
  await requireCharmvilleViewer(c,token);
  const viewerId=token?await homeActor(c,token):null;
  const profile=(await c.query("SELECT id::text FROM plankspace_profiles WHERE handle=$1 AND moderation_status='approved'",[handle])).rows[0];
  if(!profile)throw new YardError('Profile not found',404);
  const ownerId=profile.id;
  await requireCharmvilleAdmission(c,ownerId);
  if(raw!==undefined){
   if(viewerId!==ownerId)throw new YardError('Only the player can change viewing permissions',403);
   const policy=parseSpectatorPolicy(raw);
   const revision=(raw as {revision?:unknown}).revision;
   if(typeof revision!=='string'||!/^\d{1,18}$/.test(revision))throw new YardError('Refresh viewing settings',400);
   await c.query('INSERT INTO charmville_spectator_settings(profile_id) VALUES($1) ON CONFLICT DO NOTHING',[ownerId]);
   const before=(await c.query('SELECT revision::text FROM charmville_spectator_settings WHERE profile_id=$1 FOR UPDATE',[ownerId])).rows[0];
   if(before.revision!==revision)throw new YardError('Viewing settings changed. Refresh before saving.',409);
   const permitted=await c.query("SELECT id::text FROM plankspace_profiles WHERE handle=ANY($1::text[]) AND moderation_status='approved'",[policy.allowedHandles]);
   if(permitted.rowCount!==policy.allowedHandles.length)throw new YardError('One or more allowed profiles were not found',400);
   await c.query('UPDATE charmville_spectator_settings SET mode=$2,allowed_ids=$3::bigint[],revision=revision+1,updated_at=clock_timestamp() WHERE profile_id=$1',[ownerId,policy.mode,permitted.rows.map(p=>p.id)]);
  }
  const settings=(await c.query('SELECT mode,allowed_ids::text[] AS allowed,revision::text FROM charmville_spectator_settings WHERE profile_id=$1 FOR SHARE',[ownerId])).rows[0]??{mode:'public',allowed:[],revision:'0'};
  const permitted=canSpectate({ownerId,viewerId,mode:settings.mode,allowedIds:settings.allowed});
  if(!permitted){await c.query('COMMIT');return {access:'restricted',online:false,actor:null};}
  const allowedHandles=viewerId===ownerId?(await c.query('SELECT handle FROM plankspace_profiles WHERE id=ANY($1::bigint[]) ORDER BY handle',[settings.allowed])).rows.map(p=>p.handle):undefined;
  await c.query('COMMIT');
  return {access:'allowed',online:false,mode:settings.mode,actor:null,...(viewerId===ownerId?{owner:true,revision:settings.revision,allowedHandles}:{})};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
