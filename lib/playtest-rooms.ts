import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { initialSimulationState, serializeSimulationState, simulateIteration, validatePolicy, type LotteryOutcome, type SimulationPolicy } from "@/lib/casino/simulation";
import { postgresQuery, withPostgresTransaction } from "@/lib/postgres";
import type { PlaytestIdentity } from "@/lib/playtest-auth";
import {
  crashDurationMs, DEFAULT_PLAYTEST_POLICY, multiplierAt, parsePolicy,
  parseSimulationState, playtestRulesHash, serializeBigInts, simulationCrashBps,
} from "@/lib/playtest-room-core";

export class PlaytestRoomError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

type RoomRow = {
  id: string; join_code: string; name: string; owner_user_id: string;
  rules_hash: string; policy: unknown; simulation_state: unknown;
  phase: "lobby" | "running" | "settled"; version: string;
  current_round: string; commitment: string | null; reveal: string | null;
  crash_bps: string | null; started_at: Date | null; crash_at: Date | null;
  settled_at: Date | null; created_at: Date;
};

function roomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

async function event(
  client: PoolClient, room: RoomRow, type: string, actor: string | null,
  commandId: string | null, payload: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO playtest_room_events
       (room_id, room_version, round_id, event_type, actor_user_id, command_id, public_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [room.id, room.version, room.current_round, type, actor, commandId, JSON.stringify(serializeBigInts(payload))],
  );
}

async function lockedRoom(client: PoolClient, roomId: string): Promise<RoomRow> {
  const result = await client.query<RoomRow>(`SELECT * FROM playtest_rooms WHERE id=$1 AND archived_at IS NULL FOR UPDATE`, [roomId]);
  if (!result.rows[0]) throw new PlaytestRoomError(404, "ROOM_NOT_FOUND", "Room not found.");
  return result.rows[0];
}

async function requireMember(client: PoolClient, roomId: string, userId: string): Promise<void> {
  const result = await client.query(`SELECT 1 FROM playtest_room_members WHERE room_id=$1 AND user_id=$2`, [roomId, userId]);
  if (!result.rows[0]) throw new PlaytestRoomError(403, "NOT_A_MEMBER", "Join this room first.");
}

export async function createPlaytestRoom(identity: PlaytestIdentity, name: string) {
  const clean = name.trim().normalize("NFKC").replace(/\s+/g, " ");
  if (clean.length < 1 || clean.length > 48) throw new PlaytestRoomError(400, "BAD_NAME", "Room name must be 1–48 characters.");
  const policy = DEFAULT_PLAYTEST_POLICY;
  const state = initialSimulationState(policy);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const created = await withPostgresTransaction(async (client) => {
        const row: RoomRow = {
          id: randomUUID(), join_code: roomCode(), name: clean, owner_user_id: identity.id,
          rules_hash: playtestRulesHash(policy), policy: serializeBigInts(policy), simulation_state: serializeSimulationState(state),
          phase: "lobby", version: "1", current_round: "0", commitment: null, reveal: null,
          crash_bps: null, started_at: null, crash_at: null, settled_at: null, created_at: new Date(),
        };
        await client.query(
          `INSERT INTO playtest_rooms
             (id,join_code,name,owner_user_id,rules_hash,policy,simulation_state,version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
          [row.id, row.join_code, row.name, row.owner_user_id, row.rules_hash,
            JSON.stringify(row.policy), JSON.stringify(row.simulation_state)],
        );
        await client.query(`INSERT INTO playtest_room_members (room_id,user_id) VALUES ($1,$2)`, [row.id, identity.id]);
        return row;
      });

      // The room and its owner membership are the authoritative availability
      // boundary.  A replay/audit append must never make an otherwise valid
      // room disappear (for example when a shared-host sequence is briefly
      // locked or its grant drifted).  Later commands remain fully
      // transactional; this bootstrap marker is deliberately best-effort and
      // carries no economic state.
      await postgresQuery(
        `INSERT INTO playtest_room_events
           (room_id, room_version, round_id, event_type, actor_user_id, command_id, public_payload)
         VALUES ($1,$2,$3,$4,$5,NULL,$6)`,
        [created.id, created.version, created.current_round, "room.created", identity.id,
          JSON.stringify({ name: clean, joinCode: created.join_code })],
      ).catch((error) => {
        console.error("[playtest-room] room.created audit append failed", {
          roomId: created.id,
          code: (error as { code?: unknown }).code,
          constraint: (error as { constraint?: unknown }).constraint,
        });
      });
      return { id: created.id, joinCode: created.join_code };
    } catch (error) {
      if ((error as { code?: string }).code !== "23505" || attempt === 4) throw error;
    }
  }
  throw new PlaytestRoomError(500, "CODE_EXHAUSTED", "Could not allocate a room code.");
}

export async function joinPlaytestRoom(identity: PlaytestIdentity, rawCode: string) {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(code)) throw new PlaytestRoomError(400, "BAD_CODE", "Invalid room code.");
  return withPostgresTransaction(async (client) => {
    const found = await client.query<RoomRow>(`SELECT * FROM playtest_rooms WHERE join_code=$1 AND archived_at IS NULL FOR UPDATE`, [code]);
    const room = found.rows[0];
    if (!room) throw new PlaytestRoomError(404, "ROOM_NOT_FOUND", "Room not found.");
    const inserted = await client.query(`INSERT INTO playtest_room_members (room_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [room.id, identity.id]);
    if (!inserted.rowCount) return { id: room.id, alreadyJoined: true };
    room.version = String(BigInt(room.version) + 1n);
    await client.query(`UPDATE playtest_rooms SET version=$2 WHERE id=$1`, [room.id, room.version]);
    await event(client, room, "member.joined", identity.id, null, { displayName: identity.displayName });
    return { id: room.id };
  });
}

export async function listPlaytestRooms(identity: PlaytestIdentity) {
  const result = await postgresQuery<{
    id: string; join_code: string; name: string; phase: string; version: string;
    current_round: string; is_owner: boolean; members: string;
  }>(
    `SELECT r.id,r.join_code,r.name,r.phase,r.version::text,r.current_round::text,
            (r.owner_user_id=$1) AS is_owner, COUNT(all_members.user_id)::text AS members
       FROM playtest_rooms r
       JOIN playtest_room_members mine ON mine.room_id=r.id AND mine.user_id=$1
       JOIN playtest_room_members all_members ON all_members.room_id=r.id
      WHERE r.archived_at IS NULL
      GROUP BY r.id ORDER BY r.created_at DESC`, [identity.id],
  );
  return result.rows.map((row) => ({
    id: row.id, joinCode: row.join_code, name: row.name, phase: row.phase,
    version: row.version, currentRound: row.current_round, owner: row.is_owner,
    members: Number(row.members),
  }));
}

/** Recoverable room cleanup for accidental/obsolete laboratory tables. */
export async function archivePlaytestRoom(identity: PlaytestIdentity, roomId: string) {
  return withPostgresTransaction(async (client) => {
    const room = await lockedRoom(client, roomId);
    await requireMember(client, roomId, identity.id);
    if (room.owner_user_id !== identity.id && !identity.isAdmin) {
      throw new PlaytestRoomError(403, "OWNER_ONLY", "Only the table host can archive it.");
    }
    if (room.phase === "running") {
      throw new PlaytestRoomError(409, "ROUND_ACTIVE", "Settle the active round before archiving this table.");
    }
    await client.query(
      `UPDATE playtest_rooms SET archived_at=NOW(),version=version+1 WHERE id=$1`,
      [roomId],
    );
    return { archived: true };
  });
}

export async function playtestRoomSnapshot(identity: PlaytestIdentity, roomId: string) {
  return withPostgresTransaction(async (client) => {
    await requireMember(client, roomId, identity.id);
    const roomResult = await client.query<RoomRow>(`SELECT * FROM playtest_rooms WHERE id=$1 AND archived_at IS NULL`, [roomId]);
    const room = roomResult.rows[0];
    if (!room) throw new PlaytestRoomError(404, "ROOM_NOT_FOUND", "Room not found.");
    const members = await client.query<{ user_id: string; display_name: string; test_credit_balance: string }>(
      `SELECT m.user_id,u.display_name,m.test_credit_balance::text
         FROM playtest_room_members m JOIN playtest_users u ON u.id=m.user_id
        WHERE m.room_id=$1 ORDER BY m.joined_at`, [roomId],
    );
    const seats = await client.query<{
      user_id: string; display_name: string; stake: string; requested_target_bps: string;
      accepted_target_bps: string | null; payout: string | null; net: string | null;
      survived: boolean | null; locked_at: Date | null;
    }>(
      `SELECT s.user_id,u.display_name,s.stake::text,s.requested_target_bps::text,
              s.accepted_target_bps::text,s.payout::text,s.net::text,s.survived,s.locked_at
         FROM playtest_round_seats s JOIN playtest_users u ON u.id=s.user_id
        WHERE s.room_id=$1 AND s.round_id=$2 ORDER BY s.placed_at`, [roomId, room.current_round],
    );
    const events = await client.query<{ sequence: string; event_type: string; command_id: string | null; public_payload: unknown; created_at: Date }>(
      `SELECT sequence::text,event_type,command_id,public_payload,created_at FROM playtest_room_events
        WHERE room_id=$1 ORDER BY sequence DESC LIMIT 60`, [roomId],
    );
    const revealVisible = room.phase === "settled" ? room.reveal : null;
    const crashVisible = room.phase === "settled" ? room.crash_bps : null;
    return {
      schema: "plank.live-lab.snapshot.v1", serverNow: new Date().toISOString(),
      room: {
        id: room.id, joinCode: room.join_code, name: room.name, ownerUserId: room.owner_user_id,
        isOwner: room.owner_user_id === identity.id || identity.isAdmin, isAdmin: identity.isAdmin, rulesHash: room.rules_hash,
        phase: room.phase, version: room.version, currentRound: room.current_round,
        commitment: room.commitment, reveal: revealVisible, crashBps: crashVisible,
        startedAt: room.started_at?.toISOString() ?? null, crashAt: room.crash_at?.toISOString() ?? null,
        settledAt: room.settled_at?.toISOString() ?? null,
      },
      policy: room.policy, simulation: room.simulation_state,
      members: members.rows.map((row) => ({ id: row.user_id, displayName: row.display_name, balance: row.test_credit_balance })),
      seats: seats.rows.map((row) => ({
        userId: row.user_id, displayName: row.display_name, stake: row.stake,
        requestedTargetBps: row.requested_target_bps, acceptedTargetBps: row.accepted_target_bps,
        payout: row.payout, net: row.net, survived: row.survived, lockedAt: row.locked_at?.toISOString() ?? null,
      })),
      events: events.rows.reverse().map((row) => ({ sequence: row.sequence, type: row.event_type, commandId: row.command_id, payload: row.public_payload, at: row.created_at.toISOString() })),
      me: { id: identity.id, displayName: identity.displayName, isAdmin: identity.isAdmin },
    };
  });
}

export async function playtestRoomVersion(identity: PlaytestIdentity, roomId: string): Promise<string> {
  const result = await postgresQuery<{ version: string }>(
    `SELECT r.version::text
       FROM playtest_rooms r
       JOIN playtest_room_members m ON m.room_id=r.id AND m.user_id=$2
      WHERE r.id=$1 AND r.archived_at IS NULL`,
    [roomId, identity.id],
  );
  if (!result.rows[0]) throw new PlaytestRoomError(404, "ROOM_NOT_FOUND", "Room not found or membership revoked.");
  return result.rows[0].version;
}

export async function playtestRoomEvents(identity: PlaytestIdentity, roomId: string, after: bigint, limit: number) {
  if (after < 0n || !Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new PlaytestRoomError(400, "BAD_CURSOR", "Invalid replay cursor or limit.");
  }
  const member = await postgresQuery(`SELECT 1 FROM playtest_room_members WHERE room_id=$1 AND user_id=$2`, [roomId, identity.id]);
  if (!member.rows[0]) throw new PlaytestRoomError(403, "NOT_A_MEMBER", "Join this room first.");
  const result = await postgresQuery<{
    sequence: string; room_version: string; round_id: string; event_type: string;
    actor_user_id: string | null; command_id: string | null; public_payload: unknown; created_at: Date;
  }>(
    `SELECT sequence::text,room_version::text,round_id::text,event_type,
            actor_user_id,command_id,public_payload,created_at
       FROM playtest_room_events
      WHERE room_id=$1 AND sequence>$2
      ORDER BY sequence LIMIT $3`, [roomId, after.toString(), limit],
  );
  return result.rows.map((row) => ({
    sequence: row.sequence, roomVersion: row.room_version, roundId: row.round_id,
    type: row.event_type, actorUserId: row.actor_user_id, commandId: row.command_id,
    payload: row.public_payload, at: row.created_at.toISOString(),
  }));
}

export async function playtestCommandReceipt(identity: PlaytestIdentity, roomId: string, commandId: string) {
  const result = await postgresQuery<{
    sequence: string; room_version: string; round_id: string; event_type: string;
    public_payload: unknown; created_at: Date;
  }>(
    `SELECT e.sequence::text,e.room_version::text,e.round_id::text,e.event_type,e.public_payload,e.created_at
       FROM playtest_room_events e
       JOIN playtest_room_members m ON m.room_id=e.room_id AND m.user_id=$3
      WHERE e.room_id=$1 AND e.command_id=$2`, [roomId, commandId, identity.id],
  );
  const row = result.rows[0];
  return row ? {
    sequence: row.sequence, roomVersion: row.room_version, roundId: row.round_id,
    type: row.event_type, commandId, payload: row.public_payload, at: row.created_at.toISOString(),
  } : null;
}

async function duplicateCommand(client: PoolClient, roomId: string, commandId: string): Promise<boolean> {
  const found = await client.query(`SELECT 1 FROM playtest_room_events WHERE room_id=$1 AND command_id=$2`, [roomId, commandId]);
  return Boolean(found.rows[0]);
}

export async function placePlaytestBet(identity: PlaytestIdentity, roomId: string, commandId: string, stake: bigint, targetBps: bigint) {
  if (stake <= 0n || targetBps < 10_100n || targetBps > 1_000_000n) throw new PlaytestRoomError(400, "BAD_BET", "Stake or target is outside the laboratory range.");
  return withPostgresTransaction(async (client) => {
    const room = await lockedRoom(client, roomId); await requireMember(client, roomId, identity.id);
    if (await duplicateCommand(client, roomId, commandId)) return { duplicate: true };
    if (room.phase === "running") throw new PlaytestRoomError(409, "BETTING_CLOSED", "The current round is already running.");
    const roundId = BigInt(room.current_round) + 1n;
    const prior = await client.query<{ stake: string }>(`SELECT stake::text FROM playtest_round_seats WHERE room_id=$1 AND round_id=$2 AND user_id=$3 FOR UPDATE`, [roomId, roundId.toString(), identity.id]);
    const priorStake = BigInt(prior.rows[0]?.stake ?? "0");
    const balanceRow = await client.query<{ test_credit_balance: string }>(`SELECT test_credit_balance::text FROM playtest_room_members WHERE room_id=$1 AND user_id=$2 FOR UPDATE`, [roomId, identity.id]);
    const available = BigInt(balanceRow.rows[0].test_credit_balance) + priorStake;
    if (stake > available) throw new PlaytestRoomError(409, "INSUFFICIENT_TEST_CREDITS", "Not enough test credits.");
    await client.query(`UPDATE playtest_room_members SET test_credit_balance=$3 WHERE room_id=$1 AND user_id=$2`, [roomId, identity.id, (available - stake).toString()]);
    await client.query(
      `INSERT INTO playtest_round_seats (room_id,round_id,user_id,stake,requested_target_bps,command_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (room_id,round_id,user_id) DO UPDATE SET
         stake=EXCLUDED.stake, requested_target_bps=EXCLUDED.requested_target_bps,
         command_id=EXCLUDED.command_id, placed_at=NOW()`,
      [roomId, roundId.toString(), identity.id, stake.toString(), targetBps.toString(), commandId],
    );
    room.version = String(BigInt(room.version) + 1n); room.current_round = roundId.toString();
    await client.query(`UPDATE playtest_rooms SET version=$2,current_round=$3,phase='lobby',commitment=NULL,reveal=NULL,crash_bps=NULL,started_at=NULL,crash_at=NULL,settled_at=NULL WHERE id=$1`, [roomId, room.version, room.current_round]);
    await event(client, room, "bet.accepted", identity.id, commandId, { stake, targetBps });
    return { duplicate: false, version: room.version };
  });
}

export async function startPlaytestRound(identity: PlaytestIdentity, roomId: string, commandId: string) {
  return withPostgresTransaction(async (client) => {
    const room = await lockedRoom(client, roomId); await requireMember(client, roomId, identity.id);
    if (room.owner_user_id !== identity.id && !identity.isAdmin) throw new PlaytestRoomError(403, "OWNER_ONLY", "Only the room host can launch.");
    if (await duplicateCommand(client, roomId, commandId)) return { duplicate: true };
    if (room.phase !== "lobby" || BigInt(room.current_round) < 1n) throw new PlaytestRoomError(409, "NOT_READY", "The room needs a lobby round with bets.");
    const count = await client.query<{ count: string }>(`SELECT COUNT(*)::text count FROM playtest_round_seats WHERE room_id=$1 AND round_id=$2`, [roomId, room.current_round]);
    const policy = parsePolicy(room.policy);
    if (Number(count.rows[0].count) < policy.minimumPlayers) throw new PlaytestRoomError(409, "MINIMUM_PLAYERS", `At least ${policy.minimumPlayers} players must bet.`);
    const reveal = randomBytes(32).toString("hex");
    const commitment = createHash("sha256").update(reveal, "hex").digest("hex");
    const crashBps = simulationCrashBps(reveal);
    const started = new Date(Date.now() + 1_500);
    const crashAt = new Date(started.getTime() + crashDurationMs(crashBps));
    room.version = String(BigInt(room.version) + 1n); room.phase = "running";
    room.commitment = commitment; room.reveal = reveal; room.crash_bps = crashBps.toString();
    room.started_at = started; room.crash_at = crashAt;
    await client.query(
      `UPDATE playtest_rooms SET phase='running',version=$2,commitment=$3,reveal=$4,crash_bps=$5,started_at=$6,crash_at=$7,settled_at=NULL WHERE id=$1`,
      [roomId, room.version, commitment, reveal, crashBps.toString(), started, crashAt],
    );
    await event(client, room, "round.launched", identity.id, commandId, { commitment, startedAt: started.toISOString(), crashAt: crashAt.toISOString() });
    return { duplicate: false, version: room.version };
  });
}

export async function lockPlaytestBet(identity: PlaytestIdentity, roomId: string, commandId: string) {
  return withPostgresTransaction(async (client) => {
    const room = await lockedRoom(client, roomId); await requireMember(client, roomId, identity.id);
    if (await duplicateCommand(client, roomId, commandId)) return { duplicate: true };
    if (room.phase !== "running" || !room.started_at || !room.crash_at) throw new PlaytestRoomError(409, "NOT_RUNNING", "No round is currently running.");
    const now = Date.now();
    if (now >= room.crash_at.getTime()) throw new PlaytestRoomError(409, "TOO_LATE", "The authoritative crash deadline has passed.");
    const accepted = multiplierAt(room.started_at.getTime(), now);
    if (accepted < 10_100n) throw new PlaytestRoomError(409, "TOO_EARLY", "Lock opens at 1.01x.");
    const updated = await client.query(
      `UPDATE playtest_round_seats SET accepted_target_bps=$4,locked_at=NOW()
        WHERE room_id=$1 AND round_id=$2 AND user_id=$3 AND accepted_target_bps IS NULL`,
      [roomId, room.current_round, identity.id, accepted.toString()],
    );
    if (!updated.rowCount) throw new PlaytestRoomError(409, "NO_ACTIVE_BET", "No unlocked bet exists for this round.");
    room.version = String(BigInt(room.version) + 1n);
    await client.query(`UPDATE playtest_rooms SET version=$2 WHERE id=$1`, [roomId, room.version]);
    await event(client, room, "lock.accepted", identity.id, commandId, { acceptedTargetBps: accepted, serverAcceptedAt: new Date(now).toISOString() });
    return { duplicate: false, acceptedTargetBps: accepted.toString(), version: room.version };
  });
}

export async function settlePlaytestRound(identity: PlaytestIdentity, roomId: string, commandId: string, lotteryOutcome: LotteryOutcome, ownerOnly = true) {
  if (!["none", "miss", "hit"].includes(lotteryOutcome)) throw new PlaytestRoomError(400, "BAD_LOTTERY_OUTCOME", "Invalid lottery outcome.");
  return withPostgresTransaction(async (client) => {
    const room = await lockedRoom(client, roomId); await requireMember(client, roomId, identity.id);
    if (ownerOnly && room.owner_user_id !== identity.id && !identity.isAdmin) throw new PlaytestRoomError(403, "OWNER_ONLY", "Only the room host can select a laboratory lottery outcome.");
    if (await duplicateCommand(client, roomId, commandId)) return { duplicate: true };
    if (room.phase !== "running" || !room.crash_at || !room.crash_bps) throw new PlaytestRoomError(409, "NOT_RUNNING", "No round is currently running.");
    if (Date.now() < room.crash_at.getTime()) throw new PlaytestRoomError(409, "ROUND_ACTIVE", "The round has not crashed yet.");
    const seats = await client.query<{ user_id: string; stake: string; requested_target_bps: string; accepted_target_bps: string | null }>(
      `SELECT user_id,stake::text,requested_target_bps::text,accepted_target_bps::text
         FROM playtest_round_seats WHERE room_id=$1 AND round_id=$2 ORDER BY user_id FOR UPDATE`,
      [roomId, room.current_round],
    );
    const policy = parsePolicy(room.policy);
    const prior = parseSimulationState(room.simulation_state);
    const result = simulateIteration(prior, policy, {
      players: seats.rows.map((seat) => ({ id: seat.user_id, stake: BigInt(seat.stake), targetBps: BigInt(seat.accepted_target_bps ?? seat.requested_target_bps) })),
      crashBps: BigInt(room.crash_bps), lotteryOutcome,
    });
    for (const allocation of result.settlement?.allocations ?? []) {
      await client.query(
        `UPDATE playtest_round_seats SET payout=$4,net=$5,survived=$6 WHERE room_id=$1 AND round_id=$2 AND user_id=$3`,
        [roomId, room.current_round, allocation.id, allocation.payout.toString(), allocation.net.toString(), allocation.survived],
      );
      await client.query(`UPDATE playtest_room_members SET test_credit_balance=test_credit_balance+$3 WHERE room_id=$1 AND user_id=$2`, [roomId, allocation.id, allocation.payout.toString()]);
    }
    room.version = String(BigInt(room.version) + 1n); room.phase = "settled"; room.settled_at = new Date();
    room.simulation_state = serializeSimulationState(result.state);
    await client.query(`UPDATE playtest_rooms SET phase='settled',version=$2,simulation_state=$3,settled_at=$4 WHERE id=$1`, [roomId, room.version, JSON.stringify(room.simulation_state), room.settled_at]);
    await event(client, room, "round.settled", identity.id, commandId, {
      crashBps: room.crash_bps, reveal: room.reveal, lotteryEvent: result.lotteryEvent,
      qualified: result.qualified, accounting: result.settlement,
    });
    return { duplicate: false, version: room.version };
  });
}

/** Permissionless laboratory keeper. The lottery branch is derived from the
 * already committed round reveal, so a caller cannot choose it after crash. */
export async function tickPlaytestRound(identity: PlaytestIdentity, roomId: string, commandId: string) {
  const found = await postgresQuery<{ reveal: string | null }>(
    `SELECT r.reveal FROM playtest_rooms r
       JOIN playtest_room_members m ON m.room_id=r.id AND m.user_id=$2
      WHERE r.id=$1 AND r.archived_at IS NULL`, [roomId, identity.id],
  );
  const reveal = found.rows[0]?.reveal;
  if (!reveal) throw new PlaytestRoomError(409, "NOT_RUNNING", "No committed round can be ticked.");
  const lotterySample = createHash("sha256").update(`${reveal}:powerboard`).digest()[0];
  const outcome: LotteryOutcome = lotterySample % 16 === 0 ? "hit" : "miss";
  return settlePlaytestRound(identity, roomId, commandId, outcome, false);
}

const EDITABLE_POLICY_KEYS = new Set<keyof SimulationPolicy>([
  "keeperRewardBps", "protectedPrincipalBps", "crashSeed", "emissionBufferCap",
  "lotteryFounderFeeBps", "lotteryInitialBase", "lotteryMinimumIncrease",
  "lotteryBaseGrowthBps", "lotteryMinimumBaseStep", "consolation",
  "minimumPlayers", "minimumStake",
]);

/** Admin-only laboratory tuning. The ratified rake and allocation rule remain
 * immutable; edits are validated by the same economic kernel used to settle. */
export async function updatePlaytestPolicy(identity: PlaytestIdentity, roomId: string, commandId: string, patch: unknown) {
  if (!identity.isAdmin) throw new PlaytestRoomError(403, "ADMIN_ONLY", "The host PIN is required.");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new PlaytestRoomError(400, "BAD_POLICY", "Policy changes must be an object.");
  return withPostgresTransaction(async (client) => {
    const room = await lockedRoom(client, roomId); await requireMember(client, roomId, identity.id);
    if (await duplicateCommand(client, roomId, commandId)) return { duplicate: true };
    if (room.phase === "running") throw new PlaytestRoomError(409, "ROUND_ACTIVE", "Tune parameters between rounds.");
    const candidate = parsePolicy(room.policy) as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (!EDITABLE_POLICY_KEYS.has(key as keyof SimulationPolicy)) throw new PlaytestRoomError(400, "BAD_POLICY_KEY", `${key} cannot be changed in the host console.`);
      if (key === "minimumPlayers") {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed)) throw new PlaytestRoomError(400, "BAD_POLICY_VALUE", `${key} must be an integer.`);
        candidate[key] = parsed;
      } else {
        if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) throw new PlaytestRoomError(400, "BAD_POLICY_VALUE", `${key} must be a non-negative integer string.`);
        candidate[key] = BigInt(value);
      }
    }
    try { validatePolicy(candidate as unknown as SimulationPolicy); }
    catch (error) { throw new PlaytestRoomError(400, "INVALID_POLICY", error instanceof Error ? error.message : "Invalid policy."); }
    room.version = String(BigInt(room.version) + 1n);
    room.policy = serializeBigInts(candidate);
    room.rules_hash = playtestRulesHash(candidate as unknown as SimulationPolicy);
    await client.query(`UPDATE playtest_rooms SET version=$2,policy=$3,rules_hash=$4 WHERE id=$1`, [room.id, room.version, JSON.stringify(room.policy), room.rules_hash]);
    await event(client, room, "admin.policy.updated", identity.id, commandId, { patch, rulesHash: room.rules_hash });
    return { duplicate: false, version: room.version, rulesHash: room.rules_hash };
  });
}

export async function adjustPlaytestCredit(identity: PlaytestIdentity, roomId: string, commandId: string, userId: string, balance: bigint) {
  if (!identity.isAdmin) throw new PlaytestRoomError(403, "ADMIN_ONLY", "The host PIN is required.");
  if (balance < 0n || balance > 10n ** 30n) throw new PlaytestRoomError(400, "BAD_BALANCE", "Balance is outside the laboratory range.");
  return withPostgresTransaction(async (client) => {
    const room = await lockedRoom(client, roomId); await requireMember(client, roomId, identity.id);
    if (await duplicateCommand(client, roomId, commandId)) return { duplicate: true };
    const changed = await client.query(`UPDATE playtest_room_members SET test_credit_balance=$3 WHERE room_id=$1 AND user_id=$2`, [roomId, userId, balance.toString()]);
    if (!changed.rowCount) throw new PlaytestRoomError(404, "MEMBER_NOT_FOUND", "That player is not in this room.");
    room.version = String(BigInt(room.version) + 1n);
    await client.query(`UPDATE playtest_rooms SET version=$2 WHERE id=$1`, [room.id, room.version]);
    await event(client, room, "admin.credit.adjusted", identity.id, commandId, { userId, balance });
    return { duplicate: false, version: room.version };
  });
}
