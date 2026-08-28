import "server-only";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { postgresQuery, withPostgresTransaction } from "@/lib/postgres";
import {
  newSessionToken, PLAYTEST_CEREMONY_SECONDS, PLAYTEST_SESSION_COOKIE,
  PLAYTEST_SESSION_SECONDS, playtestEnabled, sha256,
} from "@/lib/playtest-auth-core";
export * from "@/lib/playtest-auth-core";

export type PlaytestIdentity = { id: string; displayName: string; isAdmin: boolean };
export type PlaytestCeremony = {
  id: string;
  challenge: string;
  userId: string | null;
  inviteHash: string | null;
  displayName: string | null;
};


export async function createCeremony(
  kind: "register" | "authenticate",
  challenge: string,
  details: { inviteHash?: string; displayName?: string; userId?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await postgresQuery(
    `INSERT INTO playtest_ceremonies
       (id, kind, challenge, user_id, invite_hash, display_name, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 * INTERVAL '1 second'))`,
    [id, kind, challenge, details.userId || null, details.inviteHash || null, details.displayName || null, PLAYTEST_CEREMONY_SECONDS]
  );
  return id;
}

export async function consumeCeremony(id: string, kind: "register" | "authenticate"): Promise<PlaytestCeremony | null> {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{
      id: string; challenge: string; user_id: string | null; invite_hash: string | null; display_name: string | null;
    }>(
      `UPDATE playtest_ceremonies
          SET consumed_at = NOW()
        WHERE id = $1 AND kind = $2 AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING id, challenge, user_id, invite_hash, display_name`,
      [id, kind]
    );
    const row = result.rows[0];
    return row ? { id: row.id, challenge: row.challenge, userId: row.user_id, inviteHash: row.invite_hash, displayName: row.display_name } : null;
  });
}

export async function createSession(userId: string): Promise<string> {
  const token = newSessionToken();
  await postgresQuery(
    `INSERT INTO playtest_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 second'))`,
    [sha256(token), userId, PLAYTEST_SESSION_SECONDS]
  );
  return token;
}

export async function createPinIdentity(displayName: string, isAdmin: boolean): Promise<{ identity: PlaytestIdentity; token: string }> {
  const id = randomUUID();
  const marker = sha256(`pin-session:${id}`);
  await postgresQuery(
    `INSERT INTO playtest_users (id, display_name, invite_hash, is_admin) VALUES ($1,$2,$3,$4)`,
    [id, displayName, marker, isAdmin],
  );
  const token = await createSession(id);
  return { identity: { id, displayName, isAdmin }, token };
}

export async function sessionFromToken(token: string | undefined): Promise<PlaytestIdentity | null> {
  if (!token || token.length < 32 || token.length > 128) return null;
  const result = await postgresQuery<{ id: string; display_name: string; is_admin: boolean }>(
    `SELECT u.id, u.display_name, u.is_admin
       FROM playtest_sessions s
       JOIN playtest_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()
        AND u.disabled_at IS NULL`,
    [sha256(token)]
  );
  const row = result.rows[0];
  return row ? { id: row.id, displayName: row.display_name, isAdmin: row.is_admin } : null;
}

export async function currentPlaytestIdentity(): Promise<PlaytestIdentity | null> {
  if (!playtestEnabled()) return null;
  return sessionFromToken((await cookies()).get(PLAYTEST_SESSION_COOKIE)?.value);
}

export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token || token.length < 32 || token.length > 128) return;
  await postgresQuery(`UPDATE playtest_sessions SET revoked_at = NOW() WHERE token_hash = $1`, [sha256(token)]);
}
