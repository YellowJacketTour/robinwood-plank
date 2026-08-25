/**
 * Real bug found live 2026-08-25 ("it has to be stuck... was syncing fast
 * and then froze recently at this almost complete number"): confirmed
 * live MAYC's anchored-membership job was NOT actually deadlocked (its
 * plank_data_jobs row kept cycling queued/running and its token count kept
 * ticking up second by second) -- it had simply entered a real, dense
 * stretch of its own genuine historical trading volume. That scan reads
 * EVERY real Transfer log since the contract's deploy block to discover
 * token IDs, so once a rare "first ever appearance of a not-yet-seen
 * token" is buried under millions of ordinary resales of already-known
 * tokens, closing the last ~0.6% of a collection can require wading
 * through nearly its entire multi-year trading history -- correct, but
 * needlessly slow for a collection this close to done.
 *
 * Real, exact, dramatically cheaper alternative for exactly this
 * situation: ERC721Enumerable's own `tokenByIndex(i)` returns the real
 * token ID living at index i (0..totalSupply()-1) directly from current
 * contract state -- no log replay, no guessing which sparse IDs in a
 * gappy ID space might be real (MAYC's own ID space has real gaps by
 * design, from its mutation-serum minting mechanic, so blindly probing
 * every integer in [0, maxObservedId] would waste calls on IDs that were
 * simply never minted). Confirmed live against MAYC's real deployed
 * contract that this extension is supported. Only trustworthy once
 * known_supply itself is chain-confirmed (readTotalSupply, see
 * archival-ledger.ts's correctKnownSupplyFromChain) -- otherwise there's
 * no real upper bound to enumerate to.
 */
import { readTokenByIndex } from "@/lib/market/multichain/discovery/onchain-contract-reads";
import { readCursor, writeCursor } from "@/lib/market/multichain/discovery/evm-log-scan";
import { upsertCollectionTokenProjection } from "@/lib/market/multichain/collection-token-store";
import { postgresQuery } from "@/lib/postgres";

/** One real eth_call per index; bounded per invocation so a single mesh-tick
 * claim can't run past its own lane timeout. Fired with real concurrency
 * (not sequential) since these are independent reads against the same
 * public RPC pool every other on-chain read in this app already shares. */
const BATCH_SIZE = 300;
const CONCURRENCY = 10;

/** First call ever for a contract: does it even support this extension?
 * A single real probe at index 0, cached durably so every later call
 * skips straight past a genuinely non-Enumerable contract instead of
 * re-discovering "unsupported" on every single mesh-tick pass forever. */
async function isEnumerableSupported(chainSlug: string, address: string): Promise<boolean> {
  const cacheKey = `token-index-enumerable:${chainSlug}:${address}`;
  const cached = await readCursor(cacheKey);
  if (cached != null) return cached === 1;
  const probe = await readTokenByIndex(chainSlug, address, 0);
  await writeCursor(cacheKey, probe != null ? 1 : 0);
  return probe != null;
}

/**
 * Cheap, no-RPC-call completion check (mirrors anchored-membership-
 * status.ts's own isAnchoredMembershipComplete short-circuit) so every
 * real page visit's demand check can decide whether to include this
 * source without paying for an eth_call each time. "Complete" covers all
 * three real terminal states: known_supply isn't chain-confirmed yet
 * (nothing to enumerate against), the contract doesn't implement
 * ERC721Enumerable (cached from the one real probe call), or the cursor
 * has already reached known_supply.
 */
export async function isTokenIndexProbeComplete(chainSlug: string, contractAddress: string): Promise<boolean> {
  const address = contractAddress.toLowerCase();
  const supply = await postgresQuery<{ known_supply: string | null; known_supply_chain_confirmed: boolean }>(
    `SELECT known_supply, known_supply_chain_confirmed FROM collection_archival_stats WHERE chain_slug = $1 AND collection_key = $2`,
    [chainSlug, address]
  );
  const row = supply.rows[0];
  if (!row?.known_supply_chain_confirmed || row.known_supply == null) return true;

  const enumerableCached = await readCursor(`token-index-enumerable:${chainSlug}:${address}`);
  if (enumerableCached === 0) return true;

  const cursor = (await readCursor(`token-index-probe:${chainSlug}:${address}`)) ?? 0;
  return cursor >= Number(row.known_supply);
}

export type TokenIndexProbeResult = { probed: number; found: number; done: boolean; skipped?: "not_enumerable" | "supply_unconfirmed" };

export async function runTokenIndexProbe(chainSlug: string, contractAddress: string): Promise<TokenIndexProbeResult> {
  const address = contractAddress.toLowerCase();

  const supply = await postgresQuery<{ known_supply: string | null; known_supply_chain_confirmed: boolean }>(
    `SELECT known_supply, known_supply_chain_confirmed FROM collection_archival_stats WHERE chain_slug = $1 AND collection_key = $2`,
    [chainSlug, address]
  );
  const row = supply.rows[0];
  if (!row?.known_supply_chain_confirmed || row.known_supply == null) {
    return { probed: 0, found: 0, done: true, skipped: "supply_unconfirmed" };
  }
  const knownSupply = Number(row.known_supply);

  if (!(await isEnumerableSupported(chainSlug, address))) {
    return { probed: 0, found: 0, done: true, skipped: "not_enumerable" };
  }

  const cursorKey = `token-index-probe:${chainSlug}:${address}`;
  const startIndex = (await readCursor(cursorKey)) ?? 0;
  if (startIndex >= knownSupply) {
    return { probed: 0, found: 0, done: true };
  }

  const endIndex = Math.min(startIndex + BATCH_SIZE, knownSupply);
  const indices = Array.from({ length: endIndex - startIndex }, (_, i) => startIndex + i);
  const found: string[] = [];
  for (let i = 0; i < indices.length; i += CONCURRENCY) {
    const slice = indices.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map((index) => readTokenByIndex(chainSlug, address, index)));
    for (const tokenId of results) if (tokenId != null) found.push(tokenId);
  }

  if (found.length > 0) {
    await upsertCollectionTokenProjection(chainSlug, address, {
      tokens: found.map((tokenId) => ({ tokenId, name: null, imageUrl: null, traits: [] })),
      partial: true,
      provenance: ["erc721-enumerable-token-by-index"],
      sourceObservedAt: new Date(),
    });
  }

  await writeCursor(cursorKey, endIndex);
  return { probed: indices.length, found: found.length, done: endIndex >= knownSupply };
}
