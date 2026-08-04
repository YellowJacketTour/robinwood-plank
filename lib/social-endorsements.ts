import { postgresQuery } from "@/lib/postgres";
import { verifyWalletProof, type WalletProof } from "@/lib/wallet-proof";
import { getBadSeverity } from "@/lib/boards-store";
import {
  dilutedEndorsementWeight,
  rankByWeightedEndorsements,
  type Endorsement,
  type RankedTarget,
} from "@/lib/social-rankings";

/**
 * Endorsement I/O layer — see migration 008_social_endorsements.sql for the
 * storage table this reads/writes, and lib/social-rankings.ts for the pure
 * scoring/dilution math this feeds. This module is the trusted-caller
 * boundary: it re-derives every voter's Plank Checks point total and Bad
 * Boards standing from real server data (never a client-supplied value)
 * before computing a score, the same posture lib/plank-checks.ts and
 * lib/social-badges.ts already take.
 *
 * A NEW wallet-proof domain ("social-endorsements") is used, distinct from
 * "plank-checks" (wallet linking) and "social-badges" (badge claims) — a
 * captured endorsement signature must never be replayable to authorize a
 * badge claim or a wallet link, or vice versa.
 */

export const WALLET_PROOF_DOMAIN = "social-endorsements";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type EndorsementTargetType = "wallet" | "collection";

function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

function isValidTargetId(targetType: EndorsementTargetType, targetId: string): boolean {
  const trimmed = targetId.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return false;
  if (targetType === "wallet") return HEX_ADDRESS.test(trimmed);
  return true;
}

export type EndorseResult =
  | { ok: true }
  | { ok: false; error: "BAD_VOTER" | "BAD_TARGET" | "BAD_PROOF" };

/**
 * Verifies the endorse/unendorse request's signature only. Same split as
 * lib/social-badges.ts's verifyBadgeClaimProof — proves control of the
 * voting address, nothing about eligibility (endorsing has no eligibility
 * gate today; every real wallet may endorse, with its weight naturally zero
 * if it has no Plank Checks history, per endorsementWeight).
 */
export function verifyEndorsementProof(
  voterWallet: string,
  action: "endorse" | "unendorse",
  targetType: EndorsementTargetType,
  targetId: string,
  proof: WalletProof,
  now?: number
): boolean {
  const voter = voterWallet.toLowerCase();
  if (!HEX_ADDRESS.test(voter)) return false;
  const payloadJson = JSON.stringify({ voter, targetType, targetId: targetId.trim() });
  const verdict = verifyWalletProof(WALLET_PROOF_DOMAIN, action, payloadJson, proof, { now });
  return verdict.ok && verdict.address === voter;
}

export async function endorseTarget(
  voterWallet: string,
  targetType: EndorsementTargetType,
  targetId: string,
  proof: WalletProof
): Promise<EndorseResult> {
  const voter = normalizeAddress(voterWallet);
  if (!HEX_ADDRESS.test(voter)) return { ok: false, error: "BAD_VOTER" };
  if (!isValidTargetId(targetType, targetId)) return { ok: false, error: "BAD_TARGET" };
  const target = targetType === "wallet" ? targetId.trim().toLowerCase() : targetId.trim();
  if (!verifyEndorsementProof(voter, "endorse", targetType, target, proof)) {
    return { ok: false, error: "BAD_PROOF" };
  }

  await postgresQuery(
    `INSERT INTO social_endorsements (voter_wallet, target_type, target_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (voter_wallet, target_type, target_id) DO NOTHING`,
    [voter, targetType, target]
  );
  return { ok: true };
}

export async function unendorseTarget(
  voterWallet: string,
  targetType: EndorsementTargetType,
  targetId: string,
  proof: WalletProof
): Promise<EndorseResult> {
  const voter = normalizeAddress(voterWallet);
  if (!HEX_ADDRESS.test(voter)) return { ok: false, error: "BAD_VOTER" };
  if (!isValidTargetId(targetType, targetId)) return { ok: false, error: "BAD_TARGET" };
  const target = targetType === "wallet" ? targetId.trim().toLowerCase() : targetId.trim();
  if (!verifyEndorsementProof(voter, "unendorse", targetType, target, proof)) {
    return { ok: false, error: "BAD_PROOF" };
  }

  await postgresQuery(
    `DELETE FROM social_endorsements WHERE voter_wallet = $1 AND target_type = $2 AND target_id = $3`,
    [voter, targetType, target]
  );
  return { ok: true };
}

/**
 * Reputation-weighted ranking for every target of `targetType` that has at
 * least one live endorsement, re-deriving each voter's weight from real
 * server data:
 *  - Plank Checks point total (lib/plank-checks.ts's getLeaderboard, joined
 *    by wallet via plank_checks_wallets — see the JOIN below) and
 *  - Bad Boards standing (lib/boards-store.ts's getBadSeverity).
 * The per-voter dilution factor (lib/social-rankings.ts's
 * dilutedEndorsementWeight) is derived from a real COUNT(*) of that voter's
 * live rows in social_endorsements — never trusted from the client.
 */
export async function rankTargetsByEndorsement(
  targetType: EndorsementTargetType,
  opts?: { limit?: number }
): Promise<RankedTarget[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));

  const rows = await postgresQuery<{
    voter_wallet: string;
    target_id: string;
    live_count: string;
  }>(
    `SELECT voter_wallet, target_id,
            COUNT(*) OVER (PARTITION BY voter_wallet) AS live_count
       FROM social_endorsements
      WHERE target_type = $1`,
    [targetType]
  );
  if (rows.rows.length === 0) return [];

  const voterWallets = Array.from(new Set(rows.rows.map((r) => r.voter_wallet)));

  // Plank Checks point totals for exactly these voters, via the same
  // wallet-> profile -> events join getLeaderboard() uses, restricted to the
  // relevant wallets rather than pulling the whole leaderboard.
  const pointsResult = await postgresQuery<{ wallet_address: string; total_points: string }>(
    `SELECT w.wallet_address, COALESCE(SUM(e.points), 0)::numeric AS total_points
       FROM plank_checks_wallets w
       LEFT JOIN plank_checks_events e ON e.wallet_address = w.wallet_address
      WHERE w.wallet_address = ANY($1::text[])
      GROUP BY w.wallet_address`,
    [voterWallets]
  );
  const pointsByWallet = new Map<string, number>();
  for (const row of pointsResult.rows) {
    pointsByWallet.set(row.wallet_address, Number(row.total_points));
  }

  const severityByWallet = new Map<string, number>();
  await Promise.all(
    voterWallets.map(async (wallet) => {
      severityByWallet.set(wallet, await getBadSeverity(wallet));
    })
  );

  const endorsements: Endorsement[] = rows.rows.map((row) => ({
    targetId: row.target_id,
    voterId: row.voter_wallet,
    voter: {
      pointTotal: pointsByWallet.get(row.voter_wallet) ?? 0,
      badSeverity: severityByWallet.get(row.voter_wallet) ?? 0,
    },
  }));

  return rankByWeightedEndorsements(endorsements).slice(0, limit);
}

/** Re-exported so callers don't need a separate import for the pure helper. */
export { dilutedEndorsementWeight };

export async function getVoterLiveEndorsementCount(voterWallet: string): Promise<number> {
  const voter = normalizeAddress(voterWallet);
  if (!HEX_ADDRESS.test(voter)) return 0;
  const result = await postgresQuery<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM social_endorsements WHERE voter_wallet = $1`,
    [voter]
  );
  return Number(result.rows[0]?.n ?? 0);
}

export async function getVoterEndorsedTargets(
  voterWallet: string,
  targetType: EndorsementTargetType
): Promise<string[]> {
  const voter = normalizeAddress(voterWallet);
  if (!HEX_ADDRESS.test(voter)) return [];
  const result = await postgresQuery<{ target_id: string }>(
    `SELECT target_id FROM social_endorsements WHERE voter_wallet = $1 AND target_type = $2`,
    [voter, targetType]
  );
  return result.rows.map((row) => row.target_id);
}
