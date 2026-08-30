import "server-only";

import { randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { PoolClient } from "pg";
import { cookies } from "next/headers";
import { postgresQuery, withPostgresTransaction } from "@/lib/postgres";
import {
  newSessionToken, PLAYTEST_CEREMONY_SECONDS, PLAYTEST_SESSION_COOKIE,
  PLAYTEST_SESSION_SECONDS, playtestEnabled, sha256, usernameKey,
} from "@/lib/playtest-auth-core";
export * from "@/lib/playtest-auth-core";

export type PlaytestIdentity = { id: string; displayName: string; isAdmin: boolean };
const scrypt = promisify(nodeScrypt);
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

async function pinDigest(pin: string, salt: string): Promise<string> {
  return (await scrypt(pin, salt, 32) as Buffer).toString("hex");
}

export async function adminConfigured(): Promise<boolean> {
  const result = await postgresQuery(`SELECT 1 FROM playtest_users WHERE is_admin AND pin_hash IS NOT NULL AND disabled_at IS NULL LIMIT 1`);
  return Boolean(result.rows[0]);
}

async function createPersonalIdentity(displayName: string, pin: string, isAdmin: boolean, client?: PoolClient): Promise<PlaytestIdentity> {
  const id = randomUUID();
  const salt = randomBytes(16).toString("hex");
  const hash = await pinDigest(pin, salt);
  const query = client?.query.bind(client) ?? postgresQuery;
  await query(
    `INSERT INTO playtest_users (id,display_name,username_key,invite_hash,is_admin,pin_salt,pin_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, displayName, usernameKey(displayName), sha256(`personal-pin:${id}`), isAdmin, salt, hash],
  );
  return { id, displayName, isAdmin };
}

export async function bootstrapAdmin(displayName: string, pin: string): Promise<{ identity: PlaytestIdentity; token: string }> {
  const identity = await withPostgresTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(710857214)`);
    const exists = await client.query(`SELECT 1 FROM playtest_users WHERE is_admin AND pin_hash IS NOT NULL AND disabled_at IS NULL LIMIT 1`);
    if (exists.rows[0]) throw new Error("ADMIN_ALREADY_CONFIGURED");
    return createPersonalIdentity(displayName, pin, true, client);
  });
  return { identity, token: await createSession(identity.id) };
}

export async function authenticatePersonalPin(displayName: string, pin: string): Promise<{ identity: PlaytestIdentity; token: string } | null> {
  const result = await postgresQuery<{ id: string; display_name: string; is_admin: boolean; pin_salt: string; pin_hash: string }>(
    `SELECT id,display_name,is_admin,pin_salt,pin_hash FROM playtest_users
      WHERE username_key=$1 AND pin_hash IS NOT NULL AND disabled_at IS NULL`, [usernameKey(displayName)],
  );
  const row = result.rows[0];
  if (!row) { await pinDigest(pin, "00000000000000000000000000000000"); return null; }
  const supplied = Buffer.from(await pinDigest(pin, row.pin_salt), "hex");
  const expected = Buffer.from(row.pin_hash, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  const identity = { id: row.id, displayName: row.display_name, isAdmin: row.is_admin };
  return { identity, token: await createSession(identity.id) };
}

export async function createRoomInvite(identity: PlaytestIdentity, roomId: string | null): Promise<string> {
  if (!identity.isAdmin) throw new Error("ADMIN_ONLY");
  if (roomId) {
    const member = await postgresQuery(`SELECT 1 FROM playtest_room_members WHERE room_id=$1 AND user_id=$2`, [roomId, identity.id]);
    if (!member.rows[0]) throw new Error("ROOM_NOT_FOUND");
  }
  const token = randomBytes(24).toString("base64url");
  await postgresQuery(
    `INSERT INTO playtest_invites (token_hash,created_by,room_id,expires_at)
     VALUES ($1,$2,$3,NOW()+INTERVAL '7 days')`, [sha256(token), identity.id, roomId],
  );
  return token;
}

export async function playtestInvitePreview(invite: string): Promise<{ roomId: string | null; roomName: string | null; joinCode: string | null; hostName: string | null } | null> {
  if (!invite || invite.length < 20) return null;
  const result = await postgresQuery<{ room_id: string | null; room_name: string | null; join_code: string | null; host_name: string | null }>(
    `SELECT i.room_id,r.name room_name,r.join_code,u.display_name host_name
       FROM playtest_invites i
       LEFT JOIN playtest_rooms r ON r.id=i.room_id AND r.archived_at IS NULL
       LEFT JOIN playtest_users u ON u.id=r.owner_user_id
      WHERE i.token_hash=$1 AND (i.room_id IS NOT NULL OR i.consumed_at IS NULL) AND i.expires_at>NOW()`,
    [sha256(invite)],
  );
  const row = result.rows[0];
  return row ? { roomId: row.room_id, roomName: row.room_name, joinCode: row.join_code, hostName: row.host_name } : null;
}

export async function registerFromInvite(displayName: string, pin: string, invite: string): Promise<{ identity: PlaytestIdentity; token: string; roomId: string | null }> {
  const registered = await withPostgresTransaction(async (client) => {
    const found = await client.query<{ room_id: string | null }>(
      `SELECT room_id FROM playtest_invites
        WHERE token_hash=$1 AND (room_id IS NOT NULL OR consumed_at IS NULL) AND expires_at>NOW()
        FOR UPDATE`, [sha256(invite)],
    );
    if (!found.rows[0]) throw new Error("INVITE_INVALID");
    const created = await createPersonalIdentity(displayName, pin, false, client);
    // A room-bound link is a reusable secret door for the host's invited
    // group. Unbound account invitations remain one-use.
    if (!found.rows[0].room_id) {
      await client.query(`UPDATE playtest_invites SET consumed_at=NOW(),consumed_by=$2 WHERE token_hash=$1`, [sha256(invite), created.id]);
    }
    if (found.rows[0].room_id) {
      await client.query(
        `INSERT INTO playtest_room_members (room_id,user_id,test_credit_balance) VALUES ($1,$2,1000000)
         ON CONFLICT (room_id,user_id) DO NOTHING`, [found.rows[0].room_id, created.id],
      );
    }
    return { identity: created, roomId: found.rows[0].room_id };
  });
  return { ...registered, token: await createSession(registered.identity.id) };
}

export async function joinRoomFromInvite(identity: PlaytestIdentity, invite: string): Promise<string> {
  return withPostgresTransaction(async (client) => {
    const found = await client.query<{ room_id: string }>(
      `SELECT i.room_id
         FROM playtest_invites i
         JOIN playtest_rooms r ON r.id=i.room_id AND r.archived_at IS NULL
        WHERE i.token_hash=$1 AND i.room_id IS NOT NULL AND i.expires_at>NOW()
        FOR SHARE`,
      [sha256(invite)],
    );
    const roomId = found.rows[0]?.room_id;
    if (!roomId) throw new Error("INVITE_INVALID");
    await client.query(
      `INSERT INTO playtest_room_members (room_id,user_id,test_credit_balance) VALUES ($1,$2,1000000)
       ON CONFLICT (room_id,user_id) DO NOTHING`,
      [roomId, identity.id],
    );
    return roomId;
  });
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
