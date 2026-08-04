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
  /** Stable identity for the voter (normalized wallet address) — used only
   * to count how many LIVE endorsements this voter currently has out, for
   * the per-voter dilution below. Never used for anything else here (no
   * per-voter storage, no I/O — this module stays pure). */
  voterId: string;
  voter: EndorsementVoter;
};

export type RankedTarget = {
  targetId: string;
  score: number;
  voteCount: number;
};

/**
 * Per-voter dilution: a voter's endorsement weight toward EACH target is
 * divided by sqrt(number of live endorsements that voter currently has out
 * across all targets). This is the real fix for the pen-test finding that a
 * single high-point wallet could endorse unlimited targets at full weight
 * each — undiluted, one whale wallet could out-rank an entire target's
 * organic support just by clicking "endorse" on everything.
 *
 * Chose dilution over a hard cap for two reasons:
 *  1. A hard cap ("at most N live endorsements per voter") is a cliff: voter
 *     N+1 is rejected outright, which means UI has to surface a confusing
 *     "unendorse something else first" flow, and picking N is an arbitrary
 *     tuning knob with no principled value.
 *  2. sqrt dilution degrades gracefully and mirrors the sqrt(points)
 *     diminishing-returns shape pointsWeight() already uses above — a voter
 *     spreading across many targets keeps *some* voice everywhere (this is
 *     a curation signal, not a single-choice election), but their total
 *     influence summed across all targets is bounded: with k live
 *     endorsements each diluted by sqrt(k), the voter's total contributed
 *     weight across every target is weight * k / sqrt(k) = weight *
 *     sqrt(k) — growing sub-linearly in k instead of linearly (undiluted)
 *     or being flatly rejected past a cliff (hard cap). A whale can still
 *     make itself heard on more collections, but each additional
 *     endorsement is worth strictly less, and diluting toward a handful of
 *     targets is worth much less per-target than concentrating on one.
 *
 * k = 1 (the common case, one endorsement) divides by 1 — no dilution for a
 * normal voter. This function is pure and takes k directly so it stays
 * unit-testable without Postgres, same as the rest of this module; callers
 * (the endorse API route / rankings route) derive k from a real COUNT(*)
 * over social_endorsements (migration 008) grouped by voter_wallet, never
 * from client-supplied input.
 */
export function dilutedEndorsementWeight(voter: EndorsementVoter, liveEndorsementCount: number): number {
  const k = Number.isFinite(liveEndorsementCount) ? Math.max(1, Math.floor(liveEndorsementCount)) : 1;
  return endorsementWeight(voter) / Math.sqrt(k);
}

/**
 * Aggregates endorsements into a reputation-weighted ranking, highest score
 * first. Ties broken by targetId for a stable, deterministic order (no
 * dependence on object/array iteration order across runs).
 *
 * Each voter's per-target weight is diluted by their OWN total live
 * endorsement count (see dilutedEndorsementWeight above) — computed once per
 * distinct voterId in this batch, not per endorsement, so a voter's dilution
 * factor is consistent across every target they endorsed in the same call.
 */
export function rankByWeightedEndorsements(endorsements: readonly Endorsement[]): RankedTarget[] {
  const voterCounts = new Map<string, number>();
  for (const { voterId } of endorsements) {
    voterCounts.set(voterId, (voterCounts.get(voterId) ?? 0) + 1);
  }

  const totals = new Map<string, { score: number; voteCount: number }>();
  for (const { targetId, voter, voterId } of endorsements) {
    const k = voterCounts.get(voterId) ?? 1;
    const weight = dilutedEndorsementWeight(voter, k);
    const existing = totals.get(targetId) ?? { score: 0, voteCount: 0 };
    existing.score += weight;
    existing.voteCount += 1;
    totals.set(targetId, existing);
  }
  return Array.from(totals.entries())
    .map(([targetId, { score, voteCount }]) => ({ targetId, score, voteCount }))
    .sort((a, b) => b.score - a.score || a.targetId.localeCompare(b.targetId));
}
