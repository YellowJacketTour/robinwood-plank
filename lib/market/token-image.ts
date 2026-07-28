import { CHAIN } from "@/lib/constants";
import { fetchNftMetadata, resolveIpfsUrl } from "@/lib/ipfs";

/**
 * Resolve a token's own artwork (tokenURI -> metadata -> image), server-side.
 *
 * Extracted from app/api/market/orders/route.ts so every caller (listings,
 * activity feed, item detail) shares one implementation rather than each
 * re-deriving the tokenURI ABI decode independently. Returns undefined on
 * any failure; callers fall back to the collection image rather than
 * showing a broken one.
 */
export async function resolveTokenImage(
  contractAddress: string,
  tokenId: string
): Promise<string | undefined> {
  try {
    const idHex = BigInt(tokenId).toString(16).padStart(64, "0");
    const res = await fetch(CHAIN.rpcUrls.default, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: contractAddress, data: `0xc87b56dd${idHex}` }, "latest"], // tokenURI
      }),
      cache: "no-store",
    });
    const data = (await res.json()) as { result?: string };
    if (!data.result || data.result.length < 130) return undefined;

    const hex = data.result.slice(2);
    const len = parseInt(hex.slice(64, 128), 16);
    if (!Number.isFinite(len) || len <= 0) return undefined;
    const tokenUri = Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString("utf8");
    if (!tokenUri) return undefined;

    const metadata = await fetchNftMetadata(tokenUri);
    const image = metadata?.image;
    return typeof image === "string" && image ? resolveIpfsUrl(image) : undefined;
  } catch {
    return undefined;
  }
}
