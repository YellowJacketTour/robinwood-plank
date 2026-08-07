import { fetchActivity } from "@/lib/market/activity";
import { readChainActivity } from "@/lib/market/chain-events";
import { cachedPublicJson as publicCached } from "@/lib/http-cache";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * On-chain activity for the collection.
 *
 * READS THE PERMANENT LEDGER, NOT THE CHAIN. This route used to call
 * fetchActivity() on every request — a live Blockscout/RPC fan-out capped at
 * 40 events, or 800 in `full=1` mode. Those caps were a sliding window, so any
 * event older than the window had no record anywhere in the app and became
 * permanently invisible: a real 0.11 ETH sale went missing from this feed for
 * exactly that reason while being fully present on-chain.
 *
 * `plank_chain_events` (migration 008, written by the 2-minute cron via
 * lib/market/chain-indexer.ts) keeps every event forever, so this route now
 * pages over the FULL history with no ceiling. `limit` bounds one page;
 * `offset` walks back as far as the caller wants.
 *
 * The live path is kept as a FALLBACK for exactly one situation: a deployment
 * whose ledger has not been populated yet (fresh database, cron never run).
 * Serving an empty feed there would read as "nothing ever traded here", which
 * is the same lie the stale-cache branches below exist to avoid.
 */
const CACHE_MS = 30_000;

/** Back-compat: `full=1` used to mean "the deeper 800-event lineage". It now
 *  means "a large first page", and callers that want more simply page. */
const DEFAULT_LIMIT = 40;
const FULL_DEFAULT_LIMIT = 800;
const MAX_LIMIT = 1_000;

type CacheEntry = { at: number; payload: unknown };
const pageCache = new Map<string, CacheEntry>();
/** Bounded so a caller paging deep cannot grow this without limit. */
const PAGE_CACHE_MAX = 32;

let liveFallbackCache: { at: number; events: unknown[] } | null = null;

function cachedPublicJson(data: unknown) {
  return publicCached(data, "market");
}

function putPageCache(key: string, payload: unknown): void {
  if (pageCache.size >= PAGE_CACHE_MAX) {
    const oldest = pageCache.keys().next().value;
    if (oldest !== undefined) pageCache.delete(oldest);
  }
  pageCache.set(key, { at: Date.now(), payload });
}

export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-activity", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const url = new URL(req.url);
  const full = url.searchParams.get("full") === "1";
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(
      1,
      Number(url.searchParams.get("limit") || (full ? FULL_DEFAULT_LIMIT : DEFAULT_LIMIT)) ||
        (full ? FULL_DEFAULT_LIMIT : DEFAULT_LIMIT)
    )
  );
  const offset = Math.max(0, Number(url.searchParams.get("offset") || "0") || 0);
  const kindParam = (url.searchParams.get("kind") || "").trim();
  const kinds = kindParam
    ? kindParam
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k === "mint" || k === "sale" || k === "transfer")
    : undefined;
  const tokenId = (url.searchParams.get("tokenId") || "").trim() || undefined;

  const cacheKey = `${limit}:${offset}:${kinds?.join(",") ?? ""}:${tokenId ?? ""}`;
  const cached = pageCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cachedPublicJson(cached.payload);
  }

  try {
    const page = await readChainActivity({ limit, offset, kinds, tokenId });
    if (page.total > 0) {
      const payload = {
        events: page.events,
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        nextOffset: page.nextOffset,
        source: "ledger",
        cached: false,
      };
      putPageCache(cacheKey, { ...payload, cached: true });
      return cachedPublicJson(payload);
    }
  } catch (error) {
    // A database problem must not blank the feed — fall through to the live
    // path below, which is what every deployment used before this ledger.
    console.error(
      "[market-activity] ledger read failed, falling back to live fetch:",
      error instanceof Error ? error.message : error
    );
  }

  // ---- Fallback: the pre-ledger live path (cold database / cron not yet run).
  if (
    liveFallbackCache &&
    liveFallbackCache.events.length > 0 &&
    Date.now() - liveFallbackCache.at < CACHE_MS
  ) {
    return cachedPublicJson({
      events: liveFallbackCache.events.slice(offset, offset + limit),
      total: liveFallbackCache.events.length,
      limit,
      offset,
      nextOffset: null,
      source: "live",
      cached: true,
    });
  }

  try {
    const events = await fetchActivity(limit, { full });
    if (events.length > 0) liveFallbackCache = { at: Date.now(), events };
    return cachedPublicJson({
      events,
      total: events.length,
      limit,
      offset,
      nextOffset: null,
      source: "live",
      cached: false,
      // Told plainly rather than implied: this response is a bounded live
      // window, not the permanent history, so a consumer can tell the
      // difference between "no older events" and "ledger not built yet".
      ledgerPending: true,
    });
  } catch (error) {
    if (liveFallbackCache?.events.length) {
      return cachedPublicJson({
        events: liveFallbackCache.events.slice(offset, offset + limit),
        total: liveFallbackCache.events.length,
        limit,
        offset,
        nextOffset: null,
        source: "live",
        cached: true,
        stale: true,
      });
    }
    return publicError(error, "Could not load activity.");
  }
}
