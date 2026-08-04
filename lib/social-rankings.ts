/**
 * Reputation-weighted collection/board rankings — pure scoring only, same
 * shape as lib/plank-checks.ts's pure point functions. A wallet's
 * endorsement (an "I back this collection/board" vote) is weighted by:
 *  1. its Plank Checks point total (lib/plank-checks.ts's
 *     plank_checks_events ledger) — real, chain-verified swap/LP/deposit/
 *     redeem/sale history, not a self-reported claim; and
 *  2. its Bad Boards / Nice Ledger standing (lib/boards-store.ts,
 *     lib/boards.ts's decayedBadSeverity) — a wallet currently flagged (or
 *     recently flagged and not yet decayed) counts for less.
 *
 * Callers fetch both inputs (a Postgres SUM and a boards-store read) and
 * pass plain numbers in — this module does no I/O, so the formula itself is
 * fully unit-testable without Postgres, matching every other pure function
 * in this codebase (plank-checks.test.ts, wallet-proof.test.ts).
 */

/** Endorsement weight uses sqrt(points), not points, so a single very large
 * point total cannot dominate the ranking the way a linear weight would —
 * a whale still counts more than a throwaway, but not a thousand times
 * more. */
function pointsWeight(pointTotal: number): number {
  if (!Number.isFinite(pointTotal) || pointTotal <= 0) return 0;
  return Math.sqrt(pointTotal);
}

/**
 * A wallet's standing multiplier: 1 for a clean wallet, floored at
 * MIN_STANDING_MULTIPLIER for a wallet at full (undecayed) Bad Boards
 * severity — never zero, so a bad wallet is heavily discounted rather than
 * given a silent on/off veto that could itself be gamed (e.g. mass-flagging
 * a rival's genuine supporters). Decays back toward 1 exactly as
 * decayedBadSeverity does (lib/boards.ts).
 */
export const MIN_STANDING_MULTIPLIER = 0.1;

export function standingMultiplier(badSeverity: number): number {
  const severity = Number.isFinite(badSeverity) ? Math.max(0, Math.min(1, badSeverity)) : 0;
  return 1 - severity * (1 - MIN_STANDING_MULTIPLIER);
}

export type EndorsementVoter = {
  /** All-time (or season) Plank Checks point total — lib/plank-checks.ts's getLeaderboard(). */
  pointTotal: number;
  /** 0 (clean) .. 1 (fully, undecayed, bad) — lib/boards-store.ts's getBadSeverity(). */
  badSeverity: number;
};

/**
 * A single voter's contribution to a ranking. Zero for a wallet with zero
 * real point history — a sybil throwaway wallet, which by construction has
 * never had a chain-verified swap/LP/deposit/redeem/sale/referral event
 * recorded against it, contributes nothing, not "a small amount." A wallet
 * with real history but currently flagged still contributes, just
 * discounted by standingMultiplier.
 */
export function endorsementWeight(voter: EndorsementVoter): number {
  return pointsWeight(voter.pointTotal) * standingMultiplier(voter.badSeverity);
}

export type Endorsement = {
  targetId: string;
  voter: EndorsementVoter;
};

export type RankedTarget = {
  targetId: string;
  score: number;
  voteCount: number;
};

/**
 * Aggregates endorsements into a reputation-weighted ranking, highest score
 * first. Ties broken by targetId for a stable, deterministic order (no
 * dependence on object/array iteration order across runs).
 */
export function rankByWeightedEndorsements(endorsements: readonly Endorsement[]): RankedTarget[] {
  const totals = new Map<string, { score: number; voteCount: number }>();
  for (const { targetId, voter } of endorsements) {
    const weight = endorsementWeight(voter);
    const existing = totals.get(targetId) ?? { score: 0, voteCount: 0 };
    existing.score += weight;
    existing.voteCount += 1;
    totals.set(targetId, existing);
  }
  return Array.from(totals.entries())
    .map(([targetId, { score, voteCount }]) => ({ targetId, score, voteCount }))
    .sort((a, b) => b.score - a.score || a.targetId.localeCompare(b.targetId));
}
