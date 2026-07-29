import { fetchNftMetadata, resolveIpfsUrl } from "@/lib/ipfs";
import { ethCall } from "@/lib/market/fetch-rpc";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";

/**
 * RobinWood collection metadata directory (tokenURI base). Every minted
 * token uses `ipfs://{cid}/{tokenId}` — confirmed on-chain for ids across
 * the supply. Hitting this first skips eth_call entirely, which is what
 * was starving vault-held art enrich on Cloudflare (RPC 429 + Worker
 * subrequest budget while Blockscout still served pre-reveal stubs).
 */
export const ROBINWOOD_METADATA_CID =
  "bafybeictcaptbfswgepv2icnuw5wdhfjvvamwlcoza2p4qw3zbq2hqd6b4";

export function robinwoodTokenUri(tokenId: string | number): string {
  return `ipfs://${ROBINWOOD_METADATA_CID}/${tokenId}`;
}

async function imageFromTokenUri(tokenUri: string): Promise<string | undefined> {
  const metadata = await fetchNftMetadata(tokenUri);
  const image = metadata?.image;
  return typeof image === "string" && image ? resolveIpfsUrl(image) : undefined;
}

/**
 * Resolve a token's artwork (tokenURI -> metadata -> image), server-side.
 * Prefers the known collection metadata CID (no RPC). Falls back to eth_call
 * tokenURI for non-RobinWood contracts or if the directory ever migrates.
 */
export async function resolveTokenImage(
  contractAddress: string,
  tokenId: string
): Promise<string | undefined> {
  const to = (contractAddress || NFT_CONTRACT_ADDRESS).toLowerCase();
  const isRobinWood = to === NFT_CONTRACT_ADDRESS.toLowerCase();

  if (isRobinWood) {
    try {
      const img = await imageFromTokenUri(robinwoodTokenUri(tokenId));
      if (img) return img;
    } catch {
      /* fall through to on-chain tokenURI */
    }
  }

  try {
    const idHex = BigInt(tokenId).toString(16).padStart(64, "0");
    // tokenURI(uint256) selector 0xc87b56dd
    const result = await ethCall(to, `0xc87b56dd${idHex}`);
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
