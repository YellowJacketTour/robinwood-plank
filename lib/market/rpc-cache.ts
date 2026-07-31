/**
 * Response cache + single-flight for outbound JSON-RPC.
 *
 * Why this exists, structurally: every component is free to poll at whatever
 * interval it likes, and until now each poll became one provider request. Cost
 * therefore scaled with (number of tabs) x (poll rate), which is unbounded and
 * unrelated to how much data actually changed. MintPanel re-reading twelve
 * immutable getters every 60s per tab — ~13.5M compute units a month for one
 * open tab — was that pattern in its purest form, but it was not unique: there
 * are ~17 polling intervals across the app, several at 3-6 seconds.
 *
 * Collapsing identical reads here makes cost proportional to *distinct data per
 * TTL window* instead. Ten tabs polling the same getter every 3s cost the same
 * as one tab polling it once. A future component that polls badly is bounded
 * automatically rather than discovered on a bill.
 *
 * This is a per-process cache (Passenger runs several workers), which is fine:
 * it is a spend limiter, not a correctness mechanism. Nothing here is trusted
 * for settlement — see ARCHITECTURE.md on what stays authoritative on-chain.
 */

import { recordRpcCacheEvent } from "@/lib/market/rpc-meter";

/**
 * Never cache: anything that writes, anything whose whole purpose is to be
 * fresh at the moment of asking, and anything nonce-related — a stale nonce
 * produces a broken transaction, which is far worse than the request it saves.
 */
const NEVER_CACHE = new Set([
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_newFilter",
  "eth_getFilterChanges",
  "eth_uninstallFilter",
]);

/**
 * Immutable once observed. A mined block or receipt never changes, so these can
 * be held for a long time; re-reading them is pure waste. Vault activity
 * rebuilds fetch up to 60 eth_getBlockByNumber per pass, almost all repeats.
 */
const IMMUTABLE_MS = 30 * 60 * 1000;

/**
 * Chain-tip-dependent reads. Short enough that the UI stays honest — shorter
 * than the route caches already shipped (vault stats 15s, mint stats 10s) — but
 * long enough to collapse a 3s poll and every concurrent tab into one call.
 */
const LATEST_MS = 5_000;

const MAX_ENTRIES = 2_000;

type Entry = { value: unknown; expiresAt: number };

type CacheGlobal = typeof globalThis & {
  __plankRpcCache?: Map<string, Entry>;
  __plankRpcInflight?: Map<string, Promise<unknown>>;
};

function store(): Map<string, Entry> {
  const g = globalThis as CacheGlobal;
  if (!g.__plankRpcCache) g.__plankRpcCache = new Map();
  return g.__plankRpcCache;
}

function inflight(): Map<string, Promise<unknown>> {
  const g = globalThis as CacheGlobal;
  if (!g.__plankRpcInflight) g.__plankRpcInflight = new Map();
  return g.__plankRpcInflight;
}

/** A block tag that is not a fixed height — results move with the chain. */
function isMovingTag(tag: unknown): boolean {
  return tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized";
}

/**
 * How long a result for this call may be reused. 0 means do not cache.
 */
export function cacheTtlMs(method: string, params: unknown[]): number {
  if (NEVER_CACHE.has(method)) return 0;

  switch (method) {
    case "eth_chainId":
    case "net_version":
      return IMMUTABLE_MS;

    // Receipts and transactions are immutable once mined. An unmined lookup
    // returns null, which we refuse to cache below, so this cannot pin a
    // "not found" for a transaction that lands a second later.
    case "eth_getTransactionReceipt":
    case "eth_getTransactionByHash":
      return IMMUTABLE_MS;

    // Immutable only when asked for a fixed height.
    case "eth_getBlockByNumber":
    case "eth_getBlockByHash":
      return isMovingTag(params[0]) ? LATEST_MS : IMMUTABLE_MS;

    // A fixed [fromBlock, toBlock] window that is already behind the tip cannot
    // gain logs. The incremental vault scan re-reads recent windows, so this
    // matters — but only when the range is explicit and numeric.
    case "eth_getLogs": {
      const filter = params[0] as { fromBlock?: unknown; toBlock?: unknown } | undefined;
      if (!filter || isMovingTag(filter.toBlock) || typeof filter.toBlock !== "string") {
        return 0;
      }
      return LATEST_MS;
    }

    case "eth_call":
    case "eth_getBalance":
    case "eth_getCode":
    case "eth_getStorageAt":
    case "eth_blockNumber":
      return LATEST_MS;

    default:
      // Unknown methods are not cached. Being wrong about freshness is worse
      // than paying for the call.
      return 0;
  }
}

function keyFor(method: string, params: unknown[]): string {
  return `${method}:${JSON.stringify(params)}`;
}

function evictIfNeeded(map: Map<string, Entry>): void {
  if (map.size <= MAX_ENTRIES) return;
  // Map preserves insertion order; drop the oldest tenth in one pass.
  const drop = Math.max(1, Math.floor(MAX_ENTRIES / 10));
  let n = 0;
  for (const k of map.keys()) {
    map.delete(k);
    if (++n >= drop) break;
  }
}

/**
 * Serve `run()` through the cache when the method allows it, collapsing
 * concurrent identical calls into one upstream request.
 */
export async function withRpcCache<T>(
  method: string,
  params: unknown[],
  run: () => Promise<T>
): Promise<T> {
  const ttl = cacheTtlMs(method, params);
  if (ttl <= 0) return run();

  const key = keyFor(method, params);
  const cache = store();
  const now = Date.now();

  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    recordRpcCacheEvent("hit");
    return hit.value as T;
  }

  const pending = inflight().get(key);
  if (pending) {
    // Someone is already asking upstream for exactly this. Wait for them.
    recordRpcCacheEvent("coalesced");
    return pending as Promise<T>;
  }

  recordRpcCacheEvent("miss");
  const promise = run()
    .then((value) => {
      // Never cache an empty result: a null receipt means "not mined yet", and
      // pinning that for half an hour would hide a transaction that just landed.
      if (value != null) {
        cache.set(key, { value, expiresAt: Date.now() + ttl });
        evictIfNeeded(cache);
      }
      return value;
    })
    .finally(() => {
      inflight().delete(key);
    });

  inflight().set(key, promise as Promise<unknown>);
  return promise;
}

/**
 * Read a cached result without triggering a fetch.
 *
 * For batch callers (ethCallMany), which must decide *which* entries still need
 * to go upstream before building the batch body. Returns undefined on a miss so
 * a legitimately-cached `null` stays distinguishable.
 */
export function peekRpcCache<T>(method: string, params: unknown[]): T | undefined {
  if (cacheTtlMs(method, params) <= 0) return undefined;
  const hit = store().get(keyFor(method, params));
  if (!hit || hit.expiresAt <= Date.now()) {
    recordRpcCacheEvent("miss");
    return undefined;
  }
  recordRpcCacheEvent("hit");
  return hit.value as T;
}

/** Store a result fetched outside withRpcCache (batch responses). */
export function putRpcCache(method: string, params: unknown[], value: unknown): void {
  const ttl = cacheTtlMs(method, params);
  if (ttl <= 0 || value == null) return;
  const cache = store();
  cache.set(keyFor(method, params), { value, expiresAt: Date.now() + ttl });
  evictIfNeeded(cache);
}

/** Test/ops hook. */
export function clearRpcCache(): void {
  store().clear();
  inflight().clear();
}

export function rpcCacheSize(): number {
  return store().size;
}
