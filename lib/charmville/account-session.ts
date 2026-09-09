import { createHash } from "node:crypto";
import type { Pool } from "pg";

export class GameSessionError extends Error {
  constructor() { super("Sign in to your approved PlankSpace account."); }
}

/** Identity only. Region admission and every mutation must recheck authorization. */
export async function readGameSession(pool: Pool, token: string) {
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new GameSessionError();
  const { rows } = await pool.query<{ profileId: string; handle: string; expiresAt: Date }>(`
    SELECT p.id::text AS "profileId", p.handle,
      s.expires_at::timestamptz AS "expiresAt"
    FROM plankspace_wallet_sessions s
    JOIN plankspace_profiles p ON lower(p.wallet)=lower(s.wallet)
    WHERE s.token_hash=$1 AND s.expires_at::timestamptz > clock_timestamp()
      AND p.moderation_status='approved'`,
  [createHash("sha256").update(token).digest("hex")]);
  if (!rows[0]) throw new GameSessionError();
  return { profileId: rows[0].profileId, handle: rows[0].handle,
    expiresAt: rows[0].expiresAt.toISOString() };
}
