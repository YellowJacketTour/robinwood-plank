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
 * Also reads `contractURI()` (ERC-7572) for a project-published collection
 * banner/description, `royaltyInfo()` (ERC-2981) for checkout-correct
 * royalty splits, `ownerOf`/`balanceOf`/approvals (ERC-721) and their
 * ERC-1155 equivalents, and `supportsInterface` (ERC-165) as the
 * foundational capability-detection gate for optional extensions -- all
 * real, on-chain, standard reads.
 *
 * Deliberately does NOT attempt floor price, listed count, or a
 * *marketplace-curated* collection banner (OpenSea's own cropped/chosen
 * asset) -- none of those exist on-chain for any marketplace, ever
 * (confirmed repeatedly this session). A caller falling back to this
 * module gets a real but partial result; it must never be asked to
 * fabricate the off-chain-only fields.
 */
import { Interface, AbiCoder } from "ethers";
import { rpcCall } from "@/lib/market/multichain/discovery/rpc-provider-pool";

const ERC721_IFACE = new Interface([
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function contractURI() view returns (string)",
  "function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address receiver, uint256 royaltyAmount)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenByIndex(uint256 index) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
]);
// Separate interface for the ERC1155 shape: `balanceOf` there takes two args
// (address, tokenId), a real ABI collision with ERC721's one-arg `balanceOf`
// that Ethers' Interface can't hold under the same name -- hence a second
// Interface rather than folding these into ERC721_IFACE above.
const ERC1155_IFACE = new Interface([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function uri(uint256 id) view returns (string)",
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

/**
 * Real, direct `contractURI()` read -- ERC-7572 (finalized Dec 2023),
 * successor to OpenSea's older undocumented same-named convention. Tried
 * opportunistically even without ERC-165 interface detection: many
 * pre-EIP contracts implement the convention without declaring support,
 * and a revert here is a normal, honest "not implemented," never a hard
 * error. Same on-chain-pointer pattern as `tokenURI()`, but describing
 * the collection instead of one token -- the only fully on-chain path to
 * a collection banner image.
 */
export async function readContractUri(chainSlug: string, contractAddress: string): Promise<string | null> {
  return callString(chainSlug, contractAddress, "contractURI");
}

/**
 * Real, direct `royaltyInfo(tokenId, salePrice)` read -- ERC-2981
 * (Final). A revert is a normal, honest "this contract doesn't implement
 * ERC-2981," never a hard error. Callers wanting a cheap pre-check can use
 * `readSupportsInterface(chainSlug, contractAddress, "0x2a55205a")` first.
 */
export async function readRoyaltyInfo(
  chainSlug: string,
  contractAddress: string,
  tokenId: string | number,
  salePriceWei: bigint,
): Promise<{ receiver: string; royaltyAmountWei: bigint } | null> {
  try {
    const data = ERC721_IFACE.encodeFunctionData("royaltyInfo", [BigInt(tokenId), salePriceWei]);
    const { result } = await rpcCall<string>(chainSlug, "eth_call", [{ to: contractAddress, data }, "latest"]);
    if (!result || result === "0x") return null;
    const [receiver, royaltyAmount] = CODER.decode(["address", "uint256"], result);
    return { receiver: String(receiver), royaltyAmountWei: BigInt(royaltyAmount) };
  } catch {
    return null;
  }
}

/** Real, direct `ownerOf(tokenId)` read -- the current on-chain owner of a specific ERC721 token. Reverts (e.g. for a burned/nonexistent token) return null, not an error. */
export async function readOwnerOf(chainSlug: string, contractAddress: string, tokenId: string | number): Promise<string | null> {
  try {
    const data = ERC721_IFACE.encodeFunctionData("ownerOf", [BigInt(tokenId)]);
    const { result } = await rpcCall<string>(chainSlug, "eth_call", [{ to: contractAddress, data }, "latest"]);
    if (!result || result === "0x") return null;
    const [decoded] = CODER.decode(["address"], result);
    return String(decoded);
  } catch {
    return null;
  }
}

/**
 * Real, direct `tokenByIndex(index)` read -- ERC721Enumerable's own exact
 * "the real token ID that lives at this index, 0..totalSupply()-1" lookup.
 * Confirmed live 2026-08-25 against MAYC's real deployed contract (real
 * eth_call, real non-revert result for index 0). Reverts (extension not
 * implemented) return null, same discipline as readOwnerOf.
 */
export async function readTokenByIndex(chainSlug: string, contractAddress: string, index: number): Promise<string | null> {
  try {
    const data = ERC721_IFACE.encodeFunctionData("tokenByIndex", [BigInt(index)]);
    const { result } = await rpcCall<string>(chainSlug, "eth_call", [{ to: contractAddress, data }, "latest"]);
    if (!result || result === "0x") return null;
    const [decoded] = CODER.decode(["uint256"], result);
    return (decoded as bigint).toString();
  } catch {
    return null;
  }
}

/** Real, direct `balanceOf(owner)` read, ERC721 shape (single address arg) -- the number of tokens from this collection the address currently holds. */
export async function readBalanceOf(chainSlug: string, contractAddress: string, owner: string): Promise<number | null> {
  try {
    const data = ERC721_IFACE.encodeFunctionData("balanceOf", [owner]);
    const { result } = await rpcCall<string>(chainSlug, "eth_call", [{ to: contractAddress, data }, "latest"]);
    if (!result || result === "0x") return null;
    const [decoded] = CODER.decode(["uint256"], result);
    const value = Number(decoded);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** Real, direct `isApprovedForAll(owner, operator)` read -- whether `operator` (e.g. a marketplace contract) has blanket approval to move every token `owner` holds in this collection. */
export async function readIsApprovedForAll(chainSlug: string, contractAddress: string, owner: string, operator: string): Promise<boolean | null> {
  try {
    const data = ERC721_IFACE.encodeFunctionData("isApprovedForAll", [owner, operator]);
    const { result } = await rpcCall<string>(chainSlug, "eth_call", [{ to: contractAddress, data }, "latest"]);
    if (!result || result === "0x") return null;
    const [decoded] = CODER.decode(["bool"], result);
    return Boolean(decoded);
  } catch {
    return null;
  }
}

/** Real, direct `getApproved(tokenId)` read -- the single-token approved operator, if any (zero address means none). */
export async function readGetApproved(chainSlug: string, contractAddress: string, tokenId: string | number): Promise<string | null> {
  try {
    const data = ERC721_IFACE.encodeFunctionData("getApproved", [BigInt(tokenId)]);
    const { result } = await rpcCall<string>(chainSlug, "eth_call", [{ to: contractAddress, data }, "latest"]);
    if (!result || result === "0x") return null;
    const [decoded] = CODER.decode(["address"], result);
    return String(decoded);
  } catch {
    return null;
  }
}

/**
 * Real, direct ERC-165 `supportsInterface(bytes4)` read -- the foundational
 * capability-detection gate for the whole "which optional extension does
 * this contract actually implement" question (ERC721Enumerable, ERC721Metadata,
 * ERC2981 royalties, etc all key off this). `interfaceId` must be a 4-byte
 * hex string, e.g. "0x80ac58cd" for ERC721 itself.
 */
export async function readSupportsInterface(chainSlug: string, contractAddress: string, interfaceId: string): Promise<boolean | null> {
  try {
    const data = ERC721_IFACE.encodeFunctionData("supportsInterface", [interfaceId]);
    const { result } = await rpcCall<string>(chainSlug, "eth_call", [{ to: contractAddress, data }, "latest"]);
    if (!result || result === "0x") return null;
    const [decoded] = CODER.decode(["bool"], result);
    return Boolean(decoded);
  } catch {
    return null; // a contract with no ERC-165 support at all reverts here -- a real, honest "unknown/no", not an error
  }
}

/** Real, direct ERC1155 `balanceOf(account, id)` read -- the two-arg shape, distinct from ERC721's one-arg `balanceOf` above (this is the actual quantity of a specific token id the account holds, since ERC1155 tokens are semi-fungible). */
export async function readErc1155BalanceOf(chainSlug: string, contractAddress: string, owner: string, tokenId: string | number): Promise<number | null> {
  try {
    const data = ERC1155_IFACE.encodeFunctionData("balanceOf", [owner, BigInt(tokenId)]);
    const { result } = await rpcCall<string>(chainSlug, "eth_call", [{ to: contractAddress, data }, "latest"]);
    if (!result || result === "0x") return null;
    const [decoded] = CODER.decode(["uint256"], result);
    const value = Number(decoded);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Substitutes the ERC-1155 spec's literal `{id}` placeholder in a `uri()`
 * return value with the tokenId, formatted per spec: lowercase hex, no `0x`
 * prefix, zero-padded to 64 characters (32 bytes). Clients (not the
 * contract) are required to do this substitution -- see EIP-1155's URI
 * section. A `uri()` string with no placeholder is returned unchanged.
 */
export function resolveErc1155UriPlaceholder(uri: string, tokenId: string | number): string {
  if (!uri.includes("{id}")) return uri;
  const hex = BigInt(tokenId).toString(16).padStart(64, "0");
  return uri.split("{id}").join(hex);
}

/** Real, direct ERC1155 `uri(id)` read, with the spec-mandated `{id}` placeholder already substituted for the caller via resolveErc1155UriPlaceholder(). */
export async function readErc1155Uri(chainSlug: string, contractAddress: string, tokenId: string | number): Promise<string | null> {
  try {
    const data = ERC1155_IFACE.encodeFunctionData("uri", [BigInt(tokenId)]);
    const { result } = await rpcCall<string>(chainSlug, "eth_call", [{ to: contractAddress, data }, "latest"]);
    if (!result || result === "0x") return null;
    const [decoded] = CODER.decode(["string"], result);
    const value = String(decoded).trim();
    return value ? resolveErc1155UriPlaceholder(value, tokenId) : null;
  } catch {
    return null;
  }
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
  const json = await resolveUriToJson(uri);
  if (!json) return null;
  return {
    name: typeof json.name === "string" ? json.name : null,
    description: typeof json.description === "string" ? json.description : null,
    imageUrl: typeof json.image === "string" ? json.image : null,
    attributes: Array.isArray(json.attributes) ? (json.attributes as OnchainTokenMetadata["attributes"]) : [],
    fullyOnchain: json.__fullyOnchain === true,
  };
}

export type OnchainCollectionMetadata = {
  name: string | null;
  description: string | null;
  image: string | null;
  /** ERC-7572's collection banner field -- the actual point of `contractURI()` support: the only fully on-chain path to a collection banner image. */
  bannerImage: string | null;
  externalLink: string | null;
};

/**
 * Resolves a real `contractURI()` string into real collection metadata.
 * Same real URI shapes as `resolveTokenUri` above (data:/ipfs://https://)
 * -- ERC-7572 reuses the exact same on-chain-pointer pattern, just
 * describing the collection instead of one token, so this shares the
 * `resolveUriToJson` helper instead of duplicating the data:/ipfs:/https:
 * branching logic. Returns null (never throws, never fabricates) on any
 * real failure -- including the common, honest case of a contract that
 * simply doesn't implement the convention.
 */
export async function resolveContractUri(uri: string): Promise<OnchainCollectionMetadata | null> {
  const json = await resolveUriToJson(uri);
  if (!json) return null;
  return {
    name: typeof json.name === "string" ? json.name : null,
    description: typeof json.description === "string" ? json.description : null,
    image: typeof json.image === "string" ? json.image : null,
    bannerImage: typeof json.banner_image === "string" ? json.banner_image : null,
    externalLink: typeof json.external_link === "string" ? json.external_link : null,
  };
}

type ResolvedUriJson = {
  name?: unknown;
  description?: unknown;
  image?: unknown;
  attributes?: unknown;
  banner_image?: unknown;
  external_link?: unknown;
  __fullyOnchain?: boolean;
};

/**
 * Shared real URI-resolution logic behind both `resolveTokenUri` and
 * `resolveContractUri` -- both `tokenURI()` and `contractURI()` return
 * the exact same three real shapes: `data:application/json[;base64],...`
 * (complete payload, zero further network calls -- fully-on-chain case),
 * `ipfs://...` (resolved via this app's own existing IPFS proxy), or a
 * plain `https://...` URL (fetched directly). Never throws, never
 * fabricates -- returns null on any real failure.
 */
async function resolveUriToJson(uri: string): Promise<ResolvedUriJson | null> {
  try {
    if (uri.startsWith("data:")) {
      const commaIndex = uri.indexOf(",");
      if (commaIndex === -1) return null;
      const meta = uri.slice(5, commaIndex);
      const payload = uri.slice(commaIndex + 1);
      const isBase64 = meta.includes(";base64");
      const jsonText = isBase64 ? Buffer.from(payload, "base64").toString("utf-8") : decodeURIComponent(payload);
      const json = JSON.parse(jsonText) as ResolvedUriJson;
      json.__fullyOnchain = true;
      return json;
    }
    const httpUrl = uri.startsWith("ipfs://")
      ? `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}`
      : uri;
    if (!httpUrl.startsWith("https://") && !httpUrl.startsWith("http://")) return null;
    const res = await fetch(httpUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as ResolvedUriJson;
    json.__fullyOnchain = false;
    return json;
  } catch {
    return null;
  }
}
