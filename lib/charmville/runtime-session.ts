import {createHash,randomBytes} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {charmvilleAdmissionMode,requireCharmvilleAdmission} from "./admission";
import {YardError} from "./errors";

type Environment=Record<string,string|undefined>;
export const RUNTIME_SESSION_COOKIE="plank_charmville_runtime";
export const RUNTIME_SESSION_SECONDS=600;
const tokenPattern=/^[a-f0-9]{64}$/;
const hash=(token:string)=>createHash("sha256").update(token).digest("hex");

export function runtimeSessionCookie(ticket:string,env:Environment=process.env):string {
  if(!tokenPattern.test(ticket))throw new YardError("Invalid runtime session",400);
  return `${RUNTIME_SESSION_COOKIE}=${ticket}; Path=/charmville/runtime/; Max-Age=${RUNTIME_SESSION_SECONDS}; HttpOnly; SameSite=Strict${env.NODE_ENV==="development"?"":"; Secure"}`;
}

export function runtimeTicketFromRequest(request:Request):string {
  const candidates=(request.headers.get("cookie")??"").split(";").map(piece=>piece.trim())
    .filter(piece=>piece.startsWith(`${RUNTIME_SESSION_COOKIE}=`));
  // Duplicate path cookies are ambiguous. Never choose whichever happens to appear first.
  if(candidates.length!==1)throw new YardError("Open the game from your signed-in Charmdex",401);
  const ticket=candidates[0].slice(RUNTIME_SESSION_COOKIE.length+1);
  if(!tokenPattern.test(ticket))throw new YardError("Open the game from your signed-in Charmdex",401);
  return ticket;
}

/** Server-only issuance: the caller must put the ticket in an HttpOnly cookie,
 * never a JSON body, URL, log, postMessage or client storage.
 */
export async function issueRuntimeSession(pool:Pool,token:string,env:Environment=process.env) {
  return updateRuntimeSession(pool,token,env);
}

/** Called only through a same-origin POST under the cookie's scoped path.
 * Retaining the same ticket lets an existing iframe keep running while its
 * access cookie renews. The Bearer session must own this exact live ticket.
 */
export async function renewRuntimeSession(pool:Pool,token:string,request:Request,env:Environment=process.env) {
  return updateRuntimeSession(pool,token,env,runtimeTicketFromRequest(request));
}

async function updateRuntimeSession(pool:Pool,token:string,env:Environment,ticketToRenew?:string) {
  if(charmvilleAdmissionMode(env)==="disabled")throw new YardError("Charmville testing is closed",403);
  if(!/^[a-f0-9]{64}$/i.test(token))throw new YardError("Sign in before opening the game",401);
  const sessionHash=hash(token),c=await pool.connect();
  try {
    await c.query("BEGIN");
    // Serialize only issuance on this session, preserving multiple active browser tabs.
    const session=(await c.query(`SELECT p.id::text,s.expires_at::timestamptz AS expires_at
      FROM plankspace_wallet_sessions s JOIN plankspace_profiles p ON lower(p.wallet)=lower(s.wallet)
      WHERE s.token_hash=$1 AND s.expires_at::timestamptz>clock_timestamp()
      AND p.moderation_status='approved' FOR UPDATE OF s`,[sessionHash])).rows[0];
    if(!session)throw new YardError("Your session expired. Sign in again",401);
    await requireCharmvilleAdmission(c,session.id,env);
    if(ticketToRenew) {
      const renewed=await c.query(`UPDATE charmville_runtime_sessions t
        SET expires_at=LEAST(s.expires_at::timestamptz,clock_timestamp()+interval '10 minutes')
        FROM plankspace_wallet_sessions s
        WHERE t.ticket_hash=$1 AND t.session_hash=$2 AND t.profile_id=$3
        AND s.token_hash=t.session_hash AND t.expires_at>clock_timestamp()
        AND s.expires_at::timestamptz>clock_timestamp() RETURNING t.expires_at`,[hash(ticketToRenew),sessionHash,session.id]);
      if(!renewed.rowCount)throw new YardError("Your game session expired or belongs to another account. Reopen it from Charmdex",401);
      await c.query("COMMIT");
      return {ticket:ticketToRenew,expiresAt:renewed.rows[0].expires_at.toISOString()};
    }
    await c.query("DELETE FROM charmville_runtime_sessions WHERE session_hash=$1 AND expires_at<=clock_timestamp()",[sessionHash]);
    const active=(await c.query("SELECT count(*)::integer AS count FROM charmville_runtime_sessions WHERE session_hash=$1",[sessionHash])).rows[0].count;
    if(active>=8)throw new YardError("Too many game openings. Wait a few minutes before opening another",429);
    const ticket=randomBytes(32).toString("hex");
    const result=await c.query(`INSERT INTO charmville_runtime_sessions(ticket_hash,session_hash,profile_id,expires_at)
      SELECT $1,$2,$3,LEAST(s.expires_at::timestamptz,clock_timestamp()+interval '10 minutes')
      FROM plankspace_wallet_sessions s WHERE s.token_hash=$2 AND s.expires_at::timestamptz>clock_timestamp()
      RETURNING expires_at`,[hash(ticket),sessionHash,session.id]);
    if(!result.rowCount)throw new YardError("Your session expired. Sign in again",401);
    await c.query("COMMIT");return {ticket,expiresAt:result.rows[0].expires_at.toISOString()};
  } catch(error){await c.query("ROLLBACK");throw error;} finally{c.release();}
}

/** Recheck on every protected native asset response, including range requests.
 * Cookie possession cannot outlive session revocation or account admission.
 */
export async function requireRuntimeSession(db:Pool|PoolClient,request:Request,env:Environment=process.env) {
  if(charmvilleAdmissionMode(env)==="disabled")throw new YardError("Charmville testing is closed",403);
  const ticket=runtimeTicketFromRequest(request);
  const row=(await db.query(`SELECT p.id::text FROM charmville_runtime_sessions t
    JOIN plankspace_wallet_sessions s ON s.token_hash=t.session_hash
    JOIN plankspace_profiles p ON p.id=t.profile_id AND lower(p.wallet)=lower(s.wallet)
    WHERE t.ticket_hash=$1 AND t.expires_at>clock_timestamp()
    AND s.expires_at::timestamptz>clock_timestamp() AND p.moderation_status='approved'`,[hash(ticket)])).rows[0];
  if(!row)throw new YardError("Your game session expired. Reopen it from Charmdex",401);
  return requireCharmvilleAdmission(db,row.id,env);
}
