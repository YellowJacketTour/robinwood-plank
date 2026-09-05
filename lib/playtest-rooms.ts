import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { evolutionQuote, initialSimulationState, PROB_ONE, serializeSimulationState, simulateIteration, validatePolicy, type LotteryOutcome, type SimulationPolicy } from "@/lib/casino/simulation";
import { postgresQuery, withPostgresTransaction } from "@/lib/postgres";
import type { PlaytestIdentity } from "@/lib/playtest-auth";
import { BOT_PROFILE_NAMES, botProfile, botRoundCommitment, validateBotProfile, weightedTicketWinner, type BotProfileName, type PlaytestBotProfile } from "@/lib/playtest-bots";
import {
  bettingRoundId, crashDurationMs, CURRENT_PLAYTEST_PRIZE_PROFILE, DEFAULT_PLAYTEST_POLICY, effectiveSettlementTarget, injectSimulationState,
  LEGACY_LOTTERY_POLICY_KEYS, legacyPlaytestPrizeProfile, newcomerSeatPlan, parsePolicy,
  PLAYTEST_POWERBOARD_BALLS, PLAYTEST_PRIZE_PROFILE_KEYS, powerboardRoundDraw,
  parseSimulationState, playtestRulesHash, serializeBigInts, simulationCrashBps,
} from "@/lib/playtest-room-core";
import { settlementDescriptor } from "@/lib/casino/settlement-rules";
import { contributionPace, lotteryPrizeQuote, lotteryShareOfPotPpm, playerRoundOdds, seedShareBps, vaultGrowthBps, vaultShareOfPotPpm } from "@/lib/casino/economy-report";
import { clampDisplayLagMs, DEFAULT_DISPLAY_LAG_MS, laggedLockGrantBps } from "@/lib/playtest-live-shared";

/** Server-published presentation lag δ for every room (see the choice
 * rationale in lib/playtest-live-shared.ts). Clients render the flight at
 * display-time = server-time − δ; manual locks are granted at m(arrival − δ). */
export const PLAYTEST_DISPLAY_LAG_MS = clampDisplayLagMs(DEFAULT_DISPLAY_LAG_MS);

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

export const PLAYTEST_INTERMISSION_MS = 30_000;

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

const big = (value: unknown): bigint => { try { return BigInt(String(value ?? "0")); } catch { return 0n; } };

/** Plain-language economy figures, derived with the SAME kernel functions
 * the engine settles with. `recent` is newest-first round.settled payloads. */
export function buildEconomyReport(
  simulation: ReturnType<typeof parseSimulationState>,
  policy: SimulationPolicy,
  effectiveRakeBps: bigint,
  recent: ReadonlyArray<{ round_id: string; public_payload: Record<string, unknown> }>,
) {
  const last = recent[0] ?? null;
  const payload = last?.public_payload ?? {};
  const hasProvenance = last !== null && "vaultBefore" in payload;
  const vaultBefore = hasProvenance ? big(payload.vaultBefore) : null;
  const vaultAdded = hasProvenance ? big(payload.vaultAdded) : null;
  const seed = hasProvenance ? big(payload.seed) : null;
  const reservesBeforeSeed = hasProvenance ? big(payload.reservesBeforeSeed) : null;
  // The odds are quoted at THIS table's typical contribution (average routed
  // lottery leg of the last 10 settled rounds), so "1 in N" is the chance a
  // round like the ones actually being played has -- never a flat fiction.
  const recentFunding = recent.map((row) => big(row.public_payload.powerboardFundingAdded));
  const sampled = recentFunding.slice(0, 10);
  const quotedContribution = sampled.length ? sampled.reduce((sum, value) => sum + value, 0n) / BigInt(sampled.length) : 0n;
  const prize = lotteryPrizeQuote(simulation, policy, quotedContribution);
  const pace = contributionPace(recentFunding, prize.thresholdE18, BigInt(PLAYTEST_INTERMISSION_MS / 1000));
  return {
    schema: "plank.live-lab.economy.v2",
    creditsPerEth: "1000000",
    lastSettledRound: last?.round_id ?? null,
    vault: {
      principal: simulation.protectedPrincipal,
      emissionBuffer: simulation.emissionBuffer,
      previousPrincipal: vaultBefore,
      addedThisRound: vaultAdded,
      growthBps: vaultBefore === null || vaultAdded === null ? null : vaultGrowthBps(vaultBefore, vaultAdded),
      genesisRound: vaultBefore === 0n,
      shareOfPotPpm: vaultShareOfPotPpm(policy, effectiveRakeBps),
      communityRetainedBps: 10_000n - policy.powerboardFundingBps,
      retainedToVaultBps: policy.protectedPrincipalBps,
      seedThisRound: seed,
      reservesBeforeSeed,
      seedShareBps: seed === null || reservesBeforeSeed === null ? null : seedShareBps(seed, reservesBeforeSeed),
      seedPerRound: policy.crashSeed,
      lifetimeAdded: simulation.protectedPrincipal,
      lifetimeSeeded: simulation.totals.flightSeeded ?? 0n,
    },
    lottery: {
      ...prize,
      addedThisRound: last ? big(payload.powerboardFundingAdded) : null,
      shareOfPotPpm: lotteryShareOfPotPpm(policy, effectiveRakeBps),
      averageContributionPerRound: pace.averageContributionPerRound,
      roundsSampled: pace.roundsSampled,
      expectedRoundsToHit: pace.expectedRoundsToHit,
      expectedSecondsToHit: pace.expectedSecondsToHit,
      cadenceSeconds: PLAYTEST_INTERMISSION_MS / 1000,
      inflowFeeBps: policy.lotteryFounderFeeBps,
      lastDraw: last ? {
        thresholdE18: big(payload.lotteryThresholdE18),
        contribution: big(payload.powerboardFundingAdded),
        event: String(payload.lotteryEvent ?? "none"),
      } : null,
    },
  };
}

export async function playtestRoomSnapshot(identity: PlaytestIdentity, roomId: string) {
  return withPostgresTransaction(async (client) => {
    await requireMember(client, roomId, identity.id);
    const roomResult = await client.query<RoomRow>(`SELECT * FROM playtest_rooms WHERE id=$1 AND archived_at IS NULL`, [roomId]);
    const room = roomResult.rows[0];
    if (!room) throw new PlaytestRoomError(404, "ROOM_NOT_FOUND", "Room not found.");
    const members = await client.query<{ user_id: string; display_name: string; test_credit_balance: string; is_bot: boolean; bot_profile: PlaytestBotProfile | null }>(
      `SELECT m.user_id,u.display_name,m.test_credit_balance::text,u.is_bot,m.bot_profile
         FROM playtest_room_members m JOIN playtest_users u ON u.id=m.user_id
        WHERE m.room_id=$1 ORDER BY m.joined_at`, [roomId],
    );
    const seats = await client.query<{
      user_id: string; display_name: string; stake: string; requested_target_bps: string;
      accepted_target_bps: string | null; auto_lock_enabled: boolean; payout: string | null; net: string | null;
      survived: boolean | null; locked_at: Date | null;
    }>(
      `SELECT s.user_id,u.display_name,s.stake::text,s.requested_target_bps::text,
              s.accepted_target_bps::text,s.auto_lock_enabled,s.payout::text,s.net::text,s.survived,s.locked_at
         FROM playtest_round_seats s JOIN playtest_users u ON u.id=s.user_id
        WHERE s.room_id=$1 AND s.round_id=$2 ORDER BY s.placed_at`, [roomId, room.current_round],
    );
    // A settled table accepts commitments for the following round while its
    // completed seats remain visible in the results story. Expose both ledgers
    // so the client can confirm that a commitment was queued immediately.
    const nextRoundSeats = room.phase === "settled"
      ? await client.query<{ user_id: string; display_name: string; stake: string; requested_target_bps: string; auto_lock_enabled: boolean }>(
        `SELECT s.user_id,u.display_name,s.stake::text,s.requested_target_bps::text,s.auto_lock_enabled
           FROM playtest_round_seats s JOIN playtest_users u ON u.id=s.user_id
          WHERE s.room_id=$1 AND s.round_id=$2 ORDER BY s.placed_at`, [roomId, (BigInt(room.current_round) + 1n).toString()],
      )
      : null;
    const events = await client.query<{ sequence: string; event_type: string; command_id: string | null; public_payload: unknown; created_at: Date }>(
      `SELECT sequence::text,event_type,command_id,public_payload,created_at FROM playtest_room_events
        WHERE room_id=$1 ORDER BY sequence DESC LIMIT 60`, [roomId],
    );
    // A busy bot table can outgrow the general replay window. The current
    // conclusion is authoritative presentation state and must remain directly
    // addressable after refresh instead of becoming an empty theater shell.
    const currentSettlement = room.phase === "settled"
      ? await client.query<{ sequence: string; public_payload: unknown; created_at: Date }>(
        `SELECT sequence::text,public_payload,created_at FROM playtest_room_events
          WHERE room_id=$1 AND round_id=$2 AND event_type='round.settled'
          ORDER BY sequence DESC LIMIT 1`, [roomId, room.current_round],
      )
      : null;
    const simulation = parseSimulationState(room.simulation_state);
    const snapshotPolicy = parsePolicy(room.policy);
    const evolution = evolutionQuote(snapshotPolicy, simulation.totals.freshWagers);
    // Economy panel: the LAST settled round's provenance (whatever phase the
    // table is in now) plus the funding pace over the last 10 settlements.
    const recentSettlements = await client.query<{ round_id: string; public_payload: Record<string, unknown> }>(
      `SELECT round_id::text,public_payload FROM playtest_room_events
        WHERE room_id=$1 AND event_type='round.settled' ORDER BY sequence DESC LIMIT 10`, [roomId],
    );
    const economy = buildEconomyReport(simulation, snapshotPolicy, evolution.effectiveRakeBps, recentSettlements.rows);
    // ROUND-ONLY ELIGIBILITY: the ticket holders of the next draw are the
    // seats of the round that will settle next (the queued round on a settled
    // table, the open/flying round otherwise), weighted by stake.
    const eligibleSeats = room.phase === "settled" ? (nextRoundSeats?.rows ?? []) : seats.rows;
    const eligibleRound = room.phase === "settled" ? BigInt(room.current_round) + 1n : BigInt(room.current_round);
    const roundStake = eligibleSeats.reduce((sum, row) => sum + BigInt(row.stake), 0n);
    const myRoundStake = eligibleSeats.filter((row) => row.user_id === identity.id).reduce((sum, row) => sum + BigInt(row.stake), 0n);
    const myOdds = playerRoundOdds(economy.lottery.thresholdE18, myRoundStake, roundStake, economy.lottery.winnerTake);
    const revealVisible = room.phase === "settled" ? room.reveal : null;
    const crashVisible = room.phase === "settled" ? room.crash_bps : null;
    return {
      schema: "plank.live-lab.snapshot.v1", serverNow: new Date().toISOString(),
      room: {
        id: room.id, joinCode: room.join_code, name: room.name, ownerUserId: room.owner_user_id,
        isOwner: room.owner_user_id === identity.id || identity.isAdmin, isAdmin: identity.isAdmin, rulesHash: room.rules_hash,
        phase: room.phase, version: room.version, currentRound: room.current_round,
        commitment: room.commitment, reveal: revealVisible, crashBps: crashVisible,
        // Room constant: how far behind authoritative time this table's
        // presentation runs, and therefore the exact law a manual lock is
        // granted under (m(arrival − displayLagMs)).
        displayLagMs: PLAYTEST_DISPLAY_LAG_MS,
        startedAt: room.started_at?.toISOString() ?? null,
        // The exact deadline is economically equivalent to the unrevealed
        // crash point. It becomes auditable only after settlement.
        crashAt: room.phase === "settled" ? room.crash_at?.toISOString() ?? null : null,
        settledAt: room.settled_at?.toISOString() ?? null,
        nextLaunchAt: room.settled_at
          ? new Date(room.settled_at.getTime() + PLAYTEST_INTERMISSION_MS).toISOString()
          : null,
      },
      policy: room.policy, simulation: room.simulation_state,
      evolution: serializeBigInts(evolution),
      economy: serializeBigInts(economy),
      powerboard: {
        eligibleRound: eligibleRound.toString(),
        roundStake: roundStake.toString(),
        myStake: myRoundStake.toString(),
        participantCount: eligibleSeats.length,
        balls: PLAYTEST_POWERBOARD_BALLS,
        allocationRule: "round-only-stake-weight-v2",
        quote: serializeBigInts(myOdds),
      },
      members: members.rows.map((row) => ({ id: row.user_id, displayName: row.display_name, balance: row.test_credit_balance, isBot: row.is_bot, botProfile: row.bot_profile })),
      seats: seats.rows.map((row) => ({
        userId: row.user_id, displayName: row.display_name, stake: row.stake,
        // A planned auto-lock is private strategy until it executes. Accepted
        // locks are historical public table actions; settled targets are
        // auditable after the outcome is immutable.
        requestedTargetBps: row.user_id === identity.id || room.phase === "settled" ? row.requested_target_bps : null,
        acceptedTargetBps: row.accepted_target_bps,
        autoLockEnabled: row.auto_lock_enabled,
        payout: row.payout, net: row.net, survived: row.survived, lockedAt: row.locked_at?.toISOString() ?? null,
      })),
      nextRoundSeats: (nextRoundSeats?.rows ?? []).map((row) => ({
        userId: row.user_id, displayName: row.display_name, stake: row.stake,
        requestedTargetBps: row.user_id === identity.id ? row.requested_target_bps : null,
        autoLockEnabled: row.auto_lock_enabled,
      })),
      events: events.rows.reverse().map((row) => ({ sequence: row.sequence, type: row.event_type, commandId: row.command_id, payload: row.public_payload, at: row.created_at.toISOString() })),
      currentSettlement: currentSettlement?.rows[0]
        ? { sequence: currentSettlement.rows[0].sequence, type: "round.settled", payload: currentSettlement.rows[0].public_payload, at: currentSettlement.rows[0].created_at.toISOString() }
        : null,
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

export async function placePlaytestBet(identity: PlaytestIdentity, roomId: string, commandId: string, stake: bigint, targetBps: bigint, autoLockEnabled: boolean) {
  if (stake <= 0n || targetBps < 10_100n || targetBps > 1_000_000n) throw new PlaytestRoomError(400, "BAD_BET", "Stake or target is outside the laboratory range.");
  return withPostgresTransaction(async (client) => {
    const room = await lockedRoom(client, roomId); await requireMember(client, roomId, identity.id);
    if (await duplicateCommand(client, roomId, commandId)) return { duplicate: true };
    if (room.phase === "running") throw new PlaytestRoomError(409, "BETTING_CLOSED", "The current round is already running.");
    const roundId = bettingRoundId(room.phase, BigInt(room.current_round));
    const prior = await client.query<{ stake: string }>(`SELECT stake::text FROM playtest_round_seats WHERE room_id=$1 AND round_id=$2 AND user_id=$3 FOR UPDATE`, [roomId, roundId.toString(), identity.id]);
    const priorStake = BigInt(prior.rows[0]?.stake ?? "0");
    const balanceRow = await client.query<{ test_credit_balance: string }>(`SELECT test_credit_balance::text FROM playtest_room_members WHERE room_id=$1 AND user_id=$2 FOR UPDATE`, [roomId, identity.id]);
    const available = BigInt(balanceRow.rows[0].test_credit_balance) + priorStake;
    if (stake > available) throw new PlaytestRoomError(409, "INSUFFICIENT_TEST_CREDITS", "Not enough test credits.");
    await client.query(`UPDATE playtest_room_members SET test_credit_balance=$3 WHERE room_id=$1 AND user_id=$2`, [roomId, identity.id, (available - stake).toString()]);
    await client.query(
      `INSERT INTO playtest_round_seats (room_id,round_id,user_id,stake,requested_target_bps,auto_lock_enabled,command_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (room_id,round_id,user_id) DO UPDATE SET
         stake=EXCLUDED.stake, requested_target_bps=EXCLUDED.requested_target_bps,
         auto_lock_enabled=EXCLUDED.auto_lock_enabled, command_id=EXCLUDED.command_id, placed_at=NOW()`,
      [roomId, roundId.toString(), identity.id, stake.toString(), targetBps.toString(), autoLockEnabled, commandId],
    );
    room.version = String(BigInt(room.version) + 1n);
    if (room.phase === "settled") {
      // Queue the next-round seat without erasing the conclusion theater.
      // The authoritative auto-launch advances current_round atomically.
      await client.query(`UPDATE playtest_rooms SET version=$2 WHERE id=$1`, [roomId, room.version]);
    } else {
      room.current_round = roundId.toString();
      await client.query(`UPDATE playtest_rooms SET version=$2,current_round=$3,phase='lobby',commitment=NULL,reveal=NULL,crash_bps=NULL,started_at=NULL,crash_at=NULL,settled_at=NULL WHERE id=$1`, [roomId, room.version, room.current_round]);
    }
    // Stake is shared table state; the requested auto-lock is private player
    // strategy until it executes (or the immutable round settles).
    await event(client, room, "bet.accepted", identity.id, commandId, { stake });
    return { duplicate: false, version: room.version };
  });
}

export async function startPlaytestRound(identity: PlaytestIdentity, roomId: string, commandId: string, automated = false) {
  return withPostgresTransaction(async (client) => {
    const room = await lockedRoom(client, roomId); await requireMember(client, roomId, identity.id);
    if (!automated && room.owner_user_id !== identity.id && !identity.isAdmin) throw new PlaytestRoomError(403, "OWNER_ONLY", "Only the room host can launch.");
    if (await duplicateCommand(client, roomId, commandId)) return { duplicate: true };
    if (room.phase === "running") throw new PlaytestRoomError(409, "NOT_READY", "The current round is already running.");
    if (automated) {
      if (room.phase !== "settled" || !room.settled_at) throw new PlaytestRoomError(409, "NOT_READY", "No settled intermission is ready.");
      if (Date.now() < room.settled_at.getTime() + PLAYTEST_INTERMISSION_MS) throw new PlaytestRoomError(409, "INTERMISSION_ACTIVE", "The 30-second table intermission is still active.");
    }
    const launchRound = room.phase === "settled" ? BigInt(room.current_round) + 1n : BigInt(room.current_round);
    if (launchRound < 1n) throw new PlaytestRoomError(409, "NOT_READY", "The room needs a round with bets.");
    room.current_round = launchRound.toString();
    const storedPolicy = room.policy as Record<string, unknown>;
    let policy = parsePolicy(room.policy);
    // The public laboratory advances legacy tables at the round boundary,
    // never mid-flight. Historical rounds retain their committed descriptor.
    // A room whose stored prize tuple equals ANY superseded shipped default
    // (v1 25%/100k, v2 100%/1M) is advanced to the current default; bespoke
    // host-edited tuples are left alone.
    const legacyPrize = legacyPlaytestPrizeProfile(storedPolicy);
    const legacyPrizeProfile = legacyPrize !== null;
    let policyMigration: Record<string, unknown> | null = null;
    const legacyEvolutionProfile = storedPolicy.rakeFloorBps === undefined
      || storedPolicy.rakeStepBps === undefined
      || storedPolicy.rakeVolumeStep === undefined;
    const legacyMinimumStake = policy.minimumStake === 100n;
    if (policy.allocationRule !== "ccs-2l" || legacyPrizeProfile || legacyEvolutionProfile || legacyMinimumStake) {
      policy = {
        ...policy,
        allocationRule: "ccs-2l",
        ...(legacyPrizeProfile ? Object.fromEntries(PLAYTEST_PRIZE_PROFILE_KEYS.map((key) => [key, DEFAULT_PLAYTEST_POLICY[key]])) : {}),
        ...(legacyMinimumStake ? { minimumStake: DEFAULT_PLAYTEST_POLICY.minimumStake } : {}),
      };
      validatePolicy(policy);
      room.policy = serializeBigInts(policy);
      room.rules_hash = playtestRulesHash(policy);
      if (legacyPrize) {
        // The pre-actuarial lottery state (cycle base / reset reserve /
        // rollover) is migrated to the pool model by parseSimulationState,
        // conserving accounted assets exactly; every credit it held is on the
        // board and immediately drawable under the actuarial rule.
        const migrated = parseSimulationState(room.simulation_state);
        room.simulation_state = serializeSimulationState(migrated);
        policyMigration = {
          prizeProfile: { from: legacyPrize, to: CURRENT_PLAYTEST_PRIZE_PROFILE },
          policy: serializeBigInts(Object.fromEntries(PLAYTEST_PRIZE_PROFILE_KEYS.map((key) => [key, { from: storedPolicy[key] ?? null, to: policy[key] }]))),
          retiredKeys: LEGACY_LOTTERY_POLICY_KEYS.filter((key) => storedPolicy[key] !== undefined),
          lotteryPool: migrated.lottery.pool.toString(),
        };
      }
    }
    // An invitation means "join the next flight", not "silently spectate".
    // Seat only humans who arrived after the most recent settlement, and only
    // for this welcome flight. Established/offline members are never auto-bet.
    const newcomers = await client.query<{ user_id: string; test_credit_balance: string }>(
      `SELECT m.user_id,m.test_credit_balance::text
         FROM playtest_room_members m
         JOIN playtest_users u ON u.id=m.user_id AND u.is_bot=FALSE
         JOIN playtest_rooms r ON r.id=m.room_id
        WHERE m.room_id=$1
          AND m.joined_at>COALESCE(
            (SELECT MAX(e.created_at) FROM playtest_room_events e
              WHERE e.room_id=$1 AND e.event_type='round.settled'),
            r.created_at
          )
          AND NOT EXISTS (
            SELECT 1 FROM playtest_round_seats s
             WHERE s.room_id=m.room_id AND s.round_id=$2 AND s.user_id=m.user_id
          )
        ORDER BY m.joined_at FOR UPDATE OF m`,
      [roomId, room.current_round],
    );
    const welcomed: string[] = [];
    for (const newcomer of newcomers.rows) {
      const plan = newcomerSeatPlan(BigInt(newcomer.test_credit_balance), policy.minimumStake);
      if (!plan) continue;
      const inserted = await client.query(
        `INSERT INTO playtest_round_seats
           (room_id,round_id,user_id,stake,requested_target_bps,auto_lock_enabled,command_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [roomId, room.current_round, newcomer.user_id, plan.stake.toString(), plan.targetBps.toString(), plan.autoLockEnabled, randomUUID()],
      );
      if (!inserted.rowCount) continue;
      await client.query(
        `UPDATE playtest_room_members SET test_credit_balance=test_credit_balance-$3
          WHERE room_id=$1 AND user_id=$2`,
        [roomId, newcomer.user_id, plan.stake.toString()],
      );
      welcomed.push(newcomer.user_id);
    }
    const bots = await client.query<{ user_id: string; test_credit_balance: string; bot_profile: PlaytestBotProfile }>(
      `SELECT user_id,test_credit_balance::text,bot_profile
         FROM playtest_room_members
        WHERE room_id=$1 AND bot_profile IS NOT NULL
        ORDER BY user_id FOR UPDATE`, [roomId],
    );
    const committed: Array<{ id: string; stake: bigint; targetBps: bigint; preset: string }> = [];
    for (const bot of bots.rows) {
      try { validateBotProfile(bot.bot_profile); } catch { continue; }
      const choice = botRoundCommitment({ roomId, roundId: BigInt(room.current_round), botId: bot.user_id, bankroll: BigInt(bot.test_credit_balance), minimumStake: policy.minimumStake, profile: bot.bot_profile });
      if (!choice) continue;
      const inserted = await client.query(
        `INSERT INTO playtest_round_seats (room_id,round_id,user_id,stake,requested_target_bps,auto_lock_enabled,command_id)
         VALUES ($1,$2,$3,$4,$5,TRUE,$6) ON CONFLICT (room_id,round_id,user_id) DO NOTHING`,
        [roomId, room.current_round, bot.user_id, choice.stake.toString(), choice.targetBps.toString(), randomUUID()],
      );
      if (inserted.rowCount) {
        await client.query(`UPDATE playtest_room_members SET test_credit_balance=test_credit_balance-$3 WHERE room_id=$1 AND user_id=$2`, [roomId, bot.user_id, choice.stake.toString()]);
        committed.push({ id: bot.user_id, ...choice, preset: bot.bot_profile.preset });
      }
    }
    const count = await client.query<{ count: string }>(`SELECT COUNT(*)::text count FROM playtest_round_seats WHERE room_id=$1 AND round_id=$2`, [roomId, room.current_round]);
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
      `UPDATE playtest_rooms SET phase='running',version=$2,current_round=$3,commitment=$4,reveal=$5,crash_bps=$6,started_at=$7,crash_at=$8,settled_at=NULL,policy=$9,rules_hash=$10,simulation_state=$11 WHERE id=$1`,
      [roomId, room.version, room.current_round, commitment, reveal, crashBps.toString(), started, crashAt, JSON.stringify(room.policy), room.rules_hash, JSON.stringify(room.simulation_state)],
    );
    // Never publish crashAt while the round is live. A deadline is merely the
    // unrevealed crash multiplier expressed in time, so exposing it defeats
    // commit/reveal even when crash_bps and reveal remain private.
    await event(client, room, "round.launched", identity.id, commandId, {
      commitment,
      startedAt: started.toISOString(),
      settlement: settlementDescriptor(policy.allocationRule),
      evolution: serializeBigInts(evolutionQuote(policy, parseSimulationState(room.simulation_state).totals.freshWagers)),
      ...(policyMigration ? { policyMigration } : {}),
    });
    if (welcomed.length) await event(client, room, "newcomers.seated", identity.id, null, {
      count: welcomed.length, stake: policy.minimumStake, targetBps: 20_000n, autoLockEnabled: false,
    });
    if (committed.length) await event(client, room, "bots.committed", identity.id, null, {
      count: committed.length,
      presets: committed.reduce<Record<string, number>>((counts, bot) => {
        counts[bot.preset] = (counts[bot.preset] ?? 0) + 1;
        return counts;
      }, {}),
    });
    return { duplicate: false, version: room.version };
  });
}

export async function lockPlaytestBet(identity: PlaytestIdentity, roomId: string, commandId: string) {
  return withPostgresTransaction(async (client) => {
    const room = await lockedRoom(client, roomId); await requireMember(client, roomId, identity.id);
    if (await duplicateCommand(client, roomId, commandId)) return { duplicate: true };
    if (room.phase !== "running" || !room.started_at || !room.crash_at) throw new PlaytestRoomError(409, "NOT_RUNNING", "No round is currently running.");
    const now = Date.now();
    // FAIL-CLOSED, checked FIRST and on server ARRIVAL time only: a request
    // arriving after the authoritative crash is rejected regardless of what
    // its lagged grant would have been. A fast observer watching the raw feed
    // gains nothing by tapping once the crash is known — arrival-after-crash
    // always fails.
    if (now >= room.crash_at.getTime()) throw new PlaytestRoomError(409, "TOO_LATE", "The authoritative crash deadline has passed.");
    // HONEST LOCK GRANT: the multiplier an honest δ-lagged display was
    // showing when the player tapped — m(arrival − δ), the SAME shared law
    // kernel that settles. No client timestamp is trusted anywhere.
    const grantBps = laggedLockGrantBps(room.started_at.getTime(), now, PLAYTEST_DISPLAY_LAG_MS);
    if (grantBps === null) throw new PlaytestRoomError(409, "NOT_FLYING", "The displayed flight has not lifted off yet.");
    const accepted = BigInt(grantBps);
    if (accepted < 10_100n) throw new PlaytestRoomError(409, "TOO_EARLY", "Lock opens at 1.01x.");
    const seat = await client.query<{ requested_target_bps: string; accepted_target_bps: string | null; auto_lock_enabled: boolean }>(
      `SELECT requested_target_bps::text,accepted_target_bps::text,auto_lock_enabled
         FROM playtest_round_seats WHERE room_id=$1 AND round_id=$2 AND user_id=$3 FOR UPDATE`,
      [roomId, room.current_round, identity.id],
    );
    const currentSeat = seat.rows[0];
    if (!currentSeat || currentSeat.accepted_target_bps !== null) throw new PlaytestRoomError(409, "NO_ACTIVE_BET", "No unlocked bet exists for this round.");
    if (currentSeat.auto_lock_enabled && accepted >= BigInt(currentSeat.requested_target_bps)) {
      throw new PlaytestRoomError(409, "AUTO_TARGET_EXECUTED", "Your pre-locked multiplier already executed; a later manual lock cannot raise it.");
    }
    const updated = await client.query(
      `UPDATE playtest_round_seats SET accepted_target_bps=$4,locked_at=NOW()
        WHERE room_id=$1 AND round_id=$2 AND user_id=$3 AND accepted_target_bps IS NULL`,
      [roomId, room.current_round, identity.id, accepted.toString()],
    );
    if (!updated.rowCount) throw new PlaytestRoomError(409, "NO_ACTIVE_BET", "No unlocked bet exists for this round.");
    room.version = String(BigInt(room.version) + 1n);
    await client.query(`UPDATE playtest_rooms SET version=$2 WHERE id=$1`, [roomId, room.version]);
    await event(client, room, "lock.accepted", identity.id, commandId, { acceptedTargetBps: accepted, serverAcceptedAt: new Date(now).toISOString(), displayLagMs: PLAYTEST_DISPLAY_LAG_MS });
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
    const seats = await client.query<{ user_id: string; stake: string; requested_target_bps: string; accepted_target_bps: string | null; auto_lock_enabled: boolean }>(
      `SELECT user_id,stake::text,requested_target_bps::text,accepted_target_bps::text,auto_lock_enabled
         FROM playtest_round_seats WHERE room_id=$1 AND round_id=$2 ORDER BY user_id FOR UPDATE`,
      [roomId, room.current_round],
    );
    const policy = parsePolicy(room.policy);
    const prior = parseSimulationState(room.simulation_state);
    // The draw sample is derived from the already-committed reveal; the
    // engine prices it against THIS round's own contribution (actuarial rule).
    const powerboardDraw = powerboardRoundDraw(room.reveal!);
    const result = simulateIteration(prior, policy, {
      players: seats.rows.map((seat) => ({ id: seat.user_id, stake: BigInt(seat.stake), targetBps: effectiveSettlementTarget(BigInt(room.crash_bps!), BigInt(seat.requested_target_bps), seat.accepted_target_bps === null ? null : BigInt(seat.accepted_target_bps), seat.auto_lock_enabled) })),
      crashBps: BigInt(room.crash_bps), lotteryOutcome, lotteryDrawE18: powerboardDraw.sampleE18,
    });
    const powerboardFundingAdded = result.state.totals.powerboardFunded - prior.totals.powerboardFunded;
    // The simulator is the accounting authority: the winner receives exactly
    // the carve's W for the prize that was on the board before this round.
    const lotteryPayout = result.state.totals.lotteryWinnerPayouts - prior.totals.lotteryWinnerPayouts;
    // ROUND-ONLY ELIGIBILITY: the stake-weighted ticket among THIS round's seats.
    const roundTickets = seats.rows.map((row) => ({ id: row.user_id, weight: BigInt(row.stake) }));
    const roundTotalWeight = roundTickets.reduce((sum, ticket) => sum + ticket.weight, 0n);
    let lotteryWinner: { userId: string; displayName: string; payout: string; round: string } | null = null;
    if (result.lotteryEvent === "hit") {
      const winner = weightedTicketWinner(roundTickets, `${room.reveal}:powerboard:ticket:${room.current_round}`);
      if (!winner) throw new PlaytestRoomError(409, "NO_LOTTERY_TICKETS", "This round has no eligible seats.");
      if (lotteryPayout <= 0n) throw new PlaytestRoomError(409, "NO_LOTTERY_PAYOUT", "The lottery hit did not produce a payable prize.");
      const name = await client.query<{ display_name: string }>(`SELECT display_name FROM playtest_users WHERE id=$1`, [winner.id]);
      await client.query(`UPDATE playtest_room_members SET test_credit_balance=test_credit_balance+$3 WHERE room_id=$1 AND user_id=$2`, [roomId, winner.id, lotteryPayout.toString()]);
      lotteryWinner = { userId: winner.id, displayName: name.rows[0]?.display_name ?? "player", payout: lotteryPayout.toString(), round: room.current_round };
    }
    for (const allocation of result.settlement?.allocations ?? []) {
      const originalSeat = seats.rows.find((seat) => seat.user_id === allocation.id);
      const autoAccepted = allocation.survived && originalSeat?.accepted_target_bps === null && originalSeat.auto_lock_enabled;
      const autoLockedAt = autoAccepted && room.started_at
        ? new Date(room.started_at.getTime() + crashDurationMs(allocation.targetBps))
        : null;
      await client.query(
        `UPDATE playtest_round_seats
            SET payout=$4,net=$5,survived=$6,
                accepted_target_bps=COALESCE(accepted_target_bps,$7),
                locked_at=COALESCE(locked_at,$8)
          WHERE room_id=$1 AND round_id=$2 AND user_id=$3`,
        [roomId, room.current_round, allocation.id, allocation.payout.toString(), allocation.net.toString(), allocation.survived,
          autoAccepted ? allocation.targetBps.toString() : null, autoLockedAt],
      );
      await client.query(`UPDATE playtest_room_members SET test_credit_balance=test_credit_balance+$3 WHERE room_id=$1 AND user_id=$2`, [roomId, allocation.id, allocation.payout.toString()]);
    }
    room.version = String(BigInt(room.version) + 1n); room.phase = "settled"; room.settled_at = new Date();
    room.simulation_state = serializeSimulationState(result.state);
    await client.query(`UPDATE playtest_rooms SET phase='settled',version=$2,simulation_state=$3,settled_at=$4 WHERE id=$1`, [roomId, room.version, JSON.stringify(room.simulation_state), room.settled_at]);
    await event(client, room, "round.settled", identity.id, commandId, {
      crashBps: room.crash_bps, reveal: room.reveal, lotteryEvent: result.lotteryEvent,
      qualified: result.qualified, accounting: result.settlement, lotteryWinner,
      settlement: settlementDescriptor(policy.allocationRule),
      effectiveRakeBps: result.effectiveRakeBps.toString(),
      evolutionTier: result.evolutionTier.toString(),
      powerboardFundingAdded: powerboardFundingAdded.toString(),
      // Economy panel provenance (2026-09-03): the Vault movement, the flight
      // seed and the reserves it was drawn against, so every player can see
      // exactly what this round added to the Vault and what the Vault gave
      // the game. All strings; additive.
      seed: result.seed.toString(),
      reservesBeforeSeed: (prior.protectedPrincipal + prior.emissionBuffer).toString(),
      vaultBefore: prior.protectedPrincipal.toString(),
      vaultAfter: result.state.protectedPrincipal.toString(),
      vaultAdded: (result.state.protectedPrincipal - prior.protectedPrincipal).toString(),
      emissionBufferAfter: result.state.emissionBuffer.toString(),
      // The draw record (mirror of PlankLottery's Draw event): prize on the
      // board, the round's contribution, the threshold it was priced at, the
      // committed sample, W and S. Displayed == redeemable.
      lotteryPrize: (result.lotteryDraw?.prize ?? 0n).toString(),
      lotteryThresholdE18: (result.lotteryDraw?.thresholdE18 ?? 0n).toString(),
      lotteryWinnerPaid: (result.lotteryDraw?.winnerPaid ?? 0n).toString(),
      lotterySeeded: (result.lotteryDraw?.seeded ?? 0n).toString(),
      lotteryPrizeAfter: result.state.lottery.committedPrize.toString(),
      powerboardPool: {
        round: room.current_round, totalWeight: roundTotalWeight.toString(),
        weights: roundTickets.map((ticket) => ({ userId: ticket.id, weight: ticket.weight.toString() })),
      },
      powerboardDraw: {
        sampleE18: powerboardDraw.sampleE18.toString(),
        drawnNumber: powerboardDraw.drawnNumber,
        balls: powerboardDraw.balls,
        winningNumber: powerboardDraw.winningNumber,
        thresholdE18: (result.lotteryDraw?.thresholdE18 ?? 0n).toString(),
        probOne: PROB_ONE.toString(),
        // A uniform sample exists every round, but it is a payable draw only
        // when a prize was on the board before this round settled. This
        // prevents a funding-round sample from masquerading as an unpaid
        // jackpot hit in every connected client's presentation.
        drawActive: result.lotteryEvent === "hit" || result.lotteryEvent === "miss",
        payableHit: result.lotteryEvent === "hit",
        naturalHit: result.lotteryDraw?.natural ?? null,
        forcedForSimulation: Boolean(result.lotteryDraw?.forced),
      },
    });
    return { duplicate: false, version: room.version };
  });
}

/** Permissionless laboratory keeper. The lottery branch is derived from the
 * already committed round reveal, so a caller cannot choose it after crash. */
export async function tickPlaytestRound(identity: PlaytestIdentity, roomId: string, commandId: string) {
  const found = await postgresQuery<{ phase: "running" | "settled" | "lobby"; reveal: string | null; settled_at: Date | null }>(
    `SELECT r.phase,r.reveal,r.settled_at FROM playtest_rooms r
       JOIN playtest_room_members m ON m.room_id=r.id AND m.user_id=$2
      WHERE r.id=$1 AND r.archived_at IS NULL`, [roomId, identity.id],
  );
  const row = found.rows[0];
  if (row?.phase === "settled") return startPlaytestRound(identity, roomId, commandId, true);
  const reveal = row?.reveal;
  if (!reveal || row?.phase !== "running") throw new PlaytestRoomError(409, "NOT_RUNNING", "No committed round can be ticked.");
  // "none" = natural: the engine compares the committed sample with the
  // round's actuarial threshold; no caller can choose the branch.
  const outcome: LotteryOutcome = "none";
  return settlePlaytestRound(identity, roomId, commandId, outcome, false);
}

const EDITABLE_POLICY_KEYS = new Set<keyof SimulationPolicy>([
  "keeperRewardBps", "protectedPrincipalBps", "crashSeed", "emissionBufferCap",
  "powerboardFundingBps",
  "lotteryFounderFeeBps", "lotteryOddsOneIn", "lotteryKappaBps",
  "carveMinBps", "carveMaxBps", "carveHalfSaturation",
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

/** Server-internal poll state. `due` is deliberately never serialized to a
 * participant; exposing it would disclose the committed crash deadline. */
export async function playtestRoomPollState(identity: PlaytestIdentity, roomId: string): Promise<{ version: string; due: boolean }> {
  const result = await postgresQuery<{ version: string; due: boolean }>(
    `SELECT r.version::text,
            ((r.phase='running' AND r.crash_at IS NOT NULL AND r.crash_at<=NOW()) OR
             (r.phase='settled' AND r.settled_at IS NOT NULL AND r.settled_at + INTERVAL '30 seconds'<=NOW())) AS due
       FROM playtest_rooms r
       JOIN playtest_room_members m ON m.room_id=r.id AND m.user_id=$2
      WHERE r.id=$1 AND r.archived_at IS NULL`, [roomId, identity.id],
  );
  if (!result.rows[0]) throw new PlaytestRoomError(404, "ROOM_NOT_FOUND", "Room not found.");
  return result.rows[0];
}

type BotCommand = {
  operation?: unknown; count?: unknown; preset?: unknown; bankroll?: unknown;
  ids?: unknown; profile?: unknown; resetBalance?: unknown;
};

/** Admin-only population laboratory. Synthetic participants are ordinary
 * bankroll-constrained seats at settlement time; they receive no subsidy,
 * crash knowledge, payout priority, or access credential. */
export async function managePlaytestBots(identity: PlaytestIdentity, roomId: string, commandId: string, raw: unknown) {
  if (!identity.isAdmin) throw new PlaytestRoomError(403, "ADMIN_ONLY", "The host PIN is required.");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PlaytestRoomError(400, "BAD_BOT_COMMAND", "Bot changes must be an object.");
  const input = raw as BotCommand;
  return withPostgresTransaction(async (client) => {
    const room = await lockedRoom(client, roomId); await requireMember(client, roomId, identity.id);
    if (await duplicateCommand(client, roomId, commandId)) return { duplicate: true };
    if (room.phase === "running") throw new PlaytestRoomError(409, "ROUND_ACTIVE", "Tune synthetic participants between rounds.");
    let affected: string[] = [];
    if (input.operation === "add") {
      const count = Number(input.count);
      const requestedPreset = String(input.preset);
      const bankrollText = String(input.bankroll);
      if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new PlaytestRoomError(400, "BAD_BOT_COUNT", "Add between 1 and 100 bots at once.");
      if ((requestedPreset !== "mixed" && !BOT_PROFILE_NAMES.includes(requestedPreset as BotProfileName)) || !/^\d{1,30}$/.test(bankrollText) || BigInt(bankrollText) <= 0n) throw new PlaytestRoomError(400, "BAD_BOT_PROFILE", "Choose a valid profile and positive bankroll.");
      const existing = await client.query<{ count: string }>(`SELECT COUNT(*)::text count FROM playtest_room_members WHERE room_id=$1 AND bot_profile IS NOT NULL`, [roomId]);
      if (Number(existing.rows[0].count) + count > 500) throw new PlaytestRoomError(409, "BOT_CAP", "A table supports at most 500 active synthetic participants.");
      const mixedPopulation: BotProfileName[] = [
        ...Array<BotProfileName>(25).fill("cautious"), ...Array<BotProfileName>(35).fill("balanced"),
        ...Array<BotProfileName>(15).fill("bold"), ...Array<BotProfileName>(5).fill("whale"),
        ...Array<BotProfileName>(8).fill("house-money"), ...Array<BotProfileName>(7).fill("break-even"),
        ...Array<BotProfileName>(5).fill("wildcard"),
      ];
      for (let index = 0; index < count; index += 1) {
        const preset = requestedPreset === "mixed"
          ? mixedPopulation[(Number(existing.rows[0].count) + index) % mixedPopulation.length]
          : requestedPreset as BotProfileName;
        const id = randomUUID();
        const ordinal = Number(existing.rows[0].count) + index + 1;
        const displayName = `${preset.replace("-", " ")} bot ${ordinal}`.slice(0, 40);
        const profile = botProfile(preset, BigInt(bankrollText));
        const inviteHash = createHash("sha256").update(`playtest-bot:${id}`).digest("hex");
        await client.query(`INSERT INTO playtest_users (id,display_name,invite_hash,is_bot) VALUES ($1,$2,$3,TRUE)`, [id, displayName, inviteHash]);
        await client.query(`INSERT INTO playtest_room_members (room_id,user_id,test_credit_balance,bot_profile) VALUES ($1,$2,$3,$4)`, [roomId, id, bankrollText, JSON.stringify(profile)]);
        affected.push(id);
      }
    } else if (input.operation === "update") {
      const ids = Array.isArray(input.ids) ? [...new Set(input.ids.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 500) : [];
      if (!ids.length) throw new PlaytestRoomError(400, "NO_BOTS", "Select at least one synthetic participant.");
      validateBotProfile(input.profile);
      const reset = input.resetBalance === true;
      const changed = await client.query<{ user_id: string }>(
        `UPDATE playtest_room_members m SET bot_profile=$3${reset ? ",test_credit_balance=$4" : ""}
          FROM playtest_users u WHERE m.room_id=$1 AND m.user_id=u.id AND u.is_bot=TRUE AND m.user_id=ANY($2::uuid[])
          RETURNING m.user_id`,
        reset ? [roomId, ids, JSON.stringify(input.profile), input.profile.initialBankroll] : [roomId, ids, JSON.stringify(input.profile)],
      );
      affected = changed.rows.map((row) => row.user_id);
    } else if (input.operation === "remove") {
      const ids = Array.isArray(input.ids) ? [...new Set(input.ids.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 500) : [];
      if (!ids.length) throw new PlaytestRoomError(400, "NO_BOTS", "Select at least one synthetic participant.");
      const pending = await client.query<{ user_id: string; stake: string }>(`DELETE FROM playtest_round_seats WHERE room_id=$1 AND round_id=$2 AND user_id=ANY($3::uuid[]) RETURNING user_id,stake::text`, [roomId, room.current_round, ids]);
      for (const seat of pending.rows) await client.query(`UPDATE playtest_room_members SET test_credit_balance=test_credit_balance+$3 WHERE room_id=$1 AND user_id=$2`, [roomId, seat.user_id, seat.stake]);
      const removed = await client.query<{ user_id: string }>(`DELETE FROM playtest_room_members m USING playtest_users u WHERE m.room_id=$1 AND m.user_id=u.id AND u.is_bot=TRUE AND m.user_id=ANY($2::uuid[]) RETURNING m.user_id`, [roomId, ids]);
      affected = removed.rows.map((row) => row.user_id);
    } else throw new PlaytestRoomError(400, "BAD_BOT_OPERATION", "Unknown synthetic-participant operation.");
    room.version = String(BigInt(room.version) + 1n);
    await client.query(`UPDATE playtest_rooms SET version=$2 WHERE id=$1`, [roomId, room.version]);
    // Bot tuning is host strategy and must not be broadcast through the
    // participant replay stream. Members only need the resulting seat state.
    await event(client, room, `admin.bots.${String(input.operation)}`, identity.id, commandId, { affected, laboratoryOnly: true });
    return { duplicate: false, version: room.version, affected };
  });
}

/** Explicit admin-only scenario injection for the no-value laboratory. This
 * never runs as part of normal settlement and is permanently identified in
 * the room replay log so injected state cannot be mistaken for earned state. */
export async function adjustPlaytestSimulation(identity: PlaytestIdentity, roomId: string, commandId: string, patch: unknown) {
  if (!identity.isAdmin) throw new PlaytestRoomError(403, "ADMIN_ONLY", "The host PIN is required.");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new PlaytestRoomError(400, "BAD_SIMULATION_PATCH", "Simulation changes must be an object.");
  return withPostgresTransaction(async (client) => {
    const room = await lockedRoom(client, roomId); await requireMember(client, roomId, identity.id);
    if (await duplicateCommand(client, roomId, commandId)) return { duplicate: true };
    if (room.phase === "running") throw new PlaytestRoomError(409, "ROUND_ACTIVE", "Inject scenarios between rounds.");
    let state;
    try { state = injectSimulationState(parseSimulationState(room.simulation_state), patch); }
    catch (error) { throw new PlaytestRoomError(400, "INVALID_SIMULATION_STATE", error instanceof Error ? error.message : "Invalid simulation state."); }
    room.version = String(BigInt(room.version) + 1n);
    room.simulation_state = serializeSimulationState(state);
    await client.query(`UPDATE playtest_rooms SET version=$2,simulation_state=$3 WHERE id=$1`, [room.id, room.version, JSON.stringify(room.simulation_state)]);
    await event(client, room, "admin.simulation.injected", identity.id, commandId, { patch, laboratoryOnly: true });
    return { duplicate: false, version: room.version };
  });
}
