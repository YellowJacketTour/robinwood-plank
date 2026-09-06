import { getOrRefreshWithMeta, type CacheFreshness, type EnvelopeResult } from "@/lib/market/multichain/singleflight-cache";
import { recordExternalCall } from "@/lib/market/multichain/edge/provider-ledger";

/**
 * THE SINGLE POINT: one chain-agnostic read gateway every user-facing
 * market read passes through.
 *
 * docs/marketplank/FABLE-ONESHOT-marketplank-all-chains-peak-2026-09-05.md
 * §3.1 named the gap precisely: singleflight-cache.ts existed, but it was
 * opt-in per call site, keyed by whatever string each route invented, and
 * a handful of routes (activity, account-activity, wallet-summary, owned,
 * owned-all, listings' OpenSea helper, hydrate-stats' CoinGecko call)
 * still fanned out to a vendor once per browser. N users on the same cell
 * in the same second cost N vendor calls.
 *
 * This module makes coalescing, stale-while-revalidate and the freshness
 * budget UNIVERSAL rather than optional:
 *
 *   - One key grammar. `edge:<kind>:<chain>:<subject>[:<variant>]`, with
 *     EVM addresses lower-cased and variants sorted, so two routes (or two
 *     workers) asking for the same fact share one cache row and one lease.
 *   - One policy table. EDGE_POLICY gives every kind a soft/hard TTL and
 *     the provider whose freshness budget gates it. A route may override,
 *     but it cannot opt out.
 *   - One measurement. Every edgeRead() records reads vs real fetcher
 *     invocations per kind and per cell in-process (readEdgeStats), and
 *     every real fetcher invocation is ALSO written to the provider
 *     ledger as source `edge:<kind>` so the cross-process ledger shows
 *     vendor calls per unique cell per minute -- the number the owner
 *     asked to see be O(1) in users, not O(N).
 *
 * It deliberately reuses getOrRefreshWithMeta (memcache-lease coalescing +
 * Postgres lease + RFC 5861 SWR + Freshness Budget Controller) instead of
 * re-implementing any of it -- see that file's header. What is new here is
 * that the gateway is the ONLY sanctioned way for an App Router read to
 * reach a vendor, and that it is measured.
 */

export type EdgeKind =
  | "collection-stats"
  | "collection-meta"
  | "listings"
  | "floor-listings"
  | "offers"
  | "activity"
  | "account-activity"
  | "tokens"
  | "token"
  | "traits"
  | "rarity"
  | "owned"
  | "wallet"
  | "book"
  | "search"
  | "chain-read";

export type EdgeCell = {
  kind: EdgeKind;
  /** This app's own chainSlug convention ("eth-mainnet", "robinhood", "solana-mainnet", "bitcoin-mainnet") or "all". */
  chainSlug: string;
  /** Collection key, wallet address, token composite -- whatever identifies the fact. */
  subject: string;
  /** Anything that changes the answer (limit, cursor, filters). Sorted and joined into the key. */
  variant?: Record<string, string | number | boolean | null | undefined> | string;
};

export type EdgePolicy = {
  softTtlMs: number;
  hardTtlMs: number;
  /** Freshness Budget Controller provider name (freshness-budget.ts). */
  provider?: string;
};

/**
 * Per-kind defaults. Numbers are the ones the routes had already chosen
 * individually where they had any (e.g. collection route's Magic Eden
 * stats: 60s/10min), made uniform. The provider is set per call because
 * the same kind can come from different vendors on different chains.
 */
export const EDGE_POLICY: Record<EdgeKind, EdgePolicy> = {
  "collection-stats": { softTtlMs: 60_000, hardTtlMs: 10 * 60_000 },
  "collection-meta": { softTtlMs: 30 * 60_000, hardTtlMs: 24 * 60 * 60_000 },
  listings: { softTtlMs: 8_000, hardTtlMs: 2 * 60_000 },
  "floor-listings": { softTtlMs: 8_000, hardTtlMs: 2 * 60_000 },
  offers: { softTtlMs: 10_000, hardTtlMs: 3 * 60_000 },
  activity: { softTtlMs: 20_000, hardTtlMs: 5 * 60_000 },
  "account-activity": { softTtlMs: 20_000, hardTtlMs: 5 * 60_000 },
  tokens: { softTtlMs: 60_000, hardTtlMs: 15 * 60_000 },
  token: { softTtlMs: 5 * 60_000, hardTtlMs: 60 * 60_000 },
  traits: { softTtlMs: 5 * 60_000, hardTtlMs: 60 * 60_000 },
  rarity: { softTtlMs: 10 * 60_000, hardTtlMs: 24 * 60 * 60_000 },
  owned: { softTtlMs: 30_000, hardTtlMs: 5 * 60_000 },
  wallet: { softTtlMs: 30_000, hardTtlMs: 5 * 60_000 },
  book: { softTtlMs: 8_000, hardTtlMs: 2 * 60_000 },
  search: { softTtlMs: 60_000, hardTtlMs: 10 * 60_000 },
  "chain-read": { softTtlMs: 15_000, hardTtlMs: 5 * 60_000 },
};

function normalizeSubject(subject: string): string {
  const s = subject.trim();
  return /^0x[0-9a-f]{40}$/i.test(s) ? s.toLowerCase() : s;
}

function normalizeVariant(variant: EdgeCell["variant"]): string {
  if (variant == null) return "";
  if (typeof variant === "string") return variant;
  const parts = Object.keys(variant)
    .sort()
    .filter((k) => variant[k] != null && variant[k] !== "")
    .map((k) => `${k}=${String(variant[k])}`);
  return parts.join("&");
}

/** Deterministic cache key for a cell -- exported so tests can assert two call sites collide on purpose. */
export function edgeKey(cell: EdgeCell): string {
  const variant = normalizeVariant(cell.variant);
  return `edge:${cell.kind}:${cell.chainSlug}:${normalizeSubject(cell.subject)}${variant ? `:${variant}` : ""}`;
}

type CellStat = { reads: number; fetches: number; lastReadAt: number };
type KindStat = { reads: number; fetches: number; live: number; cached: number; staleBudget: number; cells: Map<string, CellStat>; lastError: { message: string; at: string; key: string } | null };

type EdgeGlobal = typeof globalThis & { __plankEdgeStats?: { since: number; byKind: Map<EdgeKind, KindStat> } };

function stats() {
  const g = globalThis as EdgeGlobal;
  if (!g.__plankEdgeStats) g.__plankEdgeStats = { since: Date.now(), byKind: new Map() };
  return g.__plankEdgeStats;
}

function kindStat(kind: EdgeKind): KindStat {
  const s = stats();
  let k = s.byKind.get(kind);
  if (!k) {
    k = { reads: 0, fetches: 0, live: 0, cached: 0, staleBudget: 0, cells: new Map(), lastError: null };
    s.byKind.set(kind, k);
  }
  return k;
}

const CELL_STAT_CAP = 2_000;

function touchCell(k: KindStat, key: string, fetched: boolean): void {
  let c = k.cells.get(key);
  if (!c) {
    if (k.cells.size >= CELL_STAT_CAP) {
      // Drop the least-recently-read cell, not the newest.
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [ck, cv] of k.cells) if (cv.lastReadAt < oldest) { oldest = cv.lastReadAt; oldestKey = ck; }
      if (oldestKey) k.cells.delete(oldestKey);
    }
    c = { reads: 0, fetches: 0, lastReadAt: 0 };
    k.cells.set(key, c);
  }
  if (fetched) c.fetches += 1;
  else c.reads += 1;
  c.lastReadAt = Date.now();
}

export type EdgeReadOptions = {
  /** Vendor behind this read, for the freshness budget and the ledger ("opensea", "magiceden", "helius", "unisat", "coingecko-nft", "alchemy-nft", "rpc"). */
  provider?: string;
  /** Override the kind's default TTLs (rarely needed). */
  policy?: Partial<EdgePolicy>;
};

export type EdgeResult<T> = EnvelopeResult<T> & { key: string };

/**
 * Read one cell through the single point.
 *
 * `fetcher` must THROW on failure and never resolve a sentinel "empty"
 * value for a transient error -- the cache only stores resolved values, so
 * a thrown error can never poison it (same discipline every existing
 * getOrRefresh call site follows).
 */
export async function edgeRead<T>(cell: EdgeCell, fetcher: () => Promise<T>, opts: EdgeReadOptions = {}): Promise<EdgeResult<T>> {
  const key = edgeKey(cell);
  const base = EDGE_POLICY[cell.kind];
  const policy: EdgePolicy = {
    softTtlMs: opts.policy?.softTtlMs ?? base.softTtlMs,
    hardTtlMs: opts.policy?.hardTtlMs ?? base.hardTtlMs,
    provider: opts.policy?.provider ?? opts.provider ?? base.provider,
  };
  const k = kindStat(cell.kind);
  k.reads += 1;
  touchCell(k, key, false);

  let result: EnvelopeResult<T>;
  try {
    result = await getOrRefreshWithMeta<T>(
    key,
    { softTtlMs: policy.softTtlMs, hardTtlMs: policy.hardTtlMs, provider: policy.provider },
    async () => {
      k.fetches += 1;
      touchCell(k, key, true);
      const started = Date.now();
      try {
        const value = await fetcher();
        recordExternalCall({ source: `edge:${cell.kind}`, chainSlug: cell.chainSlug, latencyMs: Date.now() - started, outcome: "ok" });
        return value;
      } catch (error) {
        recordExternalCall({
          source: `edge:${cell.kind}`,
          chainSlug: cell.chainSlug,
          latencyMs: Date.now() - started,
          outcome: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  );
  } catch (error) {
    // Diagnosable, never silent: the last failure per kind is exposed on
    // /api/market/rpc-usage (added 2026-09-06 after production showed 180
    // hub-index reads with zero successes and no server log access).
    k.lastError = { message: (error instanceof Error ? error.message : String(error)).slice(0, 300), at: new Date().toISOString(), key };
    throw error;
  }
  countFreshness(k, result.freshness);
  return { ...result, key };
}

function countFreshness(k: KindStat, freshness: CacheFreshness): void {
  if (freshness === "live") k.live += 1;
  else if (freshness === "cached") k.cached += 1;
  else k.staleBudget += 1;
}

export type EdgeKindStats = {
  kind: EdgeKind;
  reads: number;
  /** Real fetcher invocations -- the only number that costs a vendor call. */
  fetches: number;
  live: number;
  cached: number;
  staleBudget: number;
  uniqueCells: number;
  /** fetches / uniqueCells over the process lifetime: the O(1)-per-cell claim in one number. */
  fetchesPerCell: number | null;
  /** reads / fetches: how many browser reads each vendor call served. */
  readsPerFetch: number | null;
  lastError: { message: string; at: string; key: string } | null;
};

export type EdgeStats = {
  since: string;
  elapsedSeconds: number;
  byKind: EdgeKindStats[];
  totals: { reads: number; fetches: number; uniqueCells: number };
  note: string;
};

/** Per-process edge measurement. Cross-process truth is the provider ledger (source `edge:*`). */
export function readEdgeStats(): EdgeStats {
  const s = stats();
  const byKind: EdgeKindStats[] = [];
  let reads = 0;
  let fetches = 0;
  let uniqueCells = 0;
  for (const [kind, k] of s.byKind) {
    reads += k.reads;
    fetches += k.fetches;
    uniqueCells += k.cells.size;
    byKind.push({
      kind,
      reads: k.reads,
      fetches: k.fetches,
      live: k.live,
      cached: k.cached,
      staleBudget: k.staleBudget,
      uniqueCells: k.cells.size,
      fetchesPerCell: k.cells.size > 0 ? Number((k.fetches / k.cells.size).toFixed(3)) : null,
      readsPerFetch: k.fetches > 0 ? Number((k.reads / k.fetches).toFixed(2)) : null,
      lastError: k.lastError,
    });
  }
  byKind.sort((a, b) => b.reads - a.reads);
  return {
    since: new Date(s.since).toISOString(),
    elapsedSeconds: Math.round((Date.now() - s.since) / 1000),
    byKind,
    totals: { reads, fetches, uniqueCells },
    note: "Per-process edge counters. fetches = real vendor-facing fetcher invocations; reads = browser-facing reads served.",
  };
}

/** Test/measurement hook. */
export function resetEdgeStats(): void {
  const g = globalThis as EdgeGlobal;
  g.__plankEdgeStats = { since: Date.now(), byKind: new Map() };
}
