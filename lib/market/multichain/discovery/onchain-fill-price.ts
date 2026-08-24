/**
 * Free, on-chain "realized floor" from real Seaport marketplace fills --
 * item 5 of the priority build list (docs/AUDIT-onchain-data-extraction-2026-08-24.md
 * §1.7, docs/RESEARCH-free-floor-banner-data-2026-08-24.md §1b).
 *
 * REUSES THE ALREADY-VERIFIED SEAPORT INFRA, DOES NOT RE-DECLARE IT
 * ------------------------------------------------------------------
 * This app already has production Seaport-fill infra
 * (lib/market/multichain/seaport-fill-indexer.ts +
 * lib/market/multichain/seaport-deployments.ts), including:
 *   - The real `OrderFulfilled` ABI (SpentItem[]/ReceivedItem[] tuples),
 *     built against the actual Seaport 1.5/1.6 source
 *     (ProjectOpenSea/seaport, `contracts/lib/SeaportEventsAndErrors.sol` /
 *     `ConsiderationEventsAndErrors.sol`) -- not re-typed here, since a
 *     second hand-copy is exactly how the two ABIs silently drift and one
 *     starts producing garbage prices.
 *   - `ALL_SEAPORT_ADDRESSES` -- the same canonical address across every
 *     EVM chain this app trades on. seaport.ts's own top-level assertion
 *     already checks live that FOREIGN_SEAPORT_ADDRESS ===
 *     Robinhood Chain's SEAPORT_ADDRESS; ALL_SEAPORT_ADDRESSES additionally
 *     covers every prior deployment (1.1 through 1.6) so a scan never
 *     misses an older fill still settling against an earlier version.
 *     Seaport 1.6 (0x0000000000000068F116a894984e2DB1123eB395) is the
 *     current/active one -- confirmed both by this repo's own
 *     SEAPORT_ADDRESS constant (lib/constants.ts) matching it and by a
 *     live eth_getCode call against eth-mainnet during this build (see
 *     scripts/debug-seaport-fill-verify.ts, deleted after use) returning
 *     real deployed bytecode at that address.
 *   - `decodeOrderFulfilled` -- side-aware (offer vs. consideration),
 *     total-aware (sums every payment leg sharing the dominant currency,
 *     not just the first item) decode, already unit-tested against real
 *     ABI-encoded logs (test/market/seaport-fill-indexer.test.ts) and
 *     hardened against the H4 audit finding (a crafted order can't spoof
 *     price by front-loading a decoy cheap leg). Re-deriving this by hand
 *     here would both duplicate real work and very likely reintroduce a
 *     bug that file's own history already paid to fix.
 *
 * WHAT THIS FILE ADDS THAT DOESN'T EXIST YET
 * ------------------------------------------------------------------
 * seaport-fill-indexer.ts's scanChainForFills is a whole-chain, cursor-based,
 * Postgres-writing background indexer -- the right shape for "index every
 * fill on this chain forever," wrong shape for "give me fills for THIS one
 * collection over THIS block range, right now, no DB." This module is the
 * light, synchronous, read-only sibling: same decode, same canonical
 * addresses, but callable directly for a single collection's floor
 * triangulation (e.g. an on-demand banner/floor hydration call), using the
 * free multi-vendor rpc-provider-pool.ts pool (matches this module's own
 * documented pattern: `rpcCall(chainSlug, method, params)`) instead of a
 * single RPC URL.
 *
 * CHUNKING: reuses the same 10-block ceiling
 * lib/market/multichain/discovery/evm-log-scan.ts verified live against a
 * real (non-demo) Alchemy key as the free tier's real eth_getLogs range
 * cap -- kept conservative here too rather than assuming a wider window
 * works on every provider in the pool.
 *
 * WHY A COLLECTION-ADDRESS FILTER ALONE DOESN'T WORK
 * ------------------------------------------------------------------
 * Seaport is one shared contract for every collection -- `OrderFulfilled`
 * carries the traded NFT's contract only inside the unindexed `data` blob
 * (offer/consideration item arrays), never as a topic. So this scans
 * Seaport's OWN address for OrderFulfilled logs in the given range, decodes
 * every one via decodeOrderFulfilled, and keeps only fills where at least
 * one asset leg's token address matches the target collection --
 * client-side filtering is unavoidable here, not a shortcut.
 */
import { rpcCall } from "@/lib/market/multichain/discovery/rpc-provider-pool";
import { ALL_SEAPORT_ADDRESSES } from "@/lib/market/multichain/seaport-deployments";
import { ORDER_FULFILLED_TOPIC, decodeOrderFulfilled } from "@/lib/market/multichain/seaport-fill-indexer";

/**
 * Chunk size for a single eth_getLogs call, in blocks.
 *
 * NOT the same 10-block figure evm-log-scan.ts verified for Alchemy's free
 * tier -- that ceiling is Alchemy-specific and this pool tries the FREE
 * public providers first. Live-verified against this pool's own two free
 * providers during this build (2026-08-24, direct calls against
 * ALL_SEAPORT_ADDRESSES + the real ORDER_FULFILLED_TOPIC):
 *   - publicnode.com's free tier only serves eth_getLogs over roughly the
 *     last ~64 blocks from head -- anything older returns a real HTTP 403
 *     ("Archive requests require a personal token"). It is effectively
 *     useless for a historical range and always falls through to drpc for
 *     one here, at the cost of one wasted (but non-jailing, since 403 isn't
 *     treated as a quota error) round trip per chunk.
 *   - drpc.org's free tier caps a single eth_getLogs call at 10,000 blocks
 *     -- confirmed live via its own real error message ("ranges over 10000
 *     blocks are not supported on free plan") when a wider single-call
 *     span was tried directly. Below that cap it has no further
 *     block-count restriction, but does have a real per-second RATE limit
 *     (confirmed live via repeated real HTTP 429, "Public endpoint rate
 *     limit", under sub-second request spacing) and can genuinely time out
 *     on a chunk with an unusually large result set (real HTTP 408 seen
 *     live on some 9,000-block windows during mainnet-wide Seaport
 *     activity spikes -- ALL_SEAPORT_ADDRESSES + ORDER_FULFILLED_TOPIC with
 *     no collection filter yet, since the collection filter only happens
 *     client-side after decode, can return tens of thousands of logs in
 *     one chunk). rpc-provider-pool.ts's own recordSourceFailure treats
 *     ANY 429 (and 3 consecutive failures of any kind, including
 *     publicnode's non-quota 403s above) as jail-worthy, which can strand
 *     a chunk with nowhere left to retry within the SAME rpcCall attempt
 *     if Alchemy's separate monthly quota is also already exhausted (see
 *     rpc-provider-pool.ts's own header) -- see fetchLogsWithRetry below
 *     for how this module recovers from that.
 * CHUNK_BLOCKS stays safely under drpc's real 10,000-block cap; paced by
 * CHUNK_DELAY_MS to stay under its real rate limit.
 */
const CHUNK_BLOCKS = 9000;

/**
 * Pacing delay between chunk requests -- see CHUNK_BLOCKS's own comment for
 * the real rate-limit behavior this is tuned against (drpc.org's free tier
 * genuinely 429s under sustained sub-second request spacing).
 */
const CHUNK_DELAY_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type SeaportFillEvent = {
  tokenId: string;
  priceWei: string;
  /** "ETH" for the chain's native currency, or the ERC-20 token address for anything else. */
  currency: string;
  buyer: string;
  seller: string;
  blockNumber: number;
  transactionHash: string;
};

type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string };

function toHex(n: number): string {
  return "0x" + n.toString(16);
}

/** Real backoff schedule for a stuck chunk -- see fetchLogsWithRetry's own header for why this exists on top of rpcCall's own provider fallback. */
const CHUNK_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

/**
 * rpcCall already retries a single request across every unjailed provider
 * (free public RPC first, Alchemy last -- rpc-provider-pool.ts), but that
 * doesn't cover ALL real failure modes seen live during this build
 * (2026-08-24, direct probes against real endpoints):
 *   - drpc.org's free tier has a real per-second rate limit and returns a
 *     genuine HTTP 429 under sustained chunk requests; rpc-provider-pool.ts
 *     treats ANY 429 as a quota signal and jails that provider for 15
 *     minutes on the spot (its own DEFAULT_JAIL_MS) -- correct for a real
 *     monthly-exhaustion 429 (Alchemy's case), but too blunt for drpc's
 *     transient rate-limit 429, which clears again within seconds.
 *   - publicnode.com's free tier 403s any range older than roughly the
 *     last ~64 blocks ("archive requests require a personal token") --
 *     not fixable by retrying, just an expected miss that rpcCall already
 *     falls through past.
 * Once drpc is jailed this way, a chunk in the same run has nowhere left
 * to go (publicnode fails, drpc jailed, Alchemy separately exhausted) and
 * rpcCall throws. Retrying the SAME chunk after a real pause is the
 * correct response to a transient rate limit -- CHUNK_RETRY_DELAYS_MS is
 * comfortably shorter than drpc's real 15-minute jail but long enough
 * for a genuinely transient rate-limit condition to clear.
 */
async function fetchLogsWithRetry(chainSlug: string, params: Record<string, unknown>): Promise<RawLog[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CHUNK_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const { result } = await rpcCall<RawLog[]>(chainSlug, "eth_getLogs", [params]);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < CHUNK_RETRY_DELAYS_MS.length) {
        await sleep(CHUNK_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastError;
}

/**
 * Scans real `OrderFulfilled` logs against Seaport's own canonical
 * addresses over [fromBlock, toBlock], decodes each with the app's
 * already-verified decoder, and keeps only fills that actually moved a
 * token of `contractAddress` -- checked against every asset leg
 * (decodeOrderFulfilled's `assetLegs`), not just the single "subject" NFT
 * decodeOrderFulfilled picks for its own `nftContract`/`tokenId` fields,
 * since a bundle/swap order can carry NFTs from more than one collection.
 *
 * `toBlock: "latest"` resolves via a real `eth_blockNumber` call through
 * the same pool before scanning -- never assumed.
 *
 * Chunked at CHUNK_BLOCKS per real eth_getLogs call, paced by
 * CHUNK_DELAY_MS and retried per-chunk via fetchLogsWithRetry -- see both
 * of those for the real, live-verified provider limits this is tuned
 * against.
 */
export async function scanSeaportFills(
  chainSlug: string,
  contractAddress: string,
  opts: { fromBlock: number; toBlock: number | "latest" }
): Promise<SeaportFillEvent[]> {
  const target = contractAddress.toLowerCase();

  let toBlock: number;
  if (opts.toBlock === "latest") {
    const head = await rpcCall<string>(chainSlug, "eth_blockNumber", []);
    toBlock = Number.parseInt(head.result, 16);
  } else {
    toBlock = opts.toBlock;
  }
  const fromBlock = opts.fromBlock;
  if (fromBlock > toBlock) return [];

  const fills: SeaportFillEvent[] = [];

  for (let windowStart = fromBlock; windowStart <= toBlock; windowStart += CHUNK_BLOCKS) {
    const windowEnd = Math.min(toBlock, windowStart + CHUNK_BLOCKS - 1);
    const logs = await fetchLogsWithRetry(chainSlug, {
      fromBlock: toHex(windowStart),
      toBlock: toHex(windowEnd),
      address: ALL_SEAPORT_ADDRESSES,
      topics: [ORDER_FULFILLED_TOPIC],
    });

    for (const log of logs) {
      const fill = decodeOrderFulfilled(log.topics, log.data);
      if (!fill) continue;
      // Only fills that actually reached a real price and moved a token of
      // THIS collection -- checked across every asset leg, not just the
      // single decoded "subject" NFT.
      if (fill.priceWei === null) continue;
      const matchingLeg = fill.assetLegs.find((leg) => leg.token === target);
      if (!matchingLeg) continue;

      fills.push({
        tokenId: matchingLeg.tokenId ?? "",
        priceWei: fill.priceWei,
        currency: fill.currencyToken === null ? "ETH" : fill.currencyToken,
        buyer: fill.buyer,
        seller: fill.seller,
        blockNumber: Number.parseInt(log.blockNumber, 16),
        transactionHash: log.transactionHash,
      });
    }

    if (windowEnd < toBlock) {
      await sleep(CHUNK_DELAY_MS);
    }
  }

  return fills;
}

export type RealizedFloorResult = {
  floorEstimate: string | null;
  currency: string;
  sampleSize: number;
};

/**
 * Pure function, no RPC calls -- turns a set of already-fetched fills into
 * a realized-floor estimate.
 *
 * WHY THE 10TH PERCENTILE, NOT THE RAW MINIMUM
 * ------------------------------------------------------------------
 * Per docs/RESEARCH-free-floor-banner-data-2026-08-24.md §1b: a raw
 * `min(sale_price)` over real fills is trivially dragged to near-zero by a
 * single dust/wash-trade fill (e.g. a self-fill at 1 wei to farm activity,
 * or a genuine but non-representative distress sale). A low percentile
 * (10th, by default) keeps the "recent realized floor" signal close to the
 * true clearing price while discarding exactly that kind of outlier,
 * without needing a bespoke wash-trade detector -- the same tradeoff the
 * research doc calls out explicitly for this exact use case.
 *
 * Only fills denominated in the DOMINANT currency across the sample (the
 * currency most fills share) are used -- mixing ETH and an arbitrary ERC-20
 * total would be meaningless, the same non-negotiable rule
 * decodeOrderFulfilled itself already applies per-order.
 */
export function computeRealizedFloor(
  fills: SeaportFillEvent[],
  opts?: { percentile?: number }
): RealizedFloorResult {
  if (fills.length === 0) {
    return { floorEstimate: null, currency: "ETH", sampleSize: 0 };
  }

  const percentile = opts?.percentile ?? 10;

  const countByCurrency = new Map<string, number>();
  for (const fill of fills) {
    countByCurrency.set(fill.currency, (countByCurrency.get(fill.currency) ?? 0) + 1);
  }
  let dominantCurrency = fills[0].currency;
  let dominantCount = 0;
  for (const [currency, count] of countByCurrency) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantCurrency = currency;
    }
  }

  const prices = fills
    .filter((fill) => fill.currency === dominantCurrency)
    .map((fill) => BigInt(fill.priceWei))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  if (prices.length === 0) {
    return { floorEstimate: null, currency: dominantCurrency, sampleSize: 0 };
  }

  // Nearest-rank method: index = ceil(p/100 * N) - 1, clamped into range.
  const rank = Math.min(prices.length, Math.max(1, Math.ceil((percentile / 100) * prices.length)));
  const floor = prices[rank - 1];

  return { floorEstimate: floor.toString(), currency: dominantCurrency, sampleSize: prices.length };
}
