import { fetchNftMetadata, resolveIpfsUrl } from "@/lib/ipfs";
import {
  getCachedToken,
  hasFreshMetadata,
  putTokenMetadata,
  putTokenUri,
} from "@/lib/nft-cache";
import type { MarketCollection } from "@/lib/market/types";

/**
 * Token IDs a wallet owns in a collection, read straight from chain.
 *
 * Used to disable "Accept" on bids the connected wallet can't actually fill.
 * Without it, a user clicks Accept on someone's offer, signs, and the
 * transaction reverts — which reads as a broken marketplace rather than
 * "you don't own that one".
 */
export async function getOwnedTokenIds(
  contractAddress: string,
  owner: string
): Promise<Set<string>> {
  const owned = new Set<string>();
  try {
    const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

    const call = (data: string) => ethCall(contractAddress, data);

    const balHex = await call(`0x70a08231${pad(owner)}`); // balanceOf
    if (!balHex) return owned;
    const balance = Number(BigInt(balHex));
    if (!Number.isFinite(balance) || balance <= 0) return owned;

    // Cap the walk — a whale shouldn't stall the page.
    const limit = Math.min(balance, 200);
    const results = await Promise.all(
      Array.from({ length: limit }, (_, i) =>
        // tokenOfOwnerByIndex(address,uint256)
        call(`0x2f745c59${pad(owner)}${pad(BigInt(i).toString(16))}`)
      )
    );
    for (const r of results) {
      if (r && r !== "0x") owned.add(BigInt(r).toString());
    }
  } catch {
    // Fail open: an empty set only means we can't pre-disable buttons.
  }
  return owned;
}

export type OwnedNft = {
  collectionSlug: string;
  tokenId: string;
  name: string;
  /** Gateway-resolved artwork URL; empty string when resolution failed. */
  imageUrl: string;
};

export type OwnedInventory = {
  collection: MarketCollection;
  items: OwnedNft[];
};

/**
 * Same-origin RPC proxy (app/api/rpc), not CHAIN.rpcUrls.default directly —
 * the public RPC sends a malformed duplicate CORS header that a direct
 * client-side fetch() gets silently killed by (confirmed live: this whole
 * function was failing closed on every call, per the catch-and-return-null
 * below, which is why it read as merely "best effort" rather than broken).
 */
async function ethCall(to: string, data: string): Promise<string | null> {
  try {
    const res = await fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to, data }, "latest"],
      }),
    });
    const json = (await res.json()) as { result?: string };
    return json.result ?? null;
  } catch {
    return null;
  }
}

/** Decode a single ABI-encoded `string` return value. */
function decodeAbiString(hex: string | null): string | null {
  if (!hex || hex === "0x" || hex.length < 130) return null;
  try {
    const data = hex.slice(2);
    const len = Number(BigInt("0x" + data.slice(64, 128)));
    if (!Number.isFinite(len) || len <= 0 || len > 8_192) return null;
    const bytesHex = data.slice(128, 128 + len * 2);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      bytes[i] = parseInt(bytesHex.slice(i * 2, i * 2 + 2), 16);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Resolve one token's name + artwork, CACHE FIRST — NFT metadata is
 * immutable (lib/nft-cache.ts TTL_IMMUTABLE_MS), so a plank whose art we have
 * ever seen never hits the chain or IPFS again.
 */
async function resolveTokenArt(
  contractAddress: string,
  tokenId: string
): Promise<{ name: string; imageUrl: string }> {
  const id = Number(tokenId);
  const fallbackName = `#${tokenId}`;

  if (Number.isFinite(id) && hasFreshMetadata(id)) {
    const rec = getCachedToken(id);
    if (rec) {
      return {
        name: rec.name || fallbackName,
        imageUrl: rec.imageUri ? resolveIpfsUrl(rec.imageUri) : "",
      };
    }
  }

  try {
    // tokenURI(uint256)
    const idHex = BigInt(tokenId).toString(16).padStart(64, "0");
    let tokenUri = "";
    const cached = Number.isFinite(id) ? getCachedToken(id) : null;
    if (cached?.tokenUri) {
      tokenUri = cached.tokenUri; // tokenURI itself is immutable post-reveal
    } else {
      tokenUri = decodeAbiString(await ethCall(contractAddress, `0xc87b56dd${idHex}`)) ?? "";
      if (tokenUri && Number.isFinite(id)) putTokenUri(id, tokenUri);
    }
    if (!tokenUri) return { name: fallbackName, imageUrl: "" };

    const meta = await fetchNftMetadata(tokenUri); // cache-first internally
    if (Number.isFinite(id)) {
      putTokenMetadata(id, {
        tokenUri,
        name: meta.name || fallbackName,
        description: meta.description || "",
        imageUri: meta.image || "",
        attributes: meta.attributes || [],
      });
    }
    return {
      name: meta.name || fallbackName,
      imageUrl: meta.image ? resolveIpfsUrl(meta.image) : "",
    };
  } catch {
    // Art resolution failing must never hide an owned token — the card just
    // falls back to the collection image.
    return { name: fallbackName, imageUrl: "" };
  }
}

/**
 * Everything the wallet owns across the site's collections, with artwork —
 * powers the bulk-listing inventory browser. Builds on getOwnedTokenIds
 * (unchanged) per collection; art is resolved in small batches so a large
 * bag doesn't fire hundreds of parallel IPFS fetches.
 */
export async function getOwnedInventory(
  collections: MarketCollection[],
  owner: string
): Promise<OwnedInventory[]> {
  const out: OwnedInventory[] = [];
  for (const collection of collections) {
    const ids = Array.from(await getOwnedTokenIds(collection.contractAddress, owner)).sort(
      (a, b) => Number(a) - Number(b)
    );
    const items: OwnedNft[] = [];
    const BATCH = 10;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const resolved = await Promise.all(
        chunk.map((tokenId) => resolveTokenArt(collection.contractAddress, tokenId))
      );
      chunk.forEach((tokenId, j) => {
        items.push({
          collectionSlug: collection.slug,
          tokenId,
          name: resolved[j].name,
          imageUrl: resolved[j].imageUrl,
        });
      });
    }
    out.push({ collection, items });
  }
  return out;
}
