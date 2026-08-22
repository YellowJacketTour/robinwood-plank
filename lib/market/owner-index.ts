/**
 * Durable collection-wide ownership index.
 *
 * Replaces the per-request `ownerOf(tokenId)` eth_call that /api/market/token
 * made on every item view. That call was 26 CU each and, because every visitor
 * looks at different tokens, it was the app's single largest source of DISTINCT
 * (therefore uncacheable) provider reads.
 *
 * The whole index is built once — one Blockscout walk, or one 600 CU Alchemy
 * call — and stored in PostgreSQL. A request reads a Map, not the chain.
 *
 * NO TTL. Deliberately, and the same rule migrations 002 and 003 exist to
 * enforce: this is a last-known-good snapshot, not a disposable request cache.
 * A snapshot that expires while its rebuild is failing turns a stale owner into
 * a blank one, which is strictly worse — a slightly stale owner is still the
 * right answer for almost every token almost all of the time. Freshness comes
 * from the cron overwriting it, never from expiry.
 *
 * NOT AUTHORITATIVE. Display only. Order validation, transfer authorization and
 * anything else that gates a decision must read ownerOf on SERVER_RPC_URLS.
 */

import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { fetchCollectionOwners } from "@/lib/market/alchemy-nft";
import { durableKv as kv, hasDurableKv } from "@/lib/market/durable-kv";

const KV_KEY_PREFIX = "plank:market:owner-index-v1";

/**
 * How long a process reuses its in-memory copy before re-reading PostgreSQL.
 *
 * Must comfortably exceed a full rebuild (the Blockscout walk is 31 pages and
 * takes ~75s measured). At 60s it did not: a cold process served requests that
 * each found the memory entry already stale and started their own walk, turning
 * six token views into six rebuilds. Past the TTL the copy is now refreshed in
 * the background rather than waited on, so this is a refresh cadence, not a
 * staleness bound.
 */
const MEM_TTL_MS = 5 * 60_000;

/**
 * How old a stored snapshot may be before a *reader* rebuilds it. Long, because
 * the cron is the intended writer; this is only the safety net for an
 * environment where cron never runs. Serving a stale index is always preferred
 * to serving nothing, so an expired snapshot is still returned on rebuild
 * failure.
 */
const REBUILD_AFTER_MS = 6 * 60 * 60 * 1000;

export type OwnerIndexSnapshot = {
  /** tokenId -> owner address, lowercase. */
  owners: Record<string, string>;
  at: number;
  source: string;
  count: number;
};

/** Distinct wallets in an owner map — not token count (`snapshot.count`). */
export function uniqueWalletCount(owners: Record<string, string> | undefined): number {
  if (!owners) return 0;
  const set = new Set<string>();
  for (const raw of Object.values(owners)) {
    const a = raw.toLowerCase();
    if (a && a !== "0x0000000000000000000000000000000000000000") set.add(a);
  }
  return set.size;
}

type MemEntry = { at: number; snapshot: OwnerIndexSnapshot };
const memCache = new Map<string, MemEntry>();

/** Single-flight: concurrent misses must not each trigger a rebuild. */
const inflight = new Map<string, Promise<OwnerIndexSnapshot | null>>();

function kvKeyFor(contractAddress: string): string {
  return `${KV_KEY_PREFIX}:${contractAddress.toLowerCase()}`;
}

async function readStored(contractAddress: string): Promise<OwnerIndexSnapshot | null> {
  if (!hasDurableKv()) return null;
  try {
    let value = await kv.get<OwnerIndexSnapshot | string>(kvKeyFor(contractAddress));
    if (typeof value === "string") {
      try {
        value = JSON.parse(value) as OwnerIndexSnapshot;
      } catch {
        return null;
      }
    }
    if (!value || typeof value !== "object" || !value.owners) return null;
    return value;
  } catch {
    return null;
  }
}

async function writeStored(
  contractAddress: string,
  snapshot: OwnerIndexSnapshot
): Promise<void> {
  if (!hasDurableKv()) return;
  // No `ex` option — see the NO TTL note at the top of this file.
  await kv.set(kvKeyFor(contractAddress), snapshot);
}

/**
 * Rebuild from the aggregators and store. Used by the cron; also the
 * reader's safety net when no snapshot exists at all.
 */
export async function rebuildOwnerIndex(
  contractAddress: string = NFT_CONTRACT_ADDRESS,
  opts?: { preferFast?: boolean }
): Promise<OwnerIndexSnapshot> {
  const { owners, source } = await fetchCollectionOwners(contractAddress, opts);
  const snapshot: OwnerIndexSnapshot = {
    owners: Object.fromEntries(owners),
    at: Date.now(),
    source,
    count: owners.size,
  };

  // Never overwrite a larger known-good index with a materially smaller one: a
  // partial aggregator walk would otherwise erase owners we already had, and
  // the token route would start rendering "unowned" for real tokens.
  const stored = await readStored(contractAddress);
  if (stored && stored.count > snapshot.count * 2) {
    throw new Error(
      `Refusing to shrink owner index: have ${stored.count}, rebuilt only ${snapshot.count} from ${source}`
    );
  }

  await writeStored(contractAddress, snapshot);
  memCache.set(contractAddress.toLowerCase(), { at: Date.now(), snapshot });
  return snapshot;
}

/**
 * Rebuild without letting concurrent callers pile up behind it, and without
 * ever surfacing the failure — the caller keeps serving what it already has.
 */
function refreshInBackground(contractAddress: string): Promise<unknown> {
  const key = contractAddress.toLowerCase();
  if (inflight.has(key)) return Promise.resolve(null);
  const task = rebuildOwnerIndex(contractAddress)
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, task as Promise<OwnerIndexSnapshot | null>);
  return task;
}

/**
 * The current index, preferring memory, then PostgreSQL, then a rebuild.
 * Returns null only when there is no snapshot and the rebuild failed.
 */
export async function getOwnerIndex(
  contractAddress: string = NFT_CONTRACT_ADDRESS
): Promise<OwnerIndexSnapshot | null> {
  const key = contractAddress.toLowerCase();

  const mem = memCache.get(key);
  if (mem) {
    // Serve the copy we have either way; a stale one only schedules a refresh.
    // A request must never block on a rebuild once any answer exists.
    if (Date.now() - mem.at >= MEM_TTL_MS && !inflight.has(key)) {
      memCache.set(key, { at: Date.now(), snapshot: mem.snapshot });
      void refreshInBackground(contractAddress);
    }
    return mem.snapshot;
  }

  const existing = inflight.get(key);
  if (existing) return existing;

  const task = (async (): Promise<OwnerIndexSnapshot | null> => {
    const stored = await readStored(contractAddress);
    if (stored) {
      memCache.set(key, { at: Date.now(), snapshot: stored });
      const stale = Date.now() - (stored.at ?? 0) > REBUILD_AFTER_MS;
      if (!stale) return stored;
      // Stale: refresh in the background and serve what we have now. The user's
      // request never waits on a 31-page aggregator walk.
      void rebuildOwnerIndex(contractAddress).catch(() => {
        /* stored snapshot stays served */
      });
      return stored;
    }

    try {
      // Nothing stored at all: this request is blocking on the build, so take
      // the fast source when one is configured.
      return await rebuildOwnerIndex(contractAddress, { preferFast: true });
    } catch {
      return null;
    }
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, task);
  return task;
}

/**
 * One token's owner from the index, or null when the index is unavailable or
 * doesn't know the token. Null means "unknown", never "unowned" — callers
 * already treat a null owner as a degraded payload and refuse to cache it.
 */
export async function getOwnerFromIndex(
  tokenId: string,
  contractAddress: string = NFT_CONTRACT_ADDRESS
): Promise<string | null> {
  const snapshot = await getOwnerIndex(contractAddress);
  if (!snapshot) return null;
  return snapshot.owners[String(tokenId)] ?? null;
}

/** Test hook. */
export function clearOwnerIndexMemory(): void {
  memCache.clear();
  inflight.clear();
}
