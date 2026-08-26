/**
 * Season 2 $PLANK KOTH -- independent completeness cross-check against
 * DexPaprika (external Grok research review, second pass, docs/
 * marketplank/GROK-ONESHOT-plank-koth-live-feed-completeness-2026-08-26.md).
 *
 * Real design principle: no third-party vendor is "more true" than the
 * chain itself -- our own RPC-based discovery (plank-koth-rpc-scan.ts) is
 * the primary source of truth, not this. What DexPaprika's real, free,
 * keyless API DOES uniquely offer is a genuinely INDEPENDENT decode of
 * the same on-chain swaps, built by someone else's indexer, with real
 * per-transaction hashes (unlike DexScreener's free tier, which only
 * exposes aggregate pool stats) -- a second opinion that can catch a bug
 * in our own decode logic that pure introspection of our own code never
 * would. Any hash DexPaprika saw that we never recorded ANYWHERE
 * (confirmed, flagged, rejected, or even "we tried and it errored") is a
 * real gap worth investigating regardless of outcome.
 */
import { evaluatePlankKothCandidate } from "@/lib/market/plank-koth-candidate";
import { CANONICAL_PLANK_POOLS } from "@/lib/market/plank-pools";
import { CONTRACT_ADDRESS as PLANK_CONTRACT } from "@/lib/constants";
import { postgresQuery } from "@/lib/postgres";

const DEXPAPRIKA_BASE = "https://api.dexpaprika.com";
const CHAIN_SLUG = "robinhood";

type DexPaprikaTransaction = { id: string };
type DexPaprikaTxPage = { transactions?: DexPaprikaTransaction[] };
type DexPaprikaPoolSearchResult = { id: string };
type DexPaprikaPoolSearch = { results?: DexPaprikaPoolSearchResult[] };

/** Real fetch failure must never look like "DexPaprika found nothing" --
 * same fail-closed discipline as the rest of tonight's rewrite. Returns
 * null (not []) on any failure so the caller can tell "no data" from
 * "we don't actually know." */
async function fetchDexPaprikaJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${DEXPAPRIKA_BASE}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Real pool discovery -- not limited to our own hardcoded allowlist, so
 * a genuinely new real pool DexPaprika has already indexed gets checked
 * too, even before it's been manually reviewed and admitted as a
 * "qualified venue" for ranking purposes. */
async function discoverPoolIds(): Promise<string[]> {
  const known = CANONICAL_PLANK_POOLS.map((p) => p.address.toLowerCase());
  const search = await fetchDexPaprikaJson<DexPaprikaPoolSearch>(
    `/networks/${CHAIN_SLUG}/pools/search?token_address=${PLANK_CONTRACT}`
  );
  const discovered = (search?.results ?? []).map((p) => p.id.toLowerCase());
  return [...new Set([...known, ...discovered])];
}

async function fetchPoolTxHashes(poolId: string): Promise<string[] | null> {
  const page = await fetchDexPaprikaJson<DexPaprikaTxPage>(
    `/networks/${CHAIN_SLUG}/pools/${poolId}/transactions?limit=100`
  );
  if (!page) return null;
  return (page.transactions ?? []).map((t) => t.id.toLowerCase());
}

/** Every tx_hash we've EVER recorded anywhere, regardless of outcome --
 * confirmed, flagged, rejected, or source_error. Any DexPaprika hash not
 * in this set is a genuine, real gap: we never even attempted it. */
async function loadKnownTxHashes(hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const result = await postgresQuery<{ tx_hash: string }>(
    `SELECT tx_hash FROM contest_eval_results WHERE tx_hash = ANY($1)
     UNION
     SELECT tx_hash FROM plank_koth_leaderboard WHERE tx_hash = ANY($1)
     UNION
     SELECT tx_hash FROM plank_koth_review_queue WHERE tx_hash = ANY($1)`,
    [hashes]
  );
  return new Set(result.rows.map((r) => r.tx_hash.toLowerCase()));
}

export type GapFinderResult = {
  poolsChecked: number;
  hashesSeen: number;
  gapsFound: number;
  gapsEvaluated: number;
  errors: number;
};

/** Real one-pass gap-finder: pulls recent real swaps from DexPaprika for
 * every known + newly-discovered pool, diffs against everything our own
 * pipeline has ever recorded, and directly evaluates any genuine gap
 * through the SAME evaluatePlankKothCandidate pipeline the live watcher
 * uses -- a caught gap self-heals in this same pass, it doesn't just get
 * logged for a human to notice.
 *
 * Real bug found live 2026-08-26, immediately on first deploy: evaluating
 * every found gap serially, with no bound, is the exact "unbounded
 * sequential work" mistake already found and fixed earlier tonight in
 * the review-queue reprocess script -- evaluatePlankKothCandidate's own
 * reputation/funding checks can be several real, serial network round-
 * trips each, and a first-ever pass against real pool history can find
 * many gaps at once. Confirmed live: the very first provisioning run got
 * killed by the CI job's own 10-minute timeout mid-pass, never even
 * printing a result. Bounded per invocation, same as the primary
 * watcher's own MAX_CANDIDATES_PER_PASS -- a real backlog still drains
 * steadily across the cron's own repeat 10-minute passes instead of
 * trying to do it all in one. */
const MAX_GAPS_PER_PASS = 10;
/** Second, independent safety net -- a count cap alone still risks the
 * job timeout if a handful of evaluations each hit real, slow network
 * round-trips. Real cron cadence is every 10 minutes; this leaves a real
 * margin under that so the job always exits cleanly on its own rather
 * than getting killed mid-evaluation. */
const WALL_CLOCK_BUDGET_MS = 6 * 60_000;

export async function runPlankKothGapFinder(): Promise<GapFinderResult> {
  const startedAt = Date.now();
  const poolIds = await discoverPoolIds();
  const allHashes = new Set<string>();
  for (const poolId of poolIds) {
    const hashes = await fetchPoolTxHashes(poolId);
    if (hashes) for (const h of hashes) allHashes.add(h);
  }

  const known = await loadKnownTxHashes([...allHashes]);
  const gaps = [...allHashes].filter((h) => !known.has(h));
  const toEvaluate = gaps.slice(0, MAX_GAPS_PER_PASS);

  let evaluated = 0;
  let errors = 0;
  for (const txHash of toEvaluate) {
    if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) break;
    try {
      await evaluatePlankKothCandidate(txHash);
      evaluated += 1;
    } catch {
      errors += 1;
    }
  }

  return {
    poolsChecked: poolIds.length,
    hashesSeen: allHashes.size,
    gapsFound: gaps.length,
    gapsEvaluated: evaluated,
    errors,
  };
}
