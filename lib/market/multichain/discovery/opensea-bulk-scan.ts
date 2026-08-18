/**
 * Bulk collection discovery for the 7 real foreign EVM chains, via the SAME
 * technique opensea-robinhood-scan.ts proved live: OpenSea's paginated
 * GET /api/v2/collections?chain={slug} list endpoint enumerates real
 * contract addresses far faster than evm-log-scan.ts's 10-block-per-tick
 * eth_getLogs scanner (which registered only ~300 collections total across
 * 8 chains after 85+ ticks this session).
 *
 * WHY evm-log-scan.ts's OWN HEADER SAYS THIS ROUTE "DOESN'T EXIST" -- AND
 * WHY THAT'S RIGHT FOR RANKING BUT NOT FOR DISCOVERY
 * ---------------------------------------------------------------------------
 * That file's header is correct that OpenSea's /collections list has no
 * floor/volume fields, so it can't back ChainAdapter.discoverTopCollections
 * (which needs a real ranking metric). But bulk DISCOVERY -- "what contract
 * addresses exist" -- doesn't need a ranking metric at all. This module
 * pages the list purely to enumerate real addresses, then hands each one to
 * the SAME alchemyNftAdapter.fetchSnapshot() + isNotRealCollectibleArt gate
 * evm-log-scan.ts already trusts for real name/image/floor and spam
 * filtering -- no new verification logic, no lowered bar, just a much
 * faster address-enumeration front end for chains OpenSea already indexes
 * well (unlike Robinhood Chain, these 7 are real, well-known EVM chains
 * OpenSea has deep coverage of).
 *
 * Verified live 2026-08-19 with the real OPENSEA_API_KEY already configured
 * in .env.local: `curl ".../collections?chain=base&limit=5" -H "x-api-key:
 * $OPENSEA_API_KEY"` returned 5 real Base collections with real
 * contracts[0].address entries and a `next` cursor, the identical response
 * shape opensea-robinhood-scan.ts already parses -- confirming the same
 * OpenSeaCollectionsPage type applies chain-agnostically.
 */
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import { postgresQuery } from "@/lib/postgres";
import { upsertTrackedCollection, updateCollectionDisplay, hasMultichainStore } from "@/lib/market/multichain/store";
import { alchemyNftAdapter } from "@/lib/market/multichain/adapters/alchemy-nft";
import { isNotRealCollectibleArt } from "@/lib/market/multichain/discovery/evm-log-scan";
import { FOREIGN_CHAINS } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { durableKv as kv } from "@/lib/market/durable-kv";

/**
 * Persists OpenSea's own opaque pagination cursor per chain -- a plain
 * string, not a block number, so this reuses the same durable-kv.ts store
 * opensea.ts's own managed-API-key persistence already runs on in
 * production, rather than the block-number-typed
 * plank_multichain_discovery_cursor table evm-log-scan.ts uses (wrong
 * shape for this). WITHOUT this, confirmed live: 3 consecutive runs each
 * re-fetched the SAME first 3 pages (900 entries) per chain, since nothing
 * remembered where the previous run left off -- registration plateaued at
 * 0 new by the 3rd run despite OpenSea having far more real collections
 * beyond that window.
 */
function cursorKey(chainSlug: string): string {
  return `plank:market:opensea-bulk-scan-cursor:${chainSlug}`;
}
async function readBulkCursor(chainSlug: string): Promise<string | null> {
  return (await kv.get<string>(cursorKey(chainSlug))) ?? null;
}
async function writeBulkCursor(chainSlug: string, cursor: string | null): Promise<void> {
  await kv.set(cursorKey(chainSlug), cursor);
}

const OPENSEA_BASE = "https://api.opensea.io/api/v2";

type OpenSeaCollectionEntry = {
  collection: string;
  name: string | null;
  image_url: string | null;
  contracts: Array<{ address: string; chain: string }>;
};

type OpenSeaCollectionsPage = {
  collections: OpenSeaCollectionEntry[];
  next: string | null;
};

async function fetchCollectionsPage(apiKey: string, openSeaChain: string, cursor: string | null): Promise<OpenSeaCollectionsPage> {
  const url = new URL(`${OPENSEA_BASE}/collections`);
  url.searchParams.set("chain", openSeaChain);
  url.searchParams.set("limit", "100");
  if (cursor) url.searchParams.set("next", cursor);
  const res = await fetch(url.toString(), {
    headers: { "x-api-key": apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`opensea-bulk-scan: ${res.status} ${res.statusText} fetching chain=${openSeaChain} -- ${body.slice(0, 200)}`);
  }
  return (await res.json()) as OpenSeaCollectionsPage;
}

export type OpenSeaBulkScanResult = {
  chainSlug: string;
  pagesScanned: number;
  entriesSeen: number;
  registered: number;
  skippedNotArt: number;
  skippedNoMetadata: number;
  skippedAlreadyTracked: number;
  error?: string;
};

/**
 * Pages one chain's OpenSea collection list (100/page, up to maxPages),
 * registering every real, new, genuinely-collectible contract. Bounded per
 * call for the same reason every other discovery module here is (meant to
 * run repeatedly on the existing cron cadence, not as one unbounded
 * backfill against a free-tier key).
 */
export async function runOpenSeaBulkScan(
  input: { chainSlug: string; openSeaChain: string; chainId: number | null; maxPages?: number }
): Promise<OpenSeaBulkScanResult> {
  const maxPages = input.maxPages ?? 3;
  const base: OpenSeaBulkScanResult = {
    chainSlug: input.chainSlug,
    pagesScanned: 0,
    entriesSeen: 0,
    registered: 0,
    skippedNotArt: 0,
    skippedNoMetadata: 0,
    skippedAlreadyTracked: 0,
  };
  const apiKey = await getOpenSeaApiKey();
  if (!apiKey) return { ...base, error: "opensea-bulk-scan: no OpenSea API key available" };
  if (!hasMultichainStore()) return { ...base, error: "opensea-bulk-scan: no multichain datastore configured" };

  let cursor: string | null = await readBulkCursor(input.chainSlug);
  const result = { ...base };

  try {
    for (let page = 0; page < maxPages; page++) {
      const pageData = await fetchCollectionsPage(apiKey, input.openSeaChain, cursor);
      result.pagesScanned += 1;
      result.entriesSeen += pageData.collections.length;

      for (const entry of pageData.collections) {
        // Polygon-specific OpenSea inconsistency, same one listings/route.ts
        // already works around: the collection LIST's own contracts[].chain
        // field returns "polygon" even when queried with chain=matic
        // (confirmed live 2026-08-19 -- `curl .../collections?chain=matic`
        // returned real entries whose contracts[0].chain was "polygon", not
        // "matic"). Without this alias, EVERY Polygon entry silently failed
        // this find() and the loop `continue`d before any counter
        // incremented -- entriesSeen kept climbing while registered/
        // skippedNotArt/skippedNoMetadata/skippedAlreadyTracked all stayed
        // at zero, which is exactly the "0/0/0/0 out of 300 seen" signature
        // that flagged this as a real bug rather than a genuinely thin chain.
        const acceptableChainValues = input.openSeaChain === "matic" ? ["matic", "polygon"] : [input.openSeaChain];
        const contract = entry.contracts.find((c) => acceptableChainValues.includes(c.chain));
        if (!contract?.address) continue;
        const contractAddress = contract.address.toLowerCase();

        const existing = await postgresQuery<{ id: number }>(
          `SELECT id FROM plank_multichain_collections WHERE chain_slug = $1 AND contract_address = $2`,
          [input.chainSlug, contractAddress]
        );
        if (existing.rows.length > 0) {
          result.skippedAlreadyTracked += 1;
          continue;
        }

        // Same trust boundary evm-log-scan.ts already relies on: OpenSea's
        // listing alone doesn't prove real, current on-chain metadata --
        // fetchSnapshot re-derives name/image/floor directly from Alchemy,
        // and a contract Alchemy can't resolve is simply not registered.
        let snapshot;
        try {
          snapshot = await alchemyNftAdapter.fetchSnapshot({ chainSlug: input.chainSlug, contractAddress });
        } catch {
          result.skippedNoMetadata += 1;
          continue;
        }
        const name = snapshot.name ?? entry.name;
        const imageUrl = snapshot.imageUrl ?? entry.image_url;
        if (isNotRealCollectibleArt(name, imageUrl)) {
          result.skippedNotArt += 1;
          continue;
        }

        const id = await upsertTrackedCollection({
          chainSlug: input.chainSlug,
          chainId: input.chainId,
          contractAddress,
          adapter: alchemyNftAdapter.name,
        });
        const { writeSnapshot } = await import("@/lib/market/multichain/store");
        await writeSnapshot(id, snapshot).catch(() => {});
        await updateCollectionDisplay(input.chainSlug, contractAddress, { name: name ?? null, imageUrl: imageUrl ?? null }).catch(
          () => {}
        );
        result.registered += 1;
      }

      if (!pageData.next) {
        // Exhausted the list -- reset to null so the NEXT invocation starts
        // over from page 1 rather than getting permanently stuck past the
        // end (OpenSea's list grows over time; restarting periodically also
        // re-checks earlier entries that may have been "not-art" before but
        // gained real metadata since).
        cursor = null;
        break;
      }
      cursor = pageData.next;
    }
    await writeBulkCursor(input.chainSlug, cursor).catch(() => {});
  } catch (error) {
    await writeBulkCursor(input.chainSlug, cursor).catch(() => {});
    return { ...result, error: error instanceof Error ? error.message : String(error) };
  }

  return result;
}

/** Runs runOpenSeaBulkScan for every real registered foreign EVM chain, sequentially (same rate-limit discipline runAllEvmDiscoveryScans already uses). */
export async function runAllOpenSeaBulkScans(input: { maxPages?: number } = {}): Promise<OpenSeaBulkScanResult[]> {
  const results: OpenSeaBulkScanResult[] = [];
  for (const chain of FOREIGN_CHAINS) {
    results.push(
      await runOpenSeaBulkScan({
        chainSlug: chain.chainSlug,
        openSeaChain: chain.openSeaChain,
        chainId: chain.chainId,
        maxPages: input.maxPages,
      })
    );
  }
  return results;
}
