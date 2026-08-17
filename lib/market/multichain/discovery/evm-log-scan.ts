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
import { upsertTrackedCollection } from "@/lib/market/multichain/store";
import { alchemyNftAdapter } from "@/lib/market/multichain/adapters/alchemy-nft";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Mirrors alchemy-nft.ts's ALCHEMY_NETWORK_SUBDOMAIN chainSlug set. */
const EVM_CHAIN_ID: Record<string, number> = {
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
const MIN_TRANSFERS_TO_CONSIDER = 2;

type RawLog = { address: string; topics: string[]; blockNumber: string };

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

async function readCursor(chainSlug: string): Promise<number | null> {
  const result = await postgresQuery<{ last_scanned_block: string }>(
    `SELECT last_scanned_block FROM plank_multichain_discovery_cursor WHERE chain_slug = $1`,
    [chainSlug]
  );
  return result.rows[0] ? Number(result.rows[0].last_scanned_block) : null;
}

async function writeCursor(chainSlug: string, block: number): Promise<void> {
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
      topics: [TRANSFER_TOPIC],
    },
  ]);

  const tally = new Map<string, number>();
  for (const log of logs) {
    if (log.topics.length !== 4) continue; // 3 topics = ERC-20 sharing the same signature, not ours
    const key = log.address.toLowerCase();
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }

  const candidates = [...tally.entries()].filter(([, count]) => count >= MIN_TRANSFERS_TO_CONSIDER);

  let registered = 0;
  let skippedNoMetadata = 0;
  for (const [contractAddress] of candidates) {
    try {
      const snapshot = await alchemyNftAdapter.fetchSnapshot({ chainSlug: input.chainSlug, contractAddress });
      if (!snapshot.name) {
        // No OpenSea-recognized metadata came back -- the real "is this a
        // legitimate collection" signal this module leans on instead of
        // inventing its own spam heuristic. See header comment.
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
      skippedNoMetadata += 1;
    }
  }

  await writeCursor(input.chainSlug, toBlock);

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

export async function runAllEvmDiscoveryScans(): Promise<DiscoveryScanResult[]> {
  const apiKey = process.env.ALCHEMY_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ALCHEMY_API_KEY is required for EVM discovery scanning (raw eth_getLogs, not the NFT API's demo-key fallback).");
  }
  const results: DiscoveryScanResult[] = [];
  // Sequential, same reasoning as runMultichainSync and runChainIndexer:
  // one chain's scan finishing before the next starts is what keeps this
  // inside the free tier's real per-call constraints instead of fanning
  // out and risking a burst the account-wide rate limit doesn't like.
  for (const chainSlug of DISCOVERY_CHAINS) {
    try {
      results.push(await runEvmDiscoveryScan({ chainSlug, rpcUrl: `https://${chainSlug}.g.alchemy.com/v2/${apiKey}` }));
    } catch (error) {
      results.push({
        chainSlug,
        fromBlock: 0,
        toBlock: 0,
        logsScanned: 0,
        candidates: 0,
        registered: 0,
        skippedNoMetadata: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
