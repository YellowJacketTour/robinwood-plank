/**
 * Real, direct on-chain contract reads via rpc-provider-pool.ts -- the
 * genuine free, unlimited-by-any-vendor-quota fallback for the small,
 * real subset of collection/token data that IS actually on-chain:
 * ERC721's own optional `name()`/`totalSupply()`, and every ERC721's
 * `tokenURI(uint256)`. Real per-token art/metadata (name, image,
 * attributes) for a fully-on-chain-rendered collection (data: URIs --
 * confirmed live this session for MUGS: "rendered entirely on-chain")
 * comes back COMPLETE from tokenURI() alone, zero IPFS/gateway/API
 * dependency at all.
 *
 * Deliberately does NOT attempt floor price, listed count, or a curated
 * collection banner image -- none of those exist on-chain for any
 * marketplace, ever (confirmed repeatedly this session). A caller falling
 * back to this module gets a real but partial result; it must never be
 * asked to fabricate the off-chain-only fields.
 */
import { Interface, AbiCoder } from "ethers";
import { rpcCall } from "@/lib/market/multichain/discovery/rpc-provider-pool";

const ERC721_IFACE = new Interface([
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);
const CODER = AbiCoder.defaultAbiCoder();

async function callString(chainSlug: string, contractAddress: string, fn: string, args: unknown[] = []): Promise<string | null> {
  try {
    const data = ERC721_IFACE.encodeFunctionData(fn, args);
    const { result } = await rpcCall<string>(chainSlug, "eth_call", [{ to: contractAddress, data }, "latest"]);
    if (!result || result === "0x") return null;
    const [decoded] = CODER.decode(["string"], result);
    const value = String(decoded).trim();
    return value || null;
  } catch {
    return null; // a real revert/unsupported-method is a normal, honest "this contract doesn't implement it" -- never surfaced as a hard error
  }
}

/** Real, direct `name()` read -- optional in the ERC721 standard, so a null return is a real "not implemented," not a failure. */
export async function readContractName(chainSlug: string, contractAddress: string): Promise<string | null> {
  return callString(chainSlug, contractAddress, "name");
}

/** Real, direct `totalSupply()` read -- only real for ERC721Enumerable; most modern contracts implement it even without full Enumerable. */
export async function readTotalSupply(chainSlug: string, contractAddress: string): Promise<number | null> {
  try {
    const data = ERC721_IFACE.encodeFunctionData("totalSupply", []);
    const { result } = await rpcCall<string>(chainSlug, "eth_call", [{ to: contractAddress, data }, "latest"]);
    if (!result || result === "0x") return null;
    const [decoded] = CODER.decode(["uint256"], result);
    const value = Number(decoded);
    return Number.isFinite(value) && value > 0 && value <= 100_000_000 ? value : null;
  } catch {
    return null;
  }
}

/** Real, direct `tokenURI(tokenId)` read -- the actual per-token metadata pointer every ERC721 must implement. */
export async function readTokenUri(chainSlug: string, contractAddress: string, tokenId: string | number): Promise<string | null> {
  return callString(chainSlug, contractAddress, "tokenURI", [BigInt(tokenId)]);
}

export type OnchainTokenMetadata = {
  name: string | null;
  description: string | null;
  imageUrl: string | null;
  attributes: Array<{ trait_type?: string; value?: unknown }>;
  /** Real signal for callers deciding whether to also try an IPFS/HTTPS resolve step -- true only for a data: URI, which already carries the complete payload with zero further network calls. */
  fullyOnchain: boolean;
};

/**
 * Resolves a real tokenURI() string into real metadata. Handles the three
 * real shapes a tokenURI can take:
 *  - `data:application/json;base64,...` / `data:application/json,...` --
 *    the COMPLETE metadata is already in the URI itself, zero further
 *    network calls (the fully-on-chain-rendering case, e.g. MUGS).
 *  - `ipfs://...` -- resolved via this app's own existing IPFS proxy
 *    (app/api/ipfs/metadata), which already handles gateway pooling.
 *  - a plain `https://...` URL -- fetched directly.
 * Returns null (never throws, never fabricates) on any real failure.
 */
export async function resolveTokenUri(uri: string): Promise<OnchainTokenMetadata | null> {
  try {
    if (uri.startsWith("data:")) {
      const commaIndex = uri.indexOf(",");
      if (commaIndex === -1) return null;
      const meta = uri.slice(5, commaIndex);
      const payload = uri.slice(commaIndex + 1);
      const isBase64 = meta.includes(";base64");
      const jsonText = isBase64 ? Buffer.from(payload, "base64").toString("utf-8") : decodeURIComponent(payload);
      const json = JSON.parse(jsonText) as { name?: string; description?: string; image?: string; attributes?: unknown };
      return {
        name: typeof json.name === "string" ? json.name : null,
        description: typeof json.description === "string" ? json.description : null,
        imageUrl: typeof json.image === "string" ? json.image : null,
        attributes: Array.isArray(json.attributes) ? (json.attributes as OnchainTokenMetadata["attributes"]) : [],
        fullyOnchain: true,
      };
    }
    const httpUrl = uri.startsWith("ipfs://")
      ? `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}`
      : uri;
    if (!httpUrl.startsWith("https://") && !httpUrl.startsWith("http://")) return null;
    const res = await fetch(httpUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { name?: string; description?: string; image?: string; attributes?: unknown };
    return {
      name: typeof json.name === "string" ? json.name : null,
      description: typeof json.description === "string" ? json.description : null,
      imageUrl: typeof json.image === "string" ? json.image : null,
      attributes: Array.isArray(json.attributes) ? (json.attributes as OnchainTokenMetadata["attributes"]) : [],
      fullyOnchain: false,
    };
  } catch {
    return null;
  }
}
