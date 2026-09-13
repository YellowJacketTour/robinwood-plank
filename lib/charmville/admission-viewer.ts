import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {charmvilleAdmissionMode,requireCharmvilleAdmission} from './admission';
import {YardError} from './errors';

/** Admission for previously public reads. Does not replace mutation authorization. */
export async function requireCharmvilleViewer(db:Pool|PoolClient,token:string) {
 const mode=charmvilleAdmissionMode();
 if(mode==='local-development')return;
 if(mode==='disabled')throw new YardError('Charmville testing is closed',403);
 if(!/^[a-f0-9]{64}$/i.test(token))throw new YardError('Sign in for private testing',401);
 const {rows}=await db.query(`SELECT p.id::text FROM plankspace_wallet_sessions s
 JOIN plankspace_profiles p ON lower(p.wallet)=lower(s.wallet)
 WHERE s.token_hash=$1 AND s.expires_at::timestamptz>clock_timestamp()
 AND p.moderation_status='approved'`,[createHash('sha256').update(token).digest('hex')]);
 if(!rows[0])throw new YardError('Sign in for private testing',401);
 await requireCharmvilleAdmission(db,rows[0].id);
}
