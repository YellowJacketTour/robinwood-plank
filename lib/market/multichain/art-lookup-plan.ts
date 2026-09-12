/**
 * WHICH TOKENS GET THEIR ART LOOKED UP, AND WHO PAYS FOR IT.
 *
 * Three routes resolve per-token art for a page of rows -- listings,
 * offers, and owned. All three did it the same wrong way: they took the
 * distinct token ids, `.slice(0, 30)`, and resolved art for that prefix.
 * Everything past the thirtieth row rendered with `name: null` /
 * `imageUrl: null` and NOTHING said so. For an NFT surface the art IS the
 * product, so those rows are blank tiles that look like a broken grid
 * rather than like a truncated one.
 *
 * WHY THE 30 WAS EVER RIGHT, AND WHY IT STOPPED BEING RIGHT
 * ---------------------------------------------------------------
 * The number was written when art resolution meant ONE OpenSea HTTP call
 * per token, awaited inline. Thirty cold round trips against a
 * rate-limited vendor on a page render is a real hazard, and a bound there
 * is real PACING: it protects the request from expiry and the key pool
 * from a quota breach.
 *
 * The 2026-09-08 archive-first change (listings/route.ts) put a different
 * leg in front of that one. `readProjectedTokensByIds` is ONE indexed
 * query against `plank_collection_tokens`, keyed
 * (chain_slug, collection_slug, token_id), with `token_id = ANY($3)` --
 * one round trip whether the array holds 5 ids or 5,000, bounded in TIME
 * by the pool-level statement_timeout lib/postgres.ts already sets (the
 * same instrument PR #483 chose over a row cap for the trait index).
 *
 * So after that change the 30 was throttling the CHEAP leg. It stood in
 * front of a single indexed read and decided, for no measured reason, that
 * the thirty-first card of a page the archive could fully answer would
 * render blank.
 *
 * THE RULE THIS ENCODES
 * ---------------------------------------------------------------
 * Throughput is never capped arbitrarily. Only PACING is allowed, and
 * pacing must point at a real hazard: expiry, timeout, or a vendor quota.
 *
 *   - the archive leg gets EVERY distinct id, uncapped. Its bound is the
 *     database's own statement deadline, not a number somebody typed.
 *   - the remote leg -- the rate-limited vendor or the single RPC node --
 *     keeps a budget, because that hazard is real.
 *   - whatever the budget leaves behind is REPORTED. A partial answer that
 *     cannot be told apart from a complete one is the same silent shape as
 *     a coverage counter advancing over a filter that matched nothing.
 */

/** Default per-request budget for the REMOTE leg only -- the rate-limited
 * vendor / single RPC node. Never applied to the archive read. Kept at the
 * historical 30 because that number was measured against the vendor path
 * it still guards; what changed is WHERE it is applied, not its value. */
export const MAX_REMOTE_ART_LOOKUPS = 30;

export type ArtLookupPlan = {
  /** Every distinct id, in first-seen order, uncapped. Feed this to the archive. */
  archiveIds: string[];
  /** The subset the archive could not answer, trimmed to the remote budget. */
  remoteIds: string[];
  /**
   * Ids the archive could not answer and the remote budget could not reach.
   * These will render without art. Non-empty means the answer is PARTIAL.
   */
  unresolvedIds: string[];
  /** True when `unresolvedIds` is non-empty -- hand this to the caller. */
  artIncomplete: boolean;
};

/**
 * A token id is a real id, including "0".
 *
 * The listings route already carries a comment about this: `!tokenId` is
 * falsy for the string "0", which is the first mint of most collections,
 * and a truthiness filter silently dropped it. Same trap here, so the
 * filter is written against absence explicitly.
 */
export function distinctTokenIds(ids: Array<string | number | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    // `raw == null` catches null and undefined and NOTHING ELSE. A `!raw`
    // here would additionally drop the NUMBER 0 and the string "" -- and
    // token 0 arrives as a number from the owned path's enumeration, where
    // it is the very first token the contract ever minted.
    if (raw == null) continue;
    const id = String(raw).trim();
    if (id === "") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Split a page's distinct token ids into the free (archive) leg and the
 * paced (remote) leg, and say exactly what neither leg will cover.
 *
 * `archiveHas` is asked per id AFTER the archive read. It must answer
 * "does the archive hold a USABLE row for this id" -- a row with neither a
 * name nor an image is not an answer, it is a gap wearing a row's clothes,
 * and treating it as an answer lets the archive certify a blank card the
 * way a 404 page once certified an empty book.
 */
export function planArtLookups(
  ids: Array<string | number | null | undefined>,
  archiveHas: (id: string) => boolean,
  remoteBudget: number = MAX_REMOTE_ART_LOOKUPS
): ArtLookupPlan {
  const archiveIds = distinctTokenIds(ids);
  const missing = archiveIds.filter((id) => !archiveHas(id));
  // A budget of 0 means "no remote leg at all" (no key, no RPC url); a
  // negative or non-finite budget is a caller bug, and clamping it to 0 is
  // safer than letting `slice(0, NaN)` quietly return nothing while
  // pretending everything was reachable.
  const budget = Number.isFinite(remoteBudget) && remoteBudget > 0 ? Math.floor(remoteBudget) : 0;
  const remoteIds = missing.slice(0, budget);
  const unresolvedIds = missing.slice(budget);
  return {
    archiveIds,
    remoteIds,
    unresolvedIds,
    artIncomplete: unresolvedIds.length > 0,
  };
}

/**
 * How long the RPC/vendor art leg may run before it stops starting new work.
 *
 * This is the instrument a COUNT was doing the wrong job of. The hazard on
 * the owned path is a request that runs past its own deadline while holding
 * a connection to a single RPC node -- not "the wallet holds too many
 * tokens". A wallet whose tokens resolve fast gets all of them; a slow node
 * costs this much and then the answer says what it could not reach.
 *
 * 6s leaves headroom under the per-metadata-fetch AbortSignal.timeout(8000)
 * already in that route: an item started just under the line still finishes
 * inside a normal request budget rather than doubling it.
 */
export const ART_RPC_DEADLINE_MS = 6_000;

/**
 * Simultaneous in-flight art lookups against ONE node. Not a throughput
 * ceiling -- the deadline above is what stops the work. This only keeps the
 * fan-out from opening hundreds of sockets at once against a single RPC
 * endpoint, which is how a wallet with a large holding turns into a
 * self-inflicted outage.
 */
export const MAX_CONCURRENT_ART_RPC = 12;

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input
 * order in the result. Same shape as rarity-index-runner.ts's file-local
 * copy; lifted here because a second caller needed it and two divergent
 * copies of a concurrency primitive is how one of them quietly grows a bug
 * the other does not have.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
