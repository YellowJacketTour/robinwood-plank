/**
 * ERC-4906 MetadataUpdate-driven re-verification -- the real consuming
 * lane the Hash-First Multi-Source Hydration Doctrine's CID-skip gate
 * (hash-first-hydrate.ts) needed to be more than a standalone, unused
 * primitive (see docs/marketplank/GROK-FINDINGS-intelligence-agency-
 * maximal-vision-2026-08-26.md's "Build decision" on why CID-skip was
 * deferred until it had a real trigger).
 *
 * For each tracked EVM collection that supports ERC-4906 (checked once,
 * cached), scan for real MetadataUpdate/BatchMetadataUpdate events since
 * the last checked block, and reset exactly the affected tokens'
 * metadata_state back to 'pending' -- advanceEvmTokenMetadata's own
 * CID-skip check then decides per-token whether a real body re-fetch is
 * actually needed (a MetadataUpdate event firing does NOT itself prove the
 * URI changed, only that the contract wants viewers to re-check).
 *
 * AUDIT lens 4 #4 (Batch F4) -- this lane was broken three ways and each
 * is fixed here, with the pure pieces exported for tests:
 *   1. It picked `LIMIT 5 ... ORDER BY collection_slug` from the 19M-row
 *      token table every pass, so the same five alphabetical collections
 *      were scanned forever and nothing else ever was. Now: a durable
 *      ROTATING cursor (durable KV, per chain) over the small
 *      plank_multichain_collections table, wrapping to the start when it
 *      runs off the end.
 *   2. eth_getLogs was one unchunked call over an arbitrary block span,
 *      failures were swallowed as [] and the cursor advanced anyway --
 *      silently skipping every event in the failed range forever. Now:
 *      <= 2,000-block chunks (scanMetadataUpdateLogsChunked), and the
 *      per-collection block cursor advances only through the highest
 *      block PROVABLY scanned, and only if the DB resets also succeeded.
 *   3. BatchMetadataUpdate(0, 2^256-1) is the standard "everything
 *      changed" signal; the range update ran a numeric BETWEEN against
 *      that literal. Now: _toTokenId is clamped to the collection's known
 *      supply (clampBatchTokenRange).
 */
import { postgresQuery } from "@/lib/postgres";
import { durableKv } from "@/lib/market/durable-kv";
import {
  ERC4906_LOG_CHUNK_BLOCKS,
  hasMetadataUpdateSupport,
  scanMetadataUpdateLogsChunked,
  type MetadataUpdateLogEntry,
} from "@/lib/market/multichain/discovery/onchain-extensions";
import { rpcCall } from "@/lib/market/multichain/discovery/rpc-provider-pool";

const SUPPORT_CACHE_KEY = (chainSlug: string, contractAddress: string) =>
  `erc4906:support:${chainSlug}:${contractAddress.toLowerCase()}`;
const CURSOR_KEY = (chainSlug: string, contractAddress: string) =>
  `erc4906:cursor:${chainSlug}:${contractAddress.toLowerCase()}`;
/** Durable rotation position: the last contract address handed out for this chain. */
export const ROTATION_KEY = (chainSlug: string) => `erc4906:rotation:${chainSlug}`;

/** Bound on eth_getLogs chunks per collection per invocation: 10 x 2,000
 * = 20,000 blocks (~2.8 days on Ethereum mainnet). A cursor further
 * behind than that catches up over successive passes. */
export const MAX_CHUNKS_PER_COLLECTION = 10;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[0-9]+$/;

async function latestBlockNumber(chainSlug: string): Promise<number> {
  const { result } = await rpcCall<string>(chainSlug, "eth_blockNumber", []);
  return parseInt(result, 16);
}

/**
 * Pure clamp, exported for tests. `_toTokenId` may be any uint256 (the
 * canonical "all tokens" batch is 0..type(uint256).max); the DB range
 * update must never run against a value past what this app knows to
 * exist. Returns null when the range is empty after clamping or when the
 * inputs are not decimal integers. `maxKnownTokenId` null means "no
 * supply known" -- the range then passes through unclamped, but only if
 * it is small (<= 100,000 ids), so an unbounded batch can never turn into
 * an unbounded numeric BETWEEN.
 */
export function clampBatchTokenRange(
  fromTokenId: string,
  toTokenId: string,
  maxKnownTokenId: bigint | null,
): { from: string; to: string } | null {
  if (!DECIMAL.test(fromTokenId) || !DECIMAL.test(toTokenId)) return null;
  const from = BigInt(fromTokenId);
  let to = BigInt(toTokenId);
  if (maxKnownTokenId != null) {
    if (from > maxKnownTokenId) return null;
    if (to > maxKnownTokenId) to = maxKnownTokenId;
  } else if (to - from > 100_000n) {
    return null;
  }
  if (to < from) return null;
  return { from: from.toString(), to: to.toString() };
}

/**
 * Pure rotation step, exported for tests: given the ordered list of
 * addresses after the cursor (already `> cursor`) and the wrap-around
 * head of the list, pick this pass's batch. Wraps when the tail is short.
 */
export function rotateBatch<T>(afterCursor: T[], fromStart: T[], limit: number): { batch: T[]; wrapped: boolean } {
  const tail = afterCursor.slice(0, limit);
  if (tail.length >= limit) return { batch: tail, wrapped: false };
  const seen = new Set(tail);
  const head = fromStart.filter((x) => !seen.has(x)).slice(0, limit - tail.length);
  return { batch: [...tail, ...head], wrapped: head.length > 0 || tail.length === 0 };
}

/**
 * Highest token id this app knows for the collection: the larger of the
 * ledger's known_supply - 1 and the max numeric token id actually stored.
 * Both are indexed lookups (by chain+collection); never a full-table scan.
 */
export async function readMaxKnownTokenId(chainSlug: string, contractAddress: string): Promise<bigint | null> {
  const key = contractAddress.toLowerCase();
  const [supplyRes, maxRes] = await Promise.all([
    postgresQuery<{ known_supply: string | null }>(
      `SELECT known_supply::text FROM collection_archival_stats WHERE chain_slug = $1 AND collection_key = $2`,
      [chainSlug, key],
    ).catch(() => ({ rows: [] as Array<{ known_supply: string | null }> })),
    postgresQuery<{ max_id: string | null }>(
      `SELECT max(token_id::numeric)::text AS max_id FROM plank_collection_tokens
       WHERE chain_slug = $1 AND lower(collection_slug) = $2 AND token_id ~ '^[0-9]{1,30}$'`,
      [chainSlug, key],
    ).catch(() => ({ rows: [] as Array<{ max_id: string | null }> })),
  ]);
  const candidates: bigint[] = [];
  const supply = supplyRes.rows[0]?.known_supply;
  if (supply && DECIMAL.test(supply) && BigInt(supply) > 0n) candidates.push(BigInt(supply) - 1n);
  const maxId = maxRes.rows[0]?.max_id;
  if (maxId && DECIMAL.test(maxId)) candidates.push(BigInt(maxId));
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (a > b ? a : b));
}

/** Next `limit` tracked EVM collections after the durable rotation cursor, wrapping. */
async function selectRotatingCandidates(chainSlug: string, limit: number): Promise<{ addresses: string[]; wrapped: boolean }> {
  const cursor = (await durableKv.get<string>(ROTATION_KEY(chainSlug)).catch(() => null)) ?? "";
  const [afterRes, headRes] = await Promise.all([
    postgresQuery<{ contract_address: string }>(
      `SELECT DISTINCT lower(contract_address) AS contract_address FROM plank_multichain_collections
       WHERE chain_slug = $1 AND contract_address ~* '^0x[0-9a-f]{40}$' AND lower(contract_address) > $2
       ORDER BY 1 LIMIT $3`,
      [chainSlug, cursor, limit],
    ),
    postgresQuery<{ contract_address: string }>(
      `SELECT DISTINCT lower(contract_address) AS contract_address FROM plank_multichain_collections
       WHERE chain_slug = $1 AND contract_address ~* '^0x[0-9a-f]{40}$'
       ORDER BY 1 LIMIT $2`,
      [chainSlug, limit],
    ),
  ]);
  const { batch, wrapped } = rotateBatch(
    afterRes.rows.map((r) => r.contract_address),
    headRes.rows.map((r) => r.contract_address),
    limit,
  );
  return { addresses: batch, wrapped };
}

/** Applies decoded entries as metadata_state resets. Throws on a DB
 * failure so the caller does not advance its cursor past unapplied events. */
async function applyResets(chainSlug: string, contractAddress: string, entries: MetadataUpdateLogEntry[]): Promise<number> {
  if (!entries.length) return 0;
  const key = contractAddress.toLowerCase();
  const singles = new Set<string>();
  const ranges: Array<{ from: string; to: string }> = [];
  let maxKnown: bigint | null | undefined; // lazily read only when a batch entry needs it
  for (const entry of entries) {
    if (entry.tokenId != null) {
      singles.add(entry.tokenId);
    } else if (entry.fromTokenId != null && entry.toTokenId != null) {
      if (maxKnown === undefined) maxKnown = await readMaxKnownTokenId(chainSlug, key);
      const clamped = clampBatchTokenRange(entry.fromTokenId, entry.toTokenId, maxKnown);
      if (clamped) ranges.push(clamped);
    }
  }
  let reset = 0;
  if (singles.size) {
    const r = await postgresQuery(
      `UPDATE plank_collection_tokens SET metadata_state = 'pending', pointer_fp = NULL
       WHERE chain_slug = $1 AND lower(collection_slug) = $2 AND token_id = ANY($3::text[])`,
      [chainSlug, key, [...singles]],
    );
    reset += r.rowCount ?? 0;
  }
  for (const range of ranges) {
    const r = await postgresQuery(
      `UPDATE plank_collection_tokens SET metadata_state = 'pending', pointer_fp = NULL
       WHERE chain_slug = $1 AND lower(collection_slug) = $2
         AND token_id ~ '^[0-9]{1,30}$' AND token_id::numeric BETWEEN $3::numeric AND $4::numeric`,
      [chainSlug, key, range.from, range.to],
    );
    reset += r.rowCount ?? 0;
  }
  return reset;
}

export type MetadataUpdateRescanResult = {
  checked: number;
  supported: number;
  tokensReset: number;
  /** Collections whose block cursor could NOT be fully advanced this pass
   * (RPC or DB failure) -- they are re-scanned from the last proven block. */
  stalled: number;
  wrapped: boolean;
};

/** One bounded pass: the next `limit` tracked collections in durable
 * rotation order. Never re-checks a contract's ERC-4906 support more than
 * once per 30 days (most collections don't implement it at all). */
export async function runMetadataUpdateRescanBatch(
  chainSlug: string,
  limit: number = 5,
): Promise<MetadataUpdateRescanResult> {
  const { addresses, wrapped } = await selectRotatingCandidates(chainSlug, limit);
  let supported = 0;
  let tokensReset = 0;
  let stalled = 0;
  let latest: number | null | undefined; // one eth_blockNumber per pass, lazily

  for (const contractAddress of addresses) {
    // Rotation advances per collection HANDLED (support check included), so a
    // collection that fails is not retried forever at the head of the line.
    await durableKv.set(ROTATION_KEY(chainSlug), contractAddress).catch(() => {});
    if (!EVM_ADDRESS.test(contractAddress)) continue;

    const cacheKey = SUPPORT_CACHE_KEY(chainSlug, contractAddress);
    let doesSupport = await durableKv.get<boolean>(cacheKey).catch(() => null);
    if (doesSupport === null) {
      const probe = await hasMetadataUpdateSupport(chainSlug, contractAddress).catch(() => null);
      if (probe === null) continue; // unknown (RPC failure / no ERC-165): re-probe next rotation, never cached
      doesSupport = probe;
      await durableKv.set(cacheKey, doesSupport, { ex: 30 * 24 * 60 * 60 }).catch(() => {});
    }
    if (!doesSupport) continue;
    supported += 1;

    const cursorKey = CURSOR_KEY(chainSlug, contractAddress);
    const lastScanned = (await durableKv.get<number>(cursorKey).catch(() => null)) ?? 0;
    if (latest === undefined) latest = await latestBlockNumber(chainSlug).catch(() => null);
    if (latest == null) { stalled += 1; continue; }
    if (latest <= lastScanned) continue;

    // A cold cursor starts at the head: historical MetadataUpdate events
    // predate any row we hold, and the normal metadata lane fetches those
    // bodies fresh anyway.
    if (lastScanned === 0) {
      await durableKv.set(cursorKey, latest).catch(() => {});
      continue;
    }

    const scan = await scanMetadataUpdateLogsChunked(chainSlug, contractAddress, {
      fromBlock: lastScanned + 1, toBlock: latest,
      chunkSize: ERC4906_LOG_CHUNK_BLOCKS, maxChunks: MAX_CHUNKS_PER_COLLECTION,
    });
    if (scan.scannedThrough == null) { stalled += 1; continue; }
    try {
      tokensReset += await applyResets(chainSlug, contractAddress, scan.entries);
    } catch {
      stalled += 1;
      continue; // resets not applied: keep the cursor so the same range is re-scanned
    }
    let cursorWritten = true;
    await durableKv.set(cursorKey, scan.scannedThrough).catch(() => { cursorWritten = false; });
    if (!cursorWritten || scan.error) stalled += 1; // partial progress recorded; the rest is retried next pass
  }

  return { checked: addresses.length, supported, tokensReset, stalled, wrapped };
}
