/**
 * Free, always-scanning EVM collection discovery -- no ranking API needed.
 *
 * WHY THIS EXISTS
 * ----------------
 * lib/market/multichain/types.ts's ChainAdapter.discoverTopCollections is
 * for providers with a genuine ranked-list endpoint (Magic Eden, confirmed
 * live). No such free endpoint exists for EVM as of 2026-08-17 -- OpenSea's
 * official v2 /collections list has no floor/volume fields at all, and
 * Reservoir/SimpleHash (the two services that used to make this easy) both
 * shut down their public APIs in 2025. This is the alternative: instead of
 * asking "what's popular", directly WATCH the chain and notice activity,
 * exactly the technique lib/market/chain-indexer.ts already runs in
 * production for Robinhood Chain -- just generalized to scan UNFILTERED
 * (no address parameter) for the Transfer topic, and tally by contract
 * instead of tracking one already-known address.
 *
 * THE REAL, VERIFIED CONSTRAINT THIS IS BUILT AROUND
 * ----------------------------------------------------
 * Tested live against a real (non-demo) Alchemy key, not assumed from docs:
 * the free tier hard-caps eth_getLogs at a 10-block range per call --
 * confirmed via the error message a wider request returns, which even
 * states the exact usable range. Ethereum mainnet produces a block roughly
 * every 12s, so 10 blocks is close to 2 minutes of chain time -- a near-
 * exact match for the existing 2-minute cron cadence
 * (scripts/refresh-market-data.ts), so one call's worth of window per tick
 * keeps this near-real-time without needing to burn multiple calls per
 * tick just to keep up. A resumable cursor (plank_multichain_discovery_cursor,
 * migration 014) makes backfill and live-sync the same code path, same
 * property chain-indexer.ts's own cursor already has.
 *
 * FILTERING SPAM
 * ---------------
 * Raw Transfer-log activity includes plenty of non-collection noise (ERC-20
 * tokens sharing the same topic signature at 3 topics instead of 4 are
 * already excluded by the 4-topic check; beyond that, plenty of real
 * 4-topic ERC-721 contracts are spam/scam airdrops). This module does NOT
 * try to score legitimacy itself -- it hands candidates to
 * alchemy-nft.ts's existing fetchSnapshot, and a contract whose
 * getContractMetadata call fails or returns no OpenSea-recognized metadata
 * is simply not registered. That reuses a real signal (is this collection
 * indexed by a real marketplace) instead of inventing a new heuristic.
 */
import { postgresQuery } from "@/lib/postgres";
import { upsertTrackedCollection, recordActivity, getTopByActivity } from "@/lib/market/multichain/store";
import { alchemyNftAdapter } from "@/lib/market/multichain/adapters/alchemy-nft";
import { writeChainCoverage } from "@/lib/market/multichain/control-plane";
import { pickAlchemyKey } from "@/lib/market/multichain/discovery/alchemy-key-pool";
import { recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { decodeTransferLog, writeTransferLedgerEvents, type RawTransferLog } from "@/lib/market/multichain/discovery/transfer-ledger";

/**
 * Same real-quota text alchemy-nft.ts's isAlchemyQuotaStatus already
 * verified live against Alchemy's actual response body ("Monthly capacity
 * limit exceeded... upgrade your scaling policy") -- confirmed live again
 * 2026-08-23 via a direct eth_blockNumber call against the real configured
 * key. Duplicated here (not imported) because alchemy-nft.ts's helper is
 * unexported and this module already has its own quota marker convention
 * (`QUOTA:` prefix below) rather than a thrown Error subtype.
 */
function isAlchemyQuotaText(text: string): boolean {
  return /monthly capacity|capacity limit exceeded|too many requests|rate limit|quota/i.test(text);
}

function nextUtcMonthStartMs(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** ERC-1155's two mandatory balance-change events. A collection registry
 * which only watches ERC-721 Transfer is structurally incomplete. */
export const TRANSFER_SINGLE_TOPIC = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
export const TRANSFER_BATCH_TOPIC = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

/** Mirrors alchemy-nft.ts's ALCHEMY_NETWORK_SUBDOMAIN chainSlug set. */
export const EVM_CHAIN_ID: Record<string, number> = {
  "eth-mainnet": 1,
  "polygon-mainnet": 137,
  "arb-mainnet": 42161,
  "base-mainnet": 8453,
  "opt-mainnet": 10,
  "bnb-mainnet": 56,
  "avax-mainnet": 43114,
  "zksync-mainnet": 324,
};

/**
 * Verified live 2026-08-17 against a real Alchemy key: 10 blocks is the
 * free-tier ceiling for a single eth_getLogs call on Ethereum mainnet.
 * Other EVM chains may allow more or less -- this stays conservative
 * (the confirmed-safe value) rather than assuming every chain matches.
 */
const CHUNK_BLOCKS = 10;

/**
 * A contract needs at least this many Transfers in one scanned window
 * before it's even considered a discovery candidate. 1 is too noisy (a
 * single stray transfer proves almost nothing); this is a light floor, not
 * a popularity bar -- real ranking (if any) happens downstream once a
 * candidate is actually registered and its own floor/volume gets synced.
 */
export const MIN_TRANSFERS_TO_CONSIDER = 2;

type RawLog = { address: string; topics: string[]; blockNumber: string; transactionHash: string; logIndex: string; data: string };

/**
 * Shared "is this real collectible art, or noise" gate for BOTH discovery
 * paths in this file (runEvmDiscoveryScan's own inline registration AND
 * runOwnRankingPromotion) -- extracted after finding live 2026-08-18 that
 * having two separate copies let one drift out of sync with the other's
 * fix (runOwnRankingPromotion got the real-image + position-name check
 * first; runEvmDiscoveryScan's own inline path didn't, and it's the one
 * that actually registered BNB/Optimism/Avalanche's first candidates).
 *
 * Two real signals, confirmed live against actual discovered contracts:
 *   1. No queryable image at all (many DeFi position/receipt NFTs have
 *      none -- 22 confirmed live).
 *   2. A queryable image that's a generic PROTOCOL LOGO, not per-token art
 *      (Velodrome/Aerodrome position NFTs return their protocol's brand
 *      icon as `image`) -- caught instead by the real, industry-wide
 *      naming convention every Uniswap-V3-fork protocol shares for its
 *      LP-position-receipt NFTs: Uniswap pioneered "Uniswap V3 Positions
 *      NFT-V1" and every fork copies it verbatim (PancakeSwap, Algebra,
 *      Velodrome/Aerodrome's "Slipstream Position NFT", Blackhole's
 *      "Positions NFT-V2", Clober's "Maker Order"). Not a guessed
 *      keyword list -- a real naming convention observed across every
 *      confirmed example this session found.
 */
export function isNotRealCollectibleArt(name: string | null, imageUrl: string | null): boolean {
  if (!name || !imageUrl) return true;
  return /\bposition(s)?\b|\bmaker order\b|\borderbook\b/i.test(name);
}

export async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  // Real fix, 2026-08-25 ("build the researched state of the art never
  // fail" for the activity/fills pipeline): this fetch had NO timeout at
  // all -- the same unguarded-hang class of bug found and fixed twice
  // already tonight in mesh-tick.ts and evm-hypersync-backfill-pass.mjs,
  // just one level deeper here, in the shared RPC call every one of the 8
  // real marketplace-protocol fill indexers (Seaport/Blur/Wyvern/X2Y2/
  // Foundation/Sudoswap/Rarible/CryptoKitties) uses underneath
  // seaport-fill-indexer.ts et al. A dead/hanging RPC endpoint here could
  // stall whichever lane called it for as long as the connection stayed
  // open. Matches rpc-provider-pool.ts's own already-proven 15s bound.
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) {
    // Real, live-confirmed shape (2026-08-23): Alchemy returns a real HTTP
    // 429 whose body is still valid JSON-RPC error shape
    // {code:429,message:"Monthly capacity limit exceeded..."} -- fetch()
    // still resolves (only network failures reject), so this still reaches
    // json.error either way; matched on the message text rather than
    // res.status so a 429 from some other transient cause (not this
    // specific real account-level exhaustion) doesn't over-jail. Prefixed
    // "QUOTA:" so callers can distinguish a real account-level exhaustion
    // (jail the key) from any other RPC error (e.g. "chain not enabled",
    // which must NOT jail the whole key over one chain's config gap).
    const prefix = isAlchemyQuotaText(json.error.message) ? "QUOTA:" : "";
    throw new Error(`${prefix}${method}: ${json.error.message}`);
  }
  return json.result as T;
}

export async function readCursor(chainSlug: string): Promise<number | null> {
  const result = await postgresQuery<{ last_scanned_block: string }>(
    `SELECT last_scanned_block FROM plank_multichain_discovery_cursor WHERE chain_slug = $1`,
    [chainSlug]
  );
  return result.rows[0] ? Number(result.rows[0].last_scanned_block) : null;
}

export async function writeCursor(chainSlug: string, block: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_multichain_discovery_cursor (chain_slug, last_scanned_block, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (chain_slug) DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = NOW()`,
    [chainSlug, block]
  );
}

export type DiscoveryScanResult = {
  chainSlug: string;
  fromBlock: number;
  toBlock: number;
  logsScanned: number;
  candidates: number;
  registered: number;
  skippedNoMetadata: number;
  /** Set only when the whole scan failed (e.g. chain not enabled on the configured Alchemy app). */
  error?: string;
};

/**
 * Scans ONE chunk (never more — see CHUNK_BLOCKS) forward from the stored
 * cursor, tallies ERC-721-shaped Transfer activity by contract, and
 * registers any candidate crossing MIN_TRANSFERS_TO_CONSIDER whose metadata
 * successfully resolves via the existing alchemy-nft adapter.
 */
export async function runEvmDiscoveryScan(input: {
  chainSlug: string;
  rpcUrl: string;
}): Promise<DiscoveryScanResult> {
  const head = await rpcCall<string>(input.rpcUrl, "eth_blockNumber", []);
  const headBlock = Number.parseInt(head, 16);

  const cursor = await readCursor(input.chainSlug);
  const fromBlock = cursor == null ? headBlock - CHUNK_BLOCKS : cursor + 1;
  const toBlock = Math.min(headBlock, fromBlock + CHUNK_BLOCKS - 1);

  if (fromBlock > toBlock) {
    return { chainSlug: input.chainSlug, fromBlock, toBlock: fromBlock - 1, logsScanned: 0, candidates: 0, registered: 0, skippedNoMetadata: 0 };
  }

  const logs = await rpcCall<RawLog[]>(input.rpcUrl, "eth_getLogs", [
    {
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
      topics: [[TRANSFER_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]],
    },
  ]);

  const tally = new Map<string, number>();
  const rawTransferLogs: RawTransferLog[] = [];
  for (const log of logs) {
    const topic0 = log.topics[0]?.toLowerCase();
    if (topic0 === TRANSFER_TOPIC && log.topics.length !== 4) continue; // ERC-20
    if (topic0 !== TRANSFER_TOPIC && topic0 !== TRANSFER_SINGLE_TOPIC && topic0 !== TRANSFER_BATCH_TOPIC) continue;
    const key = log.address.toLowerCase();
    tally.set(key, (tally.get(key) ?? 0) + 1);
    rawTransferLogs.push({
      address: log.address,
      topics: log.topics,
      data: log.data,
      transactionHash: log.transactionHash,
      logIndex: Number.parseInt(log.logIndex, 16),
      blockNumber: Number.parseInt(log.blockNumber, 16),
    });
  }

  // Record EVERY contract seen this window, not just discovery candidates --
  // this is what turns the scanner into a self-hosted ranking source (see
  // migration 015 and store.ts's recordActivity/getTopByActivity), a slow
  // grind across the full dataset that pays off later even for contracts
  // too quiet to cross MIN_TRANSFERS_TO_CONSIDER in any single window.
  await recordActivity(input.chainSlug, tally);

  // The permanent wallet-to-wallet transfer ledger (migration 042,
  // plank_market_events) -- decode every real Transfer/TransferSingle/
  // TransferBatch log already fetched above (never discarded after the
  // tally increment) and write it, excluding anything a real marketplace
  // fill indexer already captured on the same tx_hash. See
  // transfer-ledger.ts's own header for the full "why".
  const decodedTransfers = rawTransferLogs.flatMap((log) => decodeTransferLog(input.chainSlug, log));
  const uniqueBlocks = [...new Set(decodedTransfers.map((t) => t.blockNumber))];
  const timestampByBlock = new Map<number, number>();
  await Promise.all(
    uniqueBlocks.map(async (blockNumber) => {
      try {
        const block = await rpcCall<{ timestamp: string } | null>(input.rpcUrl, "eth_getBlockByNumber", ["0x" + blockNumber.toString(16), false]);
        if (block?.timestamp) timestampByBlock.set(blockNumber, Number.parseInt(block.timestamp, 16));
      } catch {
        // A missing timestamp is honest ("we don't know yet"), never
        // fabricated as "now" -- same contract seaport-fill-indexer.ts's
        // own writeFills already documents.
      }
    })
  );
  for (const t of decodedTransfers) t.blockTimestamp = timestampByBlock.get(t.blockNumber) ?? null;
  await writeTransferLedgerEvents(decodedTransfers);

  // A standards-shaped event is durable identity evidence. Requiring two
  // events in the same tiny scan window permanently missed quiet collections;
  // popularity belongs in ranking, not admission.
  const candidates = [...tally.entries()];

  let registered = 0;
  let skippedNoMetadata = 0;
  for (const [contractAddress] of candidates) {
    try {
      const snapshot = await alchemyNftAdapter.fetchSnapshot({ chainSlug: input.chainSlug, contractAddress });
      if (isNotRealCollectibleArt(snapshot.name, snapshot.imageUrl)) {
        // No OpenSea-recognized metadata, no queryable image, or a
        // confirmed DeFi position/receipt naming pattern -- see
        // isNotRealCollectibleArt's own comment (shared with
        // runOwnRankingPromotion below, which found this exact gap live:
        // this function's OWN inline registration path had no filter at
        // all until this fix, so BNB/Optimism/Avalanche's first discovery
        // pass registered nothing BUT DeFi position NFTs, which a
        // subsequent cleanup pass then correctly removed -- leaving those
        // chains at zero, not because no real NFT activity exists there,
        // but because this path let the wrong candidates through.
        skippedNoMetadata += 1;
        continue;
      }
      const id = await upsertTrackedCollection({
        chainSlug: input.chainSlug,
        chainId: EVM_CHAIN_ID[input.chainSlug] ?? null,
        contractAddress,
        adapter: alchemyNftAdapter.name,
        isVaultBacked: false,
      });
      const { writeSnapshot } = await import("@/lib/market/multichain/store");
      await writeSnapshot(id, snapshot);
      registered += 1;
    } catch {
      // Provider exhaustion must not discard an identity proven on-chain.
      await upsertTrackedCollection({
        chainSlug: input.chainSlug,
        chainId: EVM_CHAIN_ID[input.chainSlug] ?? null,
        contractAddress,
        adapter: alchemyNftAdapter.name,
        isVaultBacked: false,
      });
      skippedNoMetadata += 1;
      registered += 1;
    }
  }

  await writeCursor(input.chainSlug, toBlock);
  await writeChainCoverage({
    chainSlug: input.chainSlug,
    lane: "forward",
    standardGroup: "erc721+erc1155",
    rangeStart: fromBlock,
    nextBlock: toBlock + 1,
    targetBlock: headBlock + 1,
    observedHead: headBlock,
    state: toBlock >= headBlock ? "live" : "backfilling",
  });

  return {
    chainSlug: input.chainSlug,
    fromBlock,
    toBlock,
    logsScanned: logs.length,
    candidates: candidates.length,
    registered,
    skippedNoMetadata,
  };
}

/**
 * Every EVM chain this scans, in one place. Only chains actually enabled on
 * the configured Alchemy app will succeed — an unconfigured chain fails
 * that one chain's scan with a clear error rather than silently returning
 * nothing, so a partial Alchemy app setup (e.g. only eth-mainnet enabled so
 * far) is visible in the cron log instead of looking like "no NFT activity
 * anywhere but Ethereum."
 */
const DISCOVERY_CHAINS = [
  "eth-mainnet",
  "polygon-mainnet",
  "arb-mainnet",
  "base-mainnet",
  "opt-mainnet",
  "bnb-mainnet",
  "avax-mainnet",
  "zksync-mainnet",
];

export type RankingPromotionResult = {
  chainSlug: string;
  ranked: number;
  registered: number;
  skippedNoMetadata: number;
  error?: string;
};

/**
 * The other half of the self-hosted ranking: reads back
 * plank_multichain_activity_stats' trailing-window top-N for a chain (built
 * up for free by every runEvmDiscoveryScan call's recordActivity) and
 * registers any of those top contracts that aren't tracked yet. Where
 * MIN_TRANSFERS_TO_CONSIDER catches a contract the moment it's active
 * enough in ONE 10-block window, this catches a contract that's
 * consistently, quietly active across MANY windows -- the "slow grind
 * across the biggest dataset" the per-tick discovery floor can't see.
 */
export async function runOwnRankingPromotion(input: {
  chainSlug: string;
  windowDays?: number;
  limit?: number;
}): Promise<RankingPromotionResult> {
  const windowDays = input.windowDays ?? 7;
  const limit = input.limit ?? 50;
  try {
    const ranked = await getTopByActivity(input.chainSlug, windowDays, limit);
    let registered = 0;
    let skippedNoMetadata = 0;
    for (const entry of ranked) {
      try {
        const snapshot = await alchemyNftAdapter.fetchSnapshot({
          chainSlug: input.chainSlug,
          contractAddress: entry.contractAddress,
        });
        // See isNotRealCollectibleArt's own comment for the two real
        // signals this checks (no queryable image; DeFi position/receipt
        // naming convention) -- shared with runEvmDiscoveryScan's inline
        // registration above so the two discovery paths can't drift.
        if (isNotRealCollectibleArt(snapshot.name, snapshot.imageUrl)) {
          skippedNoMetadata += 1;
          continue;
        }
        const id = await upsertTrackedCollection({
          chainSlug: input.chainSlug,
          chainId: EVM_CHAIN_ID[input.chainSlug] ?? null,
          contractAddress: entry.contractAddress,
          adapter: alchemyNftAdapter.name,
          isVaultBacked: false,
        });
        const { writeSnapshot } = await import("@/lib/market/multichain/store");
        await writeSnapshot(id, snapshot);
        registered += 1;
      } catch {
        skippedNoMetadata += 1;
      }
    }
    return { chainSlug: input.chainSlug, ranked: ranked.length, registered, skippedNoMetadata };
  } catch (error) {
    return {
      chainSlug: input.chainSlug,
      ranked: 0,
      registered: 0,
      skippedNoMetadata: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runAllOwnRankingPromotions(): Promise<RankingPromotionResult[]> {
  const results: RankingPromotionResult[] = [];
  for (const chainSlug of DISCOVERY_CHAINS) {
    results.push(await runOwnRankingPromotion({ chainSlug }));
  }
  return results;
}

export async function runAllEvmDiscoveryScans(): Promise<DiscoveryScanResult[]> {
  // Background discovery lane -- picks a key from the multi-key pool
  // (least-loaded, background priority) per chain, falling back to the
  // single ALCHEMY_API_KEY. See alchemy-key-pool.ts's header: Alchemy's
  // real throughput/CU cap is account-wide, so pooling only multiplies
  // real capacity when the configured keys span separate Alchemy
  // accounts -- still built for that case, with zero regression when
  // only one key is configured.
  const results: DiscoveryScanResult[] = [];
  // Sequential, same reasoning as runMultichainSync and runChainIndexer:
  // one chain's scan finishing before the next starts is what keeps this
  // inside the free tier's real per-call constraints instead of fanning
  // out and risking a burst the account-wide rate limit doesn't like.
  for (const chainSlug of DISCOVERY_CHAINS) {
    // No unjailed key left in the pool -- either unconfigured or every
    // configured key is already circuit-broken (see the QUOTA branch
    // below). Skip cleanly instead of throwing "ALCHEMY_API_KEY is
    // required" on every chain, every tick: HyperSync (discover-hypersync)
    // shares this exact cursor table (readCursor/writeCursor, keyed only
    // by chainSlug) and keeps advancing it for free regardless, so a
    // skipped tick here is not a stalled chain, just this one redundant
    // raw-log lane sitting out until Alchemy capacity actually returns.
    const key = await pickAlchemyKey("background");
    if (!key) {
      results.push({ chainSlug, fromBlock: 0, toBlock: 0, logsScanned: 0, candidates: 0, registered: 0, skippedNoMetadata: 0, error: "alchemy-evm-logscan: no unjailed pool key configured/available -- skipped, hypersync-evm-scan still covers this chain's cursor" });
      continue;
    }
    try {
      results.push(await runEvmDiscoveryScan({ chainSlug, rpcUrl: `https://${chainSlug}.g.alchemy.com/v2/${key.apiKey}` }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("QUOTA:")) {
        // Real account-level exhaustion, confirmed by Alchemy's own response
        // text (not our own approximated daily-CU counter, which has no
        // visibility into real per-call CU cost and can read "healthy"
        // while the account is genuinely capped -- confirmed live
        // 2026-08-23: pool-health reported 1/1,000,000 used while a direct
        // eth_blockNumber call against the same key returned this exact
        // 429). Jail THIS key via the same source-budget circuit breaker
        // alchemy-key-pool.ts's orderCandidates already filters on, until
        // the real UTC month rolls over -- matches alchemy-nft.ts's
        // jailAlchemyNftUntilMonthReset exactly, so the very next call to
        // pickAlchemyKey (this loop's next chain, or the next cron tick)
        // stops retrying a call already proven to fail and falls through
        // to the clean skip branch above instead of repeating this network
        // round trip once per chain, forever.
        recordSourceFailure(key.providerAccount, true, Math.max(60_000, nextUtcMonthStartMs() - Date.now()));
        // Real bug found live 2026-08-25 ("hunt for lessons-learned
        // recurrences"): this jails only THIS specific pool key -- a real
        // third silo alongside alchemy-nft.ts's and rpc-provider-pool.ts's
        // own separate Alchemy jails, all three of which can hit the exact
        // same real account quota. Also set the shared, durable account
        // jail so a real detected exhaustion here is immediately visible
        // to those other two real call sites too.
        const { jailAlchemyAccountUntilMonthReset } = await import("@/lib/market/multichain/discovery/alchemy-account-jail");
        await jailAlchemyAccountUntilMonthReset().catch(() => {});
      }
      results.push({
        chainSlug,
        fromBlock: 0,
        toBlock: 0,
        logsScanned: 0,
        candidates: 0,
        registered: 0,
        skippedNoMetadata: 0,
        error: message,
      });
    }
  }
  return results;
}
