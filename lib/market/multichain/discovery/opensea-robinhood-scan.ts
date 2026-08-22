/**
 * Bulk Robinhood-Chain collection discovery via OpenSea's own
 * GET /api/v2/collections?chain=robinhood list endpoint -- NOT the
 * per-collection /stats lookup ChainAdapter.discoverTopCollections's own
 * doc comment (types.ts) rules out for lacking floor/volume. This is a
 * different call: a paginated LISTING of every collection OpenSea indexes
 * on a given chain, with no ranking metric needed because it isn't being
 * used to rank -- only to enumerate real contract addresses, exactly the
 * "what exists" problem robinhood-chain-scan.ts's raw eth_getLogs scanner
 * solves far more slowly (40+ runs registered only RobinWood itself).
 *
 * Verified live 2026-08-18 with a real (non-demo) OPENSEA_API_KEY already
 * configured in this repo's .env.local:
 *   curl "https://api.opensea.io/api/v2/collections?chain=robinhood&limit=5" \
 *     -H "x-api-key: $OPENSEA_API_KEY" -H "accept: application/json"
 * returned 5 real Robinhood-Chain collections in one call (Burger Brokers,
 * Case Flip, STONKSFEE itbgmtkn, two BLNK rows), each with a real
 * `contracts[0].address` on chain "robinhood", plus a `next` cursor for
 * pagination -- confirming this genuinely is what evm-log-scan.ts's own
 * header says doesn't exist for other EVM chains (a free bulk chain-wide
 * collection LIST). It works here specifically because OpenSea indexes
 * Robinhood Chain (see opensea.ts's own header) even though Alchemy's NFT
 * API does not (robinhood-chain-scan.ts's header), which is why this file
 * is scoped to "robinhood" only, not generalized to the 8 evm-log-scan.ts
 * chains -- OpenSea's /collections list has no floor/volume fields at all
 * (confirmed, types.ts), so it still can't back discoverTopCollections
 * there; on Robinhood Chain there is no ranking alternative anyway, only
 * the discovery problem this solves.
 *
 * Every candidate is still validated the same fail-closed way
 * robinhood-chain-scan.ts already does before registering: a direct
 * on-chain ERC-721 interface + name/symbol read against Robinhood Chain's
 * own RPC (never trusting OpenSea's listing alone to prove a contract is a
 * real, live ERC-721), then the same shared isNotRealCollectibleArt filter
 * every discovery path in this app uses to keep DeFi position/receipt junk
 * out.
 */
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import { upsertTrackedCollection, updateCollectionDisplay } from "@/lib/market/multichain/store";
import { ROBINHOOD_RPC_URLS, ROBINHOOD_CHAIN_ID } from "@/lib/mint-contract";
import { isNotRealCollectibleArt, rpcCall } from "@/lib/market/multichain/discovery/evm-log-scan";

const CHAIN_SLUG = "robinhood";
const OPENSEA_BASE = "https://api.opensea.io/api/v2";
const ERC721_INTERFACE_ID = "0x80ac58cd";

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

async function fetchCollectionsPage(apiKey: string, cursor: string | null): Promise<OpenSeaCollectionsPage> {
  const url = new URL(`${OPENSEA_BASE}/collections`);
  url.searchParams.set("chain", "robinhood");
  url.searchParams.set("limit", "100");
  if (cursor) url.searchParams.set("next", cursor);
  const res = await fetch(url.toString(), {
    headers: { "x-api-key": apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`opensea-robinhood-scan: ${res.status} ${res.statusText} -- ${body.slice(0, 200)}`);
  }
  return (await res.json()) as OpenSeaCollectionsPage;
}

/** Same real, on-chain-verifiable check robinhood-chain-scan.ts uses -- an OpenSea listing alone doesn't prove a contract is a live ERC-721 today. Returns null on ANY failure, fail-closed. */
async function verifyErc721(rpcUrl: string, contractAddress: string): Promise<{ name: string | null } | null> {
  try {
    const supportsErc721 = await rpcCall<string>(rpcUrl, "eth_call", [
      // bytes4 is RIGHT-padded in ABI encoding (padEnd), not left-padded --
      // confirmed live 2026-08-18: a left-padded (padStart) encoding of this
      // exact call against a real Robinhood-Chain ERC-721 contract
      // (0x1d27...a98c7, "Burger Brokers", verified via OpenSea's own
      // listing) reverts with "execution reverted", while the right-padded
      // encoding below returns the correct 0x000...001 (true). This is the
      // same bug robinhood-chain-scan.ts's readErc721Metadata had (fixed
      // alongside this file, see that file's own comment).
      { to: contractAddress, data: "0x01ffc9a7" + ERC721_INTERFACE_ID.slice(2).padEnd(64, "0") },
      "latest",
    ]);
    if (!supportsErc721 || supportsErc721 === "0x" || BigInt(supportsErc721) === 0n) return null;
    const nameHex = await rpcCall<string>(rpcUrl, "eth_call", [{ to: contractAddress, data: "0x06fdde03" }, "latest"]).catch(
      () => null
    );
    return { name: decodeAbiString(nameHex) };
  } catch {
    return null;
  }
}

function decodeAbiString(hex: string | null): string | null {
  if (!hex || hex === "0x" || hex.length < 130) return null;
  try {
    const lengthHex = hex.slice(66, 130);
    const length = parseInt(lengthHex, 16);
    if (!Number.isFinite(length) || length <= 0 || length > 200) return null;
    const dataHex = hex.slice(130, 130 + length * 2);
    const decoded = Buffer.from(dataHex, "hex").toString("utf8").replace(/\0/g, "").trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export type OpenSeaRobinhoodDiscoveryResult = {
  pagesScanned: number;
  entriesSeen: number;
  registered: number;
  skippedNotArt: number;
  skippedNotErc721: number;
  skippedAlreadyTracked: number;
  error?: string;
};

/**
 * Pages through OpenSea's /collections?chain=robinhood list (100/page,
 * following `next`) up to `maxPages`, registering every real, new,
 * genuinely-collectible ERC-721 it finds. Bounded by maxPages (not
 * "until exhausted") for the same reason evm-log-scan.ts bounds itself to
 * CHUNK_BLOCKS per tick -- this is meant to run on the existing cron
 * cadence (scripts/refresh-market-data.ts) repeatedly, not as a single
 * unbounded backfill that could run for an unknown amount of time against
 * a free-tier key.
 */
export async function runOpenSeaRobinhoodDiscoveryScan(
  input: { maxPages?: number } = {}
): Promise<OpenSeaRobinhoodDiscoveryResult> {
  const maxPages = input.maxPages ?? 5;
  const apiKey = await getOpenSeaApiKey();
  if (!apiKey) {
    return {
      pagesScanned: 0,
      entriesSeen: 0,
      registered: 0,
      skippedNotArt: 0,
      skippedNotErc721: 0,
      skippedAlreadyTracked: 0,
      error: "opensea-robinhood-scan: no OpenSea API key available (OPENSEA_API_KEY env or managed key)",
    };
  }
  const rpcUrl = ROBINHOOD_RPC_URLS[0];
  if (!rpcUrl) {
    return {
      pagesScanned: 0,
      entriesSeen: 0,
      registered: 0,
      skippedNotArt: 0,
      skippedNotErc721: 0,
      skippedAlreadyTracked: 0,
      error: "opensea-robinhood-scan: no RPC URL configured (ROBINHOOD_RPC_URLS is empty)",
    };
  }

  let cursor: string | null = null;
  let pagesScanned = 0;
  let entriesSeen = 0;
  let registered = 0;
  let skippedNotArt = 0;
  let skippedNotErc721 = 0;
  let skippedAlreadyTracked = 0;

  try {
    for (let page = 0; page < maxPages; page++) {
      const result = await fetchCollectionsPage(apiKey, cursor);
      pagesScanned += 1;
      entriesSeen += result.collections.length;

      for (const entry of result.collections) {
        const contract = entry.contracts.find((c) => c.chain === "robinhood");
        if (!contract?.address) continue;
        const contractAddress = contract.address.toLowerCase();

        const { hasMultichainStore } = await import("@/lib/market/multichain/store");
        if (!hasMultichainStore()) continue;
        const { postgresQuery } = await import("@/lib/postgres");
        const existing = await postgresQuery<{ id: number }>(
          `SELECT id FROM plank_multichain_collections WHERE chain_slug = $1 AND contract_address = $2`,
          [CHAIN_SLUG, contractAddress]
        );
        if (existing.rows.length > 0) {
          skippedAlreadyTracked += 1;
          continue;
        }

        const verified = await verifyErc721(rpcUrl, contractAddress);
        if (!verified) {
          skippedNotErc721 += 1;
          continue;
        }

        const name = entry.name ?? verified.name;
        if (isNotRealCollectibleArt(name, entry.image_url)) {
          skippedNotArt += 1;
          continue;
        }

        await upsertTrackedCollection({
          chainSlug: CHAIN_SLUG,
          chainId: ROBINHOOD_CHAIN_ID,
          contractAddress,
          adapter: "robinhood-native",
        });
        await updateCollectionDisplay(CHAIN_SLUG, contractAddress, {
          name: name ?? null,
          imageUrl: entry.image_url ?? null,
        }).catch(() => {});
        registered += 1;
      }

      if (!result.next) break;
      cursor = result.next;
    }
  } catch (error) {
    return {
      pagesScanned,
      entriesSeen,
      registered,
      skippedNotArt,
      skippedNotErc721,
      skippedAlreadyTracked,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return { pagesScanned, entriesSeen, registered, skippedNotArt, skippedNotErc721, skippedAlreadyTracked };
}
