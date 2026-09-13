import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { charmvilleAdmissionMode, requireCharmvilleAdmission } from "./admission";
import { YardError } from "./errors";

type Environment = Record<string,string|undefined>;
const digest = (value:string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
type AdminCommand = {action:"create";inviteHours:number;accessDays:number;recipientHandle?:string}
  | {action:"revoke";inviteId:string} | {action:"revokeGrant";profileId:string};

export function parseInviteCommand(raw:unknown):AdminCommand {
  if (!raw || typeof raw!=="object" || Array.isArray(raw)) throw new YardError("Invalid invitation action",400);
  const p=raw as Record<string,unknown>;
  if(p.action==="revoke" && typeof p.inviteId==="string" && uuid.test(p.inviteId)) return {action:"revoke",inviteId:p.inviteId};
  if(p.action==="revokeGrant" && typeof p.profileId==="string" && /^[1-9]\d{0,17}$/.test(p.profileId)) return {action:"revokeGrant",profileId:p.profileId};
  if(p.action!=="create") throw new YardError("Invalid invitation action",400);
  const inviteHours=p.inviteHours??24,accessDays=p.accessDays??30;
  if(!Number.isInteger(inviteHours)||Number(inviteHours)<1||Number(inviteHours)>168||
      !Number.isInteger(accessDays)||Number(accessDays)<1||Number(accessDays)>90)
    throw new YardError("Choose 1–168 invitation hours and 1–90 access days",400);
  if(p.recipientHandle!==undefined && (typeof p.recipientHandle!=="string" || !/^[a-z0-9_]{1,40}$/.test(p.recipientHandle)))
    throw new YardError("Choose an exact PlankSpace handle",400);
  return {action:"create",inviteHours:Number(inviteHours),accessDays:Number(accessDays),...(p.recipientHandle?{recipientHandle:String(p.recipientHandle)}:{})};
}

export function parseInviteRedemption(raw:unknown):string {
  const token=raw && typeof raw==="object" && !Array.isArray(raw) ? (raw as Record<string,unknown>).inviteToken : null;
  if(typeof token!=="string" || !/^[a-f0-9]{64}$/.test(token)) throw new YardError("Use a valid private invitation",400);
  return token;
}

/** Admission is deliberately not required yet: an invited account may not have a grant. */
async function authenticatedProfile(c:PoolClient,token:string,env:Environment):Promise<string> {
  if(charmvilleAdmissionMode(env)==="disabled") throw new YardError("Charmville testing is closed",403);
  if(!/^[a-f0-9]{64}$/i.test(token)) throw new YardError("Sign in to your PlankSpace account",401);
  const who=(await c.query(`SELECT p.id::text FROM plankspace_wallet_sessions s
    JOIN plankspace_profiles p ON lower(p.wallet)=lower(s.wallet)
    WHERE s.token_hash=$1 AND s.expires_at::timestamptz>clock_timestamp()
    AND p.moderation_status='approved' FOR SHARE OF s`,[digest(token)])).rows[0];
  if(!who) throw new YardError("Your session expired. Sign in again",401);
  const current=await c.query("SELECT id FROM plankspace_profiles WHERE id=$1 AND moderation_status='approved' FOR UPDATE",[who.id]);
  if(!current.rowCount) throw new YardError("Your profile is unavailable",403);
  return who.id;
}

async function admin(c:PoolClient,token:string,env:Environment) {
  const id=await authenticatedProfile(c,token,env);
  const admitted=await requireCharmvilleAdmission(c,id,env);
  if(admitted.role!=="admin") throw new YardError("Only a configured Charmville administrator can manage invitations",403);
  return id;
}

export async function manageCharmvilleInvites(pool:Pool,token:string,raw?:unknown,env:Environment=process.env) {
  const command=raw===undefined?null:parseInviteCommand(raw);
  const c=await pool.connect();
  try {
    await c.query("BEGIN");
    const actorId=await admin(c,token,env);
    if(command?.action==="create") {
      let recipientId:string|null=null;
      if(command.recipientHandle) {
        recipientId=(await c.query("SELECT id::text FROM plankspace_profiles WHERE handle=$1 AND moderation_status='approved'",[command.recipientHandle])).rows[0]?.id??null;
        if(!recipientId) throw new YardError("That approved PlankSpace profile was not found",404);
      }
      const inviteId=randomUUID(),inviteToken=randomBytes(32).toString("hex");
      const row=(await c.query(`INSERT INTO charmville_admission_invites(id,token_hash,issued_by_profile_id,recipient_profile_id,expires_at,access_days)
        VALUES($1,$2,$3,$4,clock_timestamp()+$5::integer*interval '1 hour',$6) RETURNING expires_at`,
        [inviteId,digest(inviteToken),actorId,recipientId,command.inviteHours,command.accessDays])).rows[0];
      await c.query("COMMIT");
      // The plaintext secret is shown once. It is never stored or included in list responses.
      return {inviteId,inviteToken,inviteExpiresAt:row.expires_at.toISOString(),accessDays:command.accessDays};
    }
    if(command?.action==="revoke") {
      const changed=await c.query("UPDATE charmville_admission_invites SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 RETURNING id",[command.inviteId]);
      if(!changed.rowCount) throw new YardError("Invitation not found",404);
      await c.query("COMMIT");
      return {revoked:true,inviteId:command.inviteId,scope:"invitation"};
    }
    if(command?.action==="revokeGrant") {
      const changed=await c.query("UPDATE charmville_admission_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE profile_id=$1 RETURNING profile_id",[command.profileId]);
      if(!changed.rowCount) throw new YardError("Admission grant not found",404);
      await c.query("COMMIT");
      return {revoked:true,profileId:command.profileId,scope:"admission-grant"};
    }
    const rows=await c.query(`SELECT i.id::text AS "inviteId",p.handle AS "issuedBy",r.handle AS "recipientHandle",
      i.created_at AS "createdAt",i.expires_at AS "inviteExpiresAt",i.access_days AS "accessDays",
      i.revoked_at AS "revokedAt",i.redeemed_at AS "redeemedAt",i.redeemed_by_profile_id::text AS "redeemedByProfileId",
      i.granted_until AS "grantedUntil" FROM charmville_admission_invites i
      JOIN plankspace_profiles p ON p.id=i.issued_by_profile_id LEFT JOIN plankspace_profiles r ON r.id=i.recipient_profile_id
      ORDER BY i.created_at DESC,i.id DESC LIMIT 100`);
    await c.query("COMMIT");return {invites:rows.rows};
  } catch(error) {await c.query("ROLLBACK");throw error;} finally {c.release();}
}

export async function redeemCharmvilleInvite(pool:Pool,sessionToken:string,raw:unknown,env:Environment=process.env) {
  const inviteToken=parseInviteRedemption(raw);
  const c=await pool.connect();
  try {
    await c.query("BEGIN");
    const id=await authenticatedProfile(c,sessionToken,env);
    const invitation=(await c.query(`SELECT *,
      recipient_profile_id::text AS recipient,redeemed_by_profile_id::text AS redeemed_by,
      issued_by_profile_id::text AS issuer FROM charmville_admission_invites WHERE token_hash=$1 FOR UPDATE`,[digest(inviteToken)])).rows[0];
    // Compute expiry after the lock is acquired, not in a projection that may
    // have waited behind another transaction long enough for the token to expire.
    const timing=invitation?(await c.query(`SELECT expires_at>clock_timestamp() AS live,
      granted_until>clock_timestamp() AS grant_live FROM charmville_admission_invites WHERE id=$1`,[invitation.id])).rows[0]:null;
    if(!invitation||!timing?.live||invitation.revoked_at||invitation.recipient&&invitation.recipient!==id||
        invitation.redeemed_by&&invitation.redeemed_by!==id)
      throw new YardError("Invitation is unavailable, expired, or already used",403);
    // Removing an issuer's admin authority also invalidates their outstanding invitations.
    const issuer=await requireCharmvilleAdmission(c,invitation.issuer,env);
    if(issuer.role!=="admin") throw new YardError("Invitation issuer is no longer authorized",403);
    if(invitation.redeemed_by) {
      const active=(await c.query("SELECT 1 FROM charmville_admission_grants WHERE profile_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()",[id])).rowCount;
      if(!active||!timing.grant_live) throw new YardError("Your invitation's admission has expired or been revoked",403);
      await c.query("COMMIT");
      return {admitted:true,profileId:id,expiresAt:invitation.granted_until.toISOString(),alreadyRedeemed:true};
    }
    const grant=(await c.query(`INSERT INTO charmville_admission_grants(profile_id,granted_by_profile_id,expires_at)
      VALUES($1,$2,clock_timestamp()+$3::integer*interval '1 day')
      ON CONFLICT(profile_id) DO UPDATE SET granted_by_profile_id=EXCLUDED.granted_by_profile_id,
      expires_at=CASE WHEN charmville_admission_grants.revoked_at IS NULL THEN GREATEST(charmville_admission_grants.expires_at,EXCLUDED.expires_at) ELSE EXCLUDED.expires_at END,
      revoked_at=NULL RETURNING expires_at`,[id,invitation.issuer,invitation.access_days])).rows[0];
    await c.query("UPDATE charmville_admission_invites SET redeemed_at=clock_timestamp(),redeemed_by_profile_id=$2,granted_until=$3 WHERE id=$1",[invitation.id,id,grant.expires_at]);
    await c.query("COMMIT");
    return {admitted:true,profileId:id,expiresAt:grant.expires_at.toISOString(),alreadyRedeemed:false};
  } catch(error) {await c.query("ROLLBACK");throw error;} finally {c.release();}
}
