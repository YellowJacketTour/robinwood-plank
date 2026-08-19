/**
 * HyperSync-backed EVM collection discovery -- the fast path.
 *
 * WHY THIS EXISTS
 * ----------------
 * evm-log-scan.ts's real, verified constraint: a free-tier Alchemy key caps
 * raw eth_getLogs at a 10-block window per call, confirmed live 2026-08-17.
 * That module exists to work within that ceiling; this one exists to blow
 * past it. Envio's HyperSync (github.com/enviodev, @envio-dev/hypersync-client)
 * is independently benchmarked at up to 2000x faster than RPC for sparse
 * log scans (a full Arbitrum sparse scan: ~2s vs hours/days over RPC) and
 * covers 86+ EVM chains from one client library -- researched and verified
 * against the real, installed package's own index.d.ts (not assumed from
 * docs alone) 2026-08-20.
 *
 * THE HONEST LIMIT, STATED PLAINLY
 * ----------------------------------
 * HyperSync's free tier is capped (soft limit ~100k events processed /
 * 5GB storage / flagged after 7 days idle) -- explicitly positioned for
 * development/testing, not unlimited. A genuine full-history backfill
 * across every chain's entire Transfer event history is realistically
 * tens of millions of events per major chain and WILL exceed that ceiling.
 * This module does not pretend otherwise: CHUNK_BLOCKS below is large
 * relative to evm-log-scan.ts's 10, but still bounded per invocation, so
 * repeated cron ticks make real, fast, gradual progress toward full
 * history rather than either stalling (the old 10-block ceiling) or
 * blowing the free quota in one run.
 *
 * REQUIRES ENVIO_API_TOKEN (server-only env var, generated at
 * envio.dev/app/api-tokens -- required for all HyperSync access since
 * 2025-11-03). Fails closed with a clear, actionable error when unset --
 * same posture as every other optional-external-key path in this app
 * (ALCHEMY_API_KEY, MAGICEDEN_API_KEY), never a silent no-op.
 *
 * Shares its downstream pipeline with evm-log-scan.ts on purpose --
 * same candidate threshold, same isNotRealCollectibleArt gate, same
 * alchemy-nft.ts metadata resolution, same discovery cursor table. The
 * only thing that changes here is HOW the raw Transfer logs are fetched;
 * every decision about what counts as a real collection stays identical
 * and lives in exactly one place (evm-log-scan.ts), imported, not
 * duplicated.
 */
import { HypersyncClient, type Query } from "@envio-dev/hypersync-client";
import { alchemyNftAdapter } from "@/lib/market/multichain/adapters/alchemy-nft";
import {
  EVM_CHAIN_ID,
  TRANSFER_TOPIC,
  MIN_TRANSFERS_TO_CONSIDER,
  isNotRealCollectibleArt,
  readCursor,
  writeCursor,
  type DiscoveryScanResult,
} from "@/lib/market/multichain/discovery/evm-log-scan";
import { upsertTrackedCollection, recordActivity } from "@/lib/market/multichain/store";

/**
 * Blocks requested per HyperSync call. Far wider than evm-log-scan.ts's
 * RPC-bound 10 -- HyperSync has no such per-call ceiling, it paginates via
 * nextBlock instead (see the while loop below) -- but still a real, finite
 * number per invocation so one cron tick can't run unbounded and blow the
 * free-tier event quota in a single pass. Tuned conservatively; raise once
 * real usage against the free tier's actual ceiling is observed live.
 */
const CHUNK_BLOCKS = 50_000;

/** Hard ceiling on total logs pulled in one invocation, independent of
 * CHUNK_BLOCKS -- a dense chain's 50k-block window can still return far
 * more raw Transfer logs than a sparse one. Protects the free-tier event
 * quota directly rather than trusting block-count alone as a proxy for it. */
const MAX_LOGS_PER_RUN = 20_000;

function requireApiToken(): string {
  const token = process.env.ENVIO_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "hypersync-evm-scan: ENVIO_API_TOKEN is not set -- generate one at " +
        "https://envio.dev/app/api-tokens (required for all HyperSync access " +
        "since 2025-11-03). This scan is skipped, not silently run as a no-op."
    );
  }
  return token;
}

function hypersyncUrl(chainId: number): string {
  return `https://${chainId}.hypersync.xyz`;
}

/**
 * Scans forward from the stored cursor using HyperSync, tallies ERC-721-
 * shaped Transfer activity by contract (identical candidate logic to
 * evm-log-scan.ts's runEvmDiscoveryScan), and registers anything crossing
 * MIN_TRANSFERS_TO_CONSIDER whose metadata resolves via alchemy-nft.ts.
 */
export async function runHypersyncDiscoveryScan(input: {
  chainSlug: string;
}): Promise<DiscoveryScanResult> {
  const chainId = EVM_CHAIN_ID[input.chainSlug];
  if (!chainId) {
    return {
      chainSlug: input.chainSlug,
      fromBlock: 0,
      toBlock: 0,
      logsScanned: 0,
      candidates: 0,
      registered: 0,
      skippedNoMetadata: 0,
      error: `hypersync-evm-scan: no chainId mapping for "${input.chainSlug}"`,
    };
  }

  const apiToken = requireApiToken();
  const client = new HypersyncClient({ url: hypersyncUrl(chainId), apiToken });

  const height = await client.getHeight();
  const cursor = await readCursor(input.chainSlug);
  const fromBlock = cursor == null ? Math.max(0, height - CHUNK_BLOCKS) : cursor + 1;
  const toBlock = Math.min(height, fromBlock + CHUNK_BLOCKS);

  if (fromBlock >= toBlock) {
    return { chainSlug: input.chainSlug, fromBlock, toBlock: fromBlock, logsScanned: 0, candidates: 0, registered: 0, skippedNoMetadata: 0 };
  }

  const tally = new Map<string, number>();
  let logsScanned = 0;
  let query: Query = {
    fromBlock,
    toBlock,
    logs: [{ topics: [[TRANSFER_TOPIC]] }],
    fieldSelection: { log: ["Address", "Topic0", "Topic1", "Topic2", "Topic3", "BlockNumber"] },
  };

  let lastBlockSeen = fromBlock;
  while (logsScanned < MAX_LOGS_PER_RUN) {
    const res = await client.get(query);
    for (const log of res.data.logs) {
      // 4 topics = ERC-721 (indexed from/to/tokenId); 3 = ERC-20 sharing
      // the same Transfer signature, not ours -- same real signal
      // evm-log-scan.ts's own tally loop uses.
      if (!log.address || log.topics.length !== 4) continue;
      const key = log.address.toLowerCase();
      tally.set(key, (tally.get(key) ?? 0) + 1);
      logsScanned += 1;
    }
    lastBlockSeen = res.nextBlock;
    if (res.nextBlock >= toBlock || logsScanned >= MAX_LOGS_PER_RUN) break;
    query = { ...query, fromBlock: res.nextBlock };
  }

  await recordActivity(input.chainSlug, tally);

  const candidates = [...tally.entries()].filter(([, count]) => count >= MIN_TRANSFERS_TO_CONSIDER);

  let registered = 0;
  let skippedNoMetadata = 0;
  for (const [contractAddress] of candidates) {
    try {
      const snapshot = await alchemyNftAdapter.fetchSnapshot({ chainSlug: input.chainSlug, contractAddress });
      if (isNotRealCollectibleArt(snapshot.name, snapshot.imageUrl)) {
        skippedNoMetadata += 1;
        continue;
      }
      await upsertTrackedCollection({
        chainSlug: input.chainSlug,
        chainId: EVM_CHAIN_ID[input.chainSlug] ?? null,
        contractAddress,
        adapter: alchemyNftAdapter.name,
        isVaultBacked: false,
      });
      registered += 1;
    } catch {
      skippedNoMetadata += 1;
    }
  }

  await writeCursor(input.chainSlug, lastBlockSeen - 1);
  return { chainSlug: input.chainSlug, fromBlock, toBlock: lastBlockSeen - 1, logsScanned, candidates: candidates.length, registered, skippedNoMetadata };
}

/** Runs the HyperSync scan across every chain evm-log-scan.ts covers,
 * skipping (not throwing on) any chain HyperSync doesn't index -- same
 * fail-soft-per-chain posture runAllOpenSeaBulkScans already uses. */
export async function runAllHypersyncDiscoveryScans(): Promise<DiscoveryScanResult[]> {
  const results: DiscoveryScanResult[] = [];
  for (const chainSlug of Object.keys(EVM_CHAIN_ID)) {
    try {
      results.push(await runHypersyncDiscoveryScan({ chainSlug }));
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
