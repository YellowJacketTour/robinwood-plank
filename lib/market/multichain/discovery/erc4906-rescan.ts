/**
 * ERC-4906 MetadataUpdate-driven re-verification -- the real consuming
 * lane the Hash-First Multi-Source Hydration Doctrine's CID-skip gate
 * (hash-first-hydrate.ts) needed to be more than a standalone, unused
 * primitive (see docs/marketplank/GROK-FINDINGS-intelligence-agency-
 * maximal-vision-2026-08-26.md's "Build decision" on why CID-skip was
 * deferred until it had a real trigger).
 *
 * onchain-extensions.ts's scanMetadataUpdateLogs already does the real,
 * correct event-log decode -- it had zero callers before this file. This
 * wires it into a real, bounded, cursor-tracked scan: for each tracked
 * EVM collection that supports ERC-4906 (checked once, cached), scan for
 * real MetadataUpdate/BatchMetadataUpdate events since the last checked
 * block, and reset exactly the affected tokens' metadata_state back to
 * 'pending' -- advanceEvmTokenMetadata's own CID-skip check then decides
 * per-token whether a real body re-fetch is actually needed (a
 * MetadataUpdate event firing does NOT itself prove the URI changed, only
 * that the contract wants viewers to re-check).
 *
 * Deliberately small and bounded (a handful of collections per call,
 * cursor persisted in durable KV): this is a real background lane like
 * every other mesh lane in this app, not a special case that gets to
 * skip the same safety discipline the 2026-08-25 disk-fill incident
 * taught this app to always apply.
 */
import { postgresQuery } from "@/lib/postgres";
import { durableKv } from "@/lib/market/durable-kv";
import { hasMetadataUpdateSupport, scanMetadataUpdateLogs } from "@/lib/market/multichain/discovery/onchain-extensions";
import { rpcCall } from "@/lib/market/multichain/discovery/rpc-provider-pool";

const SUPPORT_CACHE_KEY = (chainSlug: string, contractAddress: string) =>
  `erc4906:support:${chainSlug}:${contractAddress.toLowerCase()}`;
const CURSOR_KEY = (chainSlug: string, contractAddress: string) =>
  `erc4906:cursor:${chainSlug}:${contractAddress.toLowerCase()}`;

async function latestBlockNumber(chainSlug: string): Promise<number> {
  const { result } = await rpcCall<string>(chainSlug, "eth_blockNumber", []);
  return parseInt(result, 16);
}

/** Real per-invocation batch: checks a SMALL number of tracked EVM
 * collections for real MetadataUpdate activity, and resets exactly the
 * real affected tokens for re-verification. Never re-checks a contract's
 * ERC-4906 support more than once (cached in durable KV -- most
 * collections don't implement it at all, so this avoids a wasted
 * supportsInterface call on every pass). */
export async function runMetadataUpdateRescanBatch(
  chainSlug: string,
  limit: number = 5
): Promise<{ checked: number; supported: number; tokensReset: number }> {
  const candidates = await postgresQuery<{ collection_slug: string }>(
    `SELECT DISTINCT collection_slug FROM plank_collection_tokens
     WHERE chain_slug = $1 AND metadata_state = 'complete'
     ORDER BY collection_slug LIMIT $2`,
    [chainSlug, limit]
  );

  let supported = 0;
  let tokensReset = 0;
  for (const row of candidates.rows) {
    const contractAddress = row.collection_slug;
    if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) continue; // real address only, same guard as evm-multicall's callers

    const cacheKey = SUPPORT_CACHE_KEY(chainSlug, contractAddress);
    let doesSupport = await durableKv.get<boolean>(cacheKey);
    if (doesSupport === null) {
      doesSupport = await hasMetadataUpdateSupport(chainSlug, contractAddress).catch(() => false);
      await durableKv.set(cacheKey, doesSupport === true, { ex: 30 * 24 * 60 * 60 }); // real result, cached 30d -- a contract's interface support never changes post-deploy
    }
    if (!doesSupport) continue;
    supported += 1;

    const cursorKey = CURSOR_KEY(chainSlug, contractAddress);
    const lastScanned = (await durableKv.get<number>(cursorKey)) ?? 0;
    const latest = await latestBlockNumber(chainSlug).catch(() => null);
    if (latest == null || latest <= lastScanned) continue;

    const entries = await scanMetadataUpdateLogs(chainSlug, contractAddress, {
      fromBlock: lastScanned === 0 ? latest : lastScanned + 1,
      toBlock: latest,
    }).catch(() => []);

    for (const entry of entries) {
      if (entry.tokenId != null) {
        const r = await postgresQuery(
          `UPDATE plank_collection_tokens SET metadata_state = 'pending', pointer_fp = NULL
           WHERE chain_slug = $1 AND collection_slug = $2 AND token_id = $3`,
          [chainSlug, contractAddress, entry.tokenId]
        ).catch(() => ({ rowCount: 0 }));
        tokensReset += r.rowCount ?? 0;
      } else if (entry.fromTokenId != null && entry.toTokenId != null) {
        const r = await postgresQuery(
          `UPDATE plank_collection_tokens SET metadata_state = 'pending', pointer_fp = NULL
           WHERE chain_slug = $1 AND collection_slug = $2
             AND token_id ~ '^[0-9]+$' AND token_id::numeric BETWEEN $3::numeric AND $4::numeric`,
          [chainSlug, contractAddress, entry.fromTokenId, entry.toTokenId]
        ).catch(() => ({ rowCount: 0 }));
        tokensReset += r.rowCount ?? 0;
      }
    }
    await durableKv.set(cursorKey, latest);
  }

  return { checked: candidates.rows.length, supported, tokensReset };
}
