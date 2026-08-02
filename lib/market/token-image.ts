import { fetchNftMetadata, resolveIpfsUrl } from "@/lib/ipfs";
import { ethCallDisplay } from "@/lib/market/fetch-rpc";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { robinwoodTokenUri } from "@/lib/market/robinwood-uri";

// Re-exported for existing server-side importers. The definitions live in
// robinwood-uri.ts because this module is NOT client-safe — it reaches the
// canonical metadata table, and therefore `pg`. See that file's header.
export { ROBINWOOD_METADATA_CID, robinwoodTokenUri } from "@/lib/market/robinwood-uri";

async function imageFromTokenUri(tokenUri: string): Promise<string | undefined> {
  const metadata = await fetchNftMetadata(tokenUri);
  const image = metadata?.image;
  return typeof image === "string" && image ? resolveIpfsUrl(image) : undefined;
}

/**
 * Resolve a token's artwork (tokenURI -> metadata -> image), server-side.
 * For RobinWood, checks the canonical IPFS-sourced metadata store
 * (lib/market/robinwood-metadata.ts) first — that's data we already hold in
 * Postgres, so a hit costs one in-memory map lookup instead of a per-request
 * IPFS/gateway round-trip. A miss (token not yet backfilled, or the store
 * unconfigured) falls through to the existing per-request IPFS path below,
 * unchanged — a token missing from the canonical store must still resolve,
 * just slower. Falls back further to eth_call tokenURI for non-RobinWood
 * contracts or if the directory ever migrates.
 *
 * Dynamic import (not a static one) for the canonical-store lookup:
 * robinwood-metadata.ts imports ROBINWOOD_METADATA_CID/robinwoodTokenUri
 * from THIS module, so a static import here would be a circular import.
 */
export async function resolveTokenImage(
  contractAddress: string,
  tokenId: string
): Promise<string | undefined> {
  const to = (contractAddress || NFT_CONTRACT_ADDRESS).toLowerCase();
  const isRobinWood = to === NFT_CONTRACT_ADDRESS.toLowerCase();

  if (isRobinWood) {
    try {
      const idNum = Number(tokenId);
      if (Number.isFinite(idNum)) {
        const { getRobinwoodMetadataMap } = await import("@/lib/market/robinwood-metadata");
        const entry = (await getRobinwoodMetadataMap()).get(idNum);
        if (entry?.imageUri) return resolveIpfsUrl(entry.imageUri);
      }
    } catch {
      /* canonical store unavailable — fall through to the IPFS path below */
    }

    try {
      const img = await imageFromTokenUri(robinwoodTokenUri(tokenId));
      if (img) return img;
    } catch {
      /* fall through to on-chain tokenURI */
    }
  }

  try {
    const idHex = BigInt(tokenId).toString(16).padStart(64, "0");
    // tokenURI(uint256) selector 0xc87b56dd. Artwork resolution is a pure
    // display read (never gates a decision), so it uses the public-first list.
    const result = await ethCallDisplay(to, `0xc87b56dd${idHex}`);
    if (!result || result.length < 130) return undefined;

    const hex = result.slice(2);
    const len = parseInt(hex.slice(64, 128), 16);
    if (!Number.isFinite(len) || len <= 0) return undefined;
    const tokenUri = Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString("utf8");
    if (!tokenUri) return undefined;

    return await imageFromTokenUri(tokenUri);
  } catch {
    return undefined;
  }
}
