/**
 * "Stage B" chain-wide collection discovery for Robinhood Chain (4663)
 * itself -- the home chain, not one of the 7 foreign chains. Every other
 * chain this app tracks discovers new collections via evm-log-scan.ts +
 * Alchemy's getContractMetadata for validation; that path does NOT work
 * here, because Robinhood Chain is a private/custom Arbitrum Orbit L3
 * (chainId 4663) that Alchemy's NFT API has no listing for -- confirmed by
 * this app's own existing ALCHEMY_NETWORK_SUBDOMAIN map (alchemy-nft.ts)
 * never including it. OpenSea doesn't index it either. So this module
 * validates candidates by calling the ERC-721 interface DIRECTLY against
 * Robinhood Chain's own RPC (name/symbol/supportsInterface/tokenURI),
 * rather than trusting a third-party indexer's opinion of what's real.
 *
 * WHY THIS WAS NEVER BUILT BEFORE NOW
 * ---------------------------------------------------------------------------
 * lib/market/collections.ts's own header calls broad, chain-wide discovery
 * "Stage B (chain-wide permissionless), its own scoped project" -- Stage A
 * was a hand-curated single-collection allowlist (just RobinWood). This is
 * that Stage B project, generalized from the exact Transfer-log-scanning
 * technique lib/market/chain-indexer.ts already runs in production for
 * Robinhood Chain (there, address-filtered to ONE known contract; here,
 * unfiltered, exactly the same generalization evm-log-scan.ts already did
 * for the 7 foreign EVM chains -- see that file's own header).
 *
 * REGISTERED INTO THE SAME plank_multichain_collections TABLE, WITH A REAL
 * CAVEAT: rows here get chainSlug "robinhood" and ARE genuinely tradeable
 * via the native Seaport deployment (lib/market/seaport.ts,
 * SEAPORT_ADDRESS -- the exact same canonical address every foreign chain
 * uses) -- more so than a foreign-chain row, not less, since there's no
 * cross-chain bridge latency involved. But the GLOBAL MARKET UI's own
 * `tradeable` flag (app/api/market/multichain/route.ts) is currently
 * computed via foreignChainByChainSlug(), which returns null for
 * "robinhood" BY DESIGN (foreign-chain-registry.ts deliberately excludes
 * the home chain from FOREIGN_CHAINS). That means a newly-discovered
 * Robinhood Chain collection will show up as "browse only" in the hub
 * today even though it's actually the MOST tradeable kind of row --
 * wiring the buy/sweep/offer UI to call the native Seaport flow
 * (lib/market/seaport.ts) for a non-RobinWood Robinhood Chain collection
 * is real, separate follow-up work to the core native marketplace (which
 * is currently hardcoded to the single NFT_CONTRACT_ADDRESS collection in
 * lib/market/collections.ts), not a multichain-module change. This file's
 * job is discovery and honest storage only.
 */
import { postgresQuery } from "@/lib/postgres";
import { upsertTrackedCollection, recordActivity, updateCollectionDisplay } from "@/lib/market/multichain/store";
import { ROBINHOOD_RPC_URLS, ROBINHOOD_CHAIN_ID } from "@/lib/mint-contract";
import { TRANSFER_TOPIC, isNotRealCollectibleArt, rpcCall, readCursor, writeCursor } from "@/lib/market/multichain/discovery/evm-log-scan";

const CHAIN_SLUG = "robinhood";
const CHUNK_BLOCKS = 10;
const MIN_TRANSFERS_TO_CONSIDER = 2;

type RawLog = { address: string; topics: string[]; blockNumber: string };

/** ERC-165 interface ID for ERC-721, per the standard -- the one reliable, on-chain-verifiable signal that a contract is genuinely an NFT collection, needing no third-party indexer's opinion. */
const ERC721_INTERFACE_ID = "0x80ac58cd";

function encodeCall(selector: string, argsHex = ""): string {
  return selector + argsHex;
}

/** Best-effort raw ERC-721 read: supportsInterface, name, symbol. Returns null on ANY failure -- a contract that doesn't cleanly answer these isn't treated as a real collection, fail-closed exactly like every other discovery path in this app. */
async function readErc721Metadata(rpcUrl: string, contractAddress: string): Promise<{ name: string | null; symbol: string | null } | null> {
  try {
    const supportsErc721 = (await rpcCall<string>(rpcUrl, "eth_call", [
      // bytes4 is RIGHT-padded in ABI encoding (padEnd), not left-padded --
      // this was a real, confirmed-live bug: the left-padded (padStart)
      // version of this exact supportsInterface(0x80ac58cd) call reverted
      // against a real Robinhood-Chain ERC-721 contract (curl-verified
      // 2026-08-18 directly against https://rpc.mainnet.chain.robinhood.com),
      // meaning THIS function had been rejecting every genuinely real
      // ERC-721 candidate it ever checked -- readErc721Metadata always
      // returned null, so runRobinhoodChainDiscoveryScan could only ever
      // have registered zero collections via on-chain verification. Fixed
      // here; discoverer opensea-robinhood-scan.ts carries the same fix.
      { to: contractAddress, data: encodeCall("0x01ffc9a7", ERC721_INTERFACE_ID.slice(2).padEnd(64, "0")) },
      "latest",
    ])) as string;
    // A revert or a false (32-byte zero) response means "not ERC-721" -- both fail closed.
    if (!supportsErc721 || supportsErc721 === "0x" || BigInt(supportsErc721) === 0n) return null;

    const [nameHex, symbolHex] = await Promise.all([
      rpcCall<string>(rpcUrl, "eth_call", [{ to: contractAddress, data: "0x06fdde03" }, "latest"]).catch(() => null),
      rpcCall<string>(rpcUrl, "eth_call", [{ to: contractAddress, data: "0x95d89b41" }, "latest"]).catch(() => null),
    ]);
    return { name: decodeAbiString(nameHex), symbol: decodeAbiString(symbolHex) };
  } catch {
    return null;
  }
}

/** Minimal ABI-encoded-string decoder for a standard name()/symbol() return (offset + length + utf8 bytes) -- no ethers dependency needed for two field reads. */
function decodeAbiString(hex: string | null): string | null {
  if (!hex || hex === "0x" || hex.length < 130) return null;
  try {
    const lengthHex = hex.slice(66, 130);
    const length = parseInt(lengthHex, 16);
    if (!Number.isFinite(length) || length <= 0 || length > 200) return null;
    const dataHex = hex.slice(130, 130 + length * 2);
    const bytes = Buffer.from(dataHex, "hex");
    const decoded = bytes.toString("utf8").replace(/\0/g, "").trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/** Resolves a tokenId's tokenURI and, best-effort, its image -- handles ipfs://, data:, and plain HTTP(S) URIs, the three real shapes this app has encountered across every other adapter. Returns nulls rather than throwing on any failure (metadata gateways are flaky by nature). */
async function resolveTokenImage(rpcUrl: string, contractAddress: string, tokenId: bigint): Promise<{ name: string | null; imageUrl: string | null }> {
  try {
    const tokenIdHex = tokenId.toString(16).padStart(64, "0");
    const uriHex = await rpcCall<string>(rpcUrl, "eth_call", [{ to: contractAddress, data: "0xc87b56dd" + tokenIdHex }, "latest"]);
    const rawUri = decodeAbiString(uriHex);
    if (!rawUri) return { name: null, imageUrl: null };

    let metadataUrl = rawUri;
    if (rawUri.startsWith("ipfs://")) metadataUrl = `https://ipfs.io/ipfs/${rawUri.slice("ipfs://".length)}`;

    if (metadataUrl.startsWith("data:application/json")) {
      const commaIdx = metadataUrl.indexOf(",");
      const payload = metadataUrl.slice(commaIdx + 1);
      const json = metadataUrl.includes("base64") ? JSON.parse(Buffer.from(payload, "base64").toString("utf8")) : JSON.parse(decodeURIComponent(payload));
      return { name: json.name ?? null, imageUrl: resolveImageField(json.image) };
    }

    const res = await fetch(metadataUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { name: null, imageUrl: null };
    const json = (await res.json()) as { name?: string; image?: string };
    return { name: json.name ?? null, imageUrl: resolveImageField(json.image) };
  } catch {
    return { name: null, imageUrl: null };
  }
}

function resolveImageField(image: string | undefined): string | null {
  if (!image) return null;
  if (image.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${image.slice("ipfs://".length)}`;
  return image;
}

export type RobinhoodDiscoveryResult = {
  fromBlock: number;
  toBlock: number;
  candidatesSeen: number;
  registered: number;
  skippedNotArt: number;
};

/**
 * One scan window (CHUNK_BLOCKS, same conservative free-RPC-tier size
 * every other discovery path in this app uses), unfiltered by address,
 * tallying real ERC-721 Transfer activity and registering genuine
 * collections. Meant to be called on the same cron cadence as
 * runAllEvmDiscoveryScans (scripts/refresh-market-data.ts).
 */
export async function runRobinhoodChainDiscoveryScan(): Promise<RobinhoodDiscoveryResult> {
  const rpcUrl = ROBINHOOD_RPC_URLS[0];
  if (!rpcUrl) throw new Error("robinhood-chain-scan: no RPC URL configured (ROBINHOOD_RPC_URLS is empty)");

  const latestHex = await rpcCall<string>(rpcUrl, "eth_blockNumber", []);
  const latest = parseInt(latestHex, 16);

  const cursor = await readCursor(CHAIN_SLUG);
  const fromBlock = cursor !== null ? cursor + 1 : Math.max(0, latest - CHUNK_BLOCKS);
  const toBlock = Math.min(fromBlock + CHUNK_BLOCKS - 1, latest);
  if (fromBlock > toBlock) {
    return { fromBlock, toBlock: fromBlock - 1, candidatesSeen: 0, registered: 0, skippedNotArt: 0 };
  }

  const logs = await rpcCall<RawLog[]>(rpcUrl, "eth_getLogs", [
    {
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      topics: [TRANSFER_TOPIC],
    },
  ]);

  const transferCounts = new Map<string, number>();
  for (const log of logs) {
    if (log.topics.length !== 4) continue; // ERC-20 Transfer shares the same topic0 but only 3 topics -- excluded exactly like evm-log-scan.ts's own filter.
    const addr = log.address.toLowerCase();
    transferCounts.set(addr, (transferCounts.get(addr) ?? 0) + 1);
  }

  let registered = 0;
  let skippedNotArt = 0;
  for (const [contractAddress, count] of transferCounts) {
    if (count < MIN_TRANSFERS_TO_CONSIDER) continue;

    const meta = await readErc721Metadata(rpcUrl, contractAddress);
    if (!meta) continue; // fails ERC-721 interface check -- not a collection, real signal, not a heuristic.

    const existing = await postgresQuery<{ id: number }>(
      `SELECT id FROM plank_multichain_collections WHERE chain_slug = $1 AND contract_address = $2`,
      [CHAIN_SLUG, contractAddress]
    );
    if (existing.rows.length > 0) {
      await recordActivity(CHAIN_SLUG, new Map([[contractAddress, count]])).catch(() => {});
      continue;
    }

    // Sample token 1 for art -- same "one lookup proves the collection has
    // real per-token art" pattern rarity-index-runner.ts uses, cheap
    // because it's a single extra RPC round-trip only for genuinely new
    // candidates, never on every tick.
    const sample = await resolveTokenImage(rpcUrl, contractAddress, 1n);
    if (isNotRealCollectibleArt(meta.name, sample.imageUrl)) {
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
      name: sample.name ?? meta.name ?? null,
      imageUrl: sample.imageUrl ?? null,
    }).catch(() => {});
    await recordActivity(CHAIN_SLUG, new Map([[contractAddress, count]])).catch(() => {});
    registered += 1;
  }

  await writeCursor(CHAIN_SLUG, toBlock);
  return { fromBlock, toBlock, candidatesSeen: transferCounts.size, registered, skippedNotArt };
}
