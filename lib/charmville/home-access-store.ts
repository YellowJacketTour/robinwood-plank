import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { YardError } from "./errors";
export const HOME_RIGHTS = ["visit", "help", "harvest", "build", "storage"] as const;
export type HomeRight = typeof HOME_RIGHTS[number];
export type HomeGrantInput = { visitor: string; revoke: boolean; rights: HomeRight[]; containers: string[]; expiresAt?: string; revision: string };
export function parseHomeGrant(raw: unknown): HomeGrantInput {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || typeof p.visitor !== "string" || !/^[a-z0-9_]{1,40}$/.test(p.visitor) || typeof p.revoke !== "boolean" || typeof p.revision !== "string" || !/^\d{1,18}$/.test(p.revision)) throw new YardError("Invalid home permission",400);
  if (p.revoke) return { visitor:p.visitor, revoke:true, rights:[], containers:[], revision:p.revision };
  if (!Array.isArray(p.rights) || p.rights.length > 5 || !p.rights.includes("visit") || !p.rights.every(r=>HOME_RIGHTS.includes(r)) || new Set(p.rights).size!==p.rights.length) throw new YardError("Choose valid home permissions",400);
  const containers = p.containers ?? [];
  if (!Array.isArray(containers) || containers.length > 32 || !containers.every(c=>typeof c==="string" && /^[a-zA-Z0-9_-]{1,64}$/.test(c)) || (p.rights.includes("storage") && !containers.length) || (!p.rights.includes("storage") && containers.length)) throw new YardError("Choose specific storage containers",400);
  if (typeof p.expiresAt!=="string" || !Number.isFinite(Date.parse(p.expiresAt))) throw new YardError("Choose an expiry",400);
  return { visitor:p.visitor,revoke:false,rights:p.rights,containers:[...new Set(containers)],expiresAt:new Date(p.expiresAt).toISOString(),revision:p.revision };
}
export async function homeActor(client: PoolClient, token: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new YardError("Sign in to access this home",401);
  const {rows}=await client.query(`SELECT p.id::text FROM plankspace_wallet_sessions s JOIN plankspace_profiles p ON lower(p.wallet)=lower(s.wallet) WHERE s.token_hash=$1 AND s.expires_at::timestamptz>clock_timestamp() AND p.moderation_status='approved' FOR SHARE OF s,p`,[createHash("sha256").update(token).digest("hex")]);
  if (!rows[0]) throw new YardError("Your session expired. Sign in again.",401);
  return rows[0].id;
}
// Call inside the same transaction as the world/economic mutation. The home row
// lock serializes contact with grant changes; never authorize from a cached GET.
export async function requireHomeRight(client: PoolClient, ownerId: string, actorId: string, right: HomeRight, containerId?: string) {
  if (!HOME_RIGHTS.includes(right)) throw new YardError("Invalid permission",400);
  const home=await client.query("SELECT profile_id FROM charmville_yards WHERE profile_id=$1 FOR UPDATE",[ownerId]);
  if (!home.rowCount) throw new YardError("Home not found",404);
  if(ownerId===actorId) return;
  const grant=await client.query(`SELECT 1 FROM charmville_home_grants WHERE owner_profile_id=$1 AND visitor_profile_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() AND 'visit'=ANY(rights) AND $3=ANY(rights) AND ($3<>'storage' OR $4=ANY(containers))`,[ownerId,actorId,right,containerId??null]);
  if(!grant.rowCount) throw new YardError("The owner has not granted this home permission",403);
}
export async function homeAccess(pool: Pool, handle: string, token: string, raw?: HomeGrantInput) {
 const client=await pool.connect();
 try {
  await client.query("BEGIN");
  const actorId=await homeActor(client,token);
  const home=await client.query(`SELECT p.id::text FROM plankspace_profiles p JOIN charmville_yards y ON y.profile_id=p.id WHERE p.handle=$1 AND p.moderation_status='approved' FOR UPDATE OF y`,[handle]);
  if(!home.rows[0]) throw new YardError("Home not found",404);
  const ownerId=home.rows[0].id;
  if(raw) {
   const input=parseHomeGrant(raw);
   if(actorId!==ownerId) throw new YardError("Only the owner can change home permissions",403);
   const visitor=await client.query("SELECT id::text FROM plankspace_profiles WHERE handle=$1 AND moderation_status='approved'",[input.visitor]);
   if(!visitor.rows[0] || visitor.rows[0].id===ownerId) throw new YardError("Choose another approved player",400);
   const visitorId=visitor.rows[0].id;
   const current=await client.query("SELECT revision::text FROM charmville_home_grants WHERE owner_profile_id=$1 AND visitor_profile_id=$2",[ownerId,visitorId]);
   if((current.rows[0]?.revision??"0")!==input.revision) throw new YardError("Permissions changed. Reload before saving.",409);
   if(input.revoke) {
    if(!current.rowCount) throw new YardError("Permission not found",404);
    await client.query("UPDATE charmville_home_grants SET revoked_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE owner_profile_id=$1 AND visitor_profile_id=$2",[ownerId,visitorId]);
   } else {
    const valid=await client.query("SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<=clock_timestamp()+interval '90 days' AS valid",[input.expiresAt]);
    if(!valid.rows[0].valid) throw new YardError("Expiry must be within the next 90 days",400);
    await client.query(`INSERT INTO charmville_home_grants(owner_profile_id,visitor_profile_id,rights,containers,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_profile_id,visitor_profile_id) DO UPDATE SET rights=EXCLUDED.rights,containers=EXCLUDED.containers,expires_at=EXCLUDED.expires_at,revoked_at=NULL,revision=charmville_home_grants.revision+1,updated_at=clock_timestamp()`,[ownerId,visitorId,input.rights,input.containers,input.expiresAt]);
   }
  }
  const grants=await client.query(`SELECT p.handle AS visitor,g.rights,g.containers,g.expires_at AS "expiresAt",g.revoked_at AS "revokedAt",g.revision::text,(g.revoked_at IS NULL AND g.expires_at>clock_timestamp()) AS active FROM charmville_home_grants g JOIN plankspace_profiles p ON p.id=g.visitor_profile_id WHERE g.owner_profile_id=$1 AND ($2::boolean OR g.visitor_profile_id=$3) ORDER BY p.handle`,[ownerId,actorId===ownerId,actorId]);
  await client.query("COMMIT");
  return {owner:actorId===ownerId,regionId:`home:${ownerId}`,grants:grants.rows};
 } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
