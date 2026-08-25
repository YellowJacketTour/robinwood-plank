import { fetchNftMetadata, resolveIpfsUrl } from "@/lib/ipfs";
import { rpcCall } from "@/lib/market/multichain/discovery/evm-log-scan";

const TOKEN_URI = "0xc87b56dd";
const ERC1155_URI = "0x0e89341c";

export type ResolvedEvmTokenMetadata = {
  name: string | null;
  imageUrl: string | null;
  animationUrl: string | null;
  mediaType: string | null;
  traits: Array<{ traitType: string; value: string }>;
};

function uint256(value: string): string {
  const parsed = BigInt(value);
  if (parsed < 0n) throw new Error("negative token id");
  return parsed.toString(16).padStart(64, "0");
}

function decodeAbiString(hex: string): string | null {
  if (!/^0x[0-9a-f]*$/i.test(hex) || hex.length < 130) return null;
  try {
    const offset = Number(BigInt(`0x${hex.slice(2, 66)}`));
    const lengthAt = 2 + offset * 2;
    const length = Number(BigInt(`0x${hex.slice(lengthAt, lengthAt + 64)}`));
    if (!Number.isSafeInteger(length) || length < 1 || length > 1_000_000) return null;
    return Buffer.from(hex.slice(lengthAt + 64, lengthAt + 64 + length * 2), "hex")
      .toString("utf8").replace(/\0/g, "").trim() || null;
  } catch { return null; }
}

async function readUri(rpcUrls: string[], contractAddress: string, tokenId: string): Promise<string | null> {
  const arg = uint256(tokenId);
  let lastError: unknown;
  for (const url of rpcUrls) {
    for (const selector of [TOKEN_URI, ERC1155_URI]) {
      try {
        const raw = await rpcCall<string>(url, "eth_call", [
          { to: contractAddress, data: `${selector}${arg}` }, "latest",
        ]);
        const decoded = decodeAbiString(raw);
        if (decoded) return selector === ERC1155_URI
          ? decoded.replace(/\{id\}/gi, arg.toLowerCase()) : decoded;
      } catch (error) { lastError = error; }
    }
  }
  if (lastError) throw lastError;
  return null;
}

export async function resolveEvmTokenMetadata(input: {
  rpcUrls: string[]; contractAddress: string; tokenId: string;
}): Promise<ResolvedEvmTokenMetadata | null> {
  const uri = await readUri(input.rpcUrls, input.contractAddress, input.tokenId);
  if (!uri) return null;
  const metadata = await fetchNftMetadata(uri);
  const traits = (metadata.attributes ?? []).flatMap((attribute) => {
    const traitType = typeof attribute.trait_type === "string" ? attribute.trait_type.trim() : "";
    const value = attribute.value;
    return traitType && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      ? [{ traitType, value: String(value) }] : [];
  });
  const image = typeof metadata.image === "string" ? metadata.image.trim() : "";
  const animation = typeof (metadata.animation_url ?? metadata.animationUrl) === "string"
    ? (metadata.animation_url ?? metadata.animationUrl)!.trim() : "";
  const name = typeof metadata.name === "string" ? metadata.name.trim() : "";
  return { name: name || null, imageUrl: image ? resolveIpfsUrl(image) : null,
    animationUrl: animation || null, mediaType: metadata.media_type?.trim() || null, traits };
}

/** Provider enrichment fallback for contracts whose metadata is not exposed
 * through standard tokenURI/uri reads. This is one token per bounded worker
 * item, never visitor traffic. */
export async function resolveOpenSeaTokenMetadata(input: {
  apiKey: string; openSeaChain: string; contractAddress: string; tokenId: string;
}): Promise<ResolvedEvmTokenMetadata | null> {
  const url = `https://api.opensea.io/api/v2/chain/${input.openSeaChain}/contract/${input.contractAddress}/nfts/${encodeURIComponent(input.tokenId)}`;
  const response = await fetch(url, { headers: { "x-api-key": input.apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`OpenSea ${response.status} enriching token ${input.tokenId}`);
  const body = await response.json() as { nft?: { name?: string | null; image_url?: string | null;
    display_image_url?: string | null; animation_url?: string | null; metadata_url?: string | null;
    traits?: Array<{ trait_type?: string | null; value?: unknown }> } };
  const nft = body.nft;
  if (!nft) return null;
  const traits = (nft.traits ?? []).flatMap((trait) => {
    const traitType = typeof trait.trait_type === "string" ? trait.trait_type.trim() : "";
    const value = trait.value;
    return traitType && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      ? [{ traitType, value: String(value) }] : [];
  });
  const image = nft.display_image_url || nft.image_url || null;
  return { name: nft.name?.trim() || null, imageUrl: image,
    animationUrl: nft.animation_url?.trim() || null, mediaType: null, traits };
}
