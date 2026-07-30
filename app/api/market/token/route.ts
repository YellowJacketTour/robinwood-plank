import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { fetchNftMetadata, resolveIpfsUrl } from "@/lib/ipfs";
import { ethCall } from "@/lib/market/fetch-rpc";
import { robinwoodTokenUri, resolveTokenImage } from "@/lib/market/token-image";
import { fetchActivity } from "@/lib/market/activity";
import { compactRarityFor, getRaritySnapshot } from "@/lib/market/rarity-snapshot";
import { cachedPublicJson } from "@/lib/http-cache";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Fixed supply of the collection, confirmed on-chain during the audit. */
const MAX_TOKEN_ID = 1542;

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; payload: unknown }>();

async function readOwner(tokenId: string): Promise<string | null> {
  try {
    const idHex = BigInt(tokenId).toString(16).padStart(64, "0");
    // ownerOf(uint256) selector 0x6352211e
    const result = await ethCall(NFT_CONTRACT_ADDRESS, `0x6352211e${idHex}`);
    if (!result || result.length < 66) return null;
    return `0x${result.slice(-40)}`;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-token", limit: 120, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("tokenId") ?? "";

  // Reject anything that is not a plain decimal id in range, before it reaches
  // an RPC or a gateway. Fails closed on every malformed input.
  if (!/^\d{1,5}$/.test(raw)) {
    return publicJson({ error: "BAD_TOKEN", message: "Invalid token id." }, 400);
  }
  const tokenId = String(Number(raw));
  if (Number(tokenId) < 1 || Number(tokenId) > MAX_TOKEN_ID) {
    return publicJson({ error: "BAD_TOKEN", message: "Unknown token." }, 404);
  }

  // Cache key must include the history flag: a history-less fetch (fence /
  // art callers) caching {history: []} was poisoning history=1 callers
  // (item detail, gallery modal) with an empty history for CACHE_MS.
  const wantHistory = searchParams.get("history") === "1";
  const cacheKey = `${tokenId}|h${wantHistory ? 1 : 0}`;

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return cachedPublicJson(hit.payload, "token");
  }

  try {
    // Prefer known metadata CID + pinata (Workers-safe). ownerOf is optional.
    const [owner, imageResolved] = await Promise.all([
      readOwner(tokenId),
      resolveTokenImage(NFT_CONTRACT_ADDRESS, tokenId),
    ]);

    // Metadata comes from IPFS and may be slow or missing; the token is still
    // real without it, so a failure degrades to "no traits" rather than a 500.
    let attributes: Array<{ trait_type?: string; value?: string | number | boolean }> = [];
    let image: string | null = imageResolved ?? null;
    try {
      const metadata = await fetchNftMetadata(robinwoodTokenUri(tokenId));
      attributes = metadata.attributes ?? [];
      if (!image && metadata.image) {
        image = resolveIpfsUrl(metadata.image);
      }
    } catch {
      attributes = [];
    }

    // History is optional and expensive (collection log walk). Item detail
    // can pass history=1; fence/image callers skip it for fast art resolve.
    let history: unknown[] = [];
    if (wantHistory) {
      try {
        const all = await fetchActivity(200);
        history = all.filter((e) => e.tokenId === tokenId).slice(0, 12);
      } catch {
        history = [];
      }
    }

    // Rarity is a nice-to-have on top of a real token, not a precondition for
    // showing one — a snapshot failure degrades to "no rarity shown", same
    // pattern as metadata/history above.
    let rarity = null;
    try {
      const snapshot = await getRaritySnapshot();
      rarity = compactRarityFor(snapshot, Number(tokenId));
    } catch {
      rarity = null;
    }

    const payload = { tokenId, owner, image, attributes, history, rarity };

    // A transient upstream blip (RPC ownerOf, rarity snapshot, IPFS
    // metadata) soft-fails fields to null/empty above. Never let such a
    // degraded payload into the server cache or shared/browser caches —
    // one blip was pinning hollow item modals (no name/rank/traits/owner)
    // for the full cache lifetime. Serve last-known-good instead when we
    // have it; otherwise return the degraded payload uncached.
    const degraded = owner === null || rarity === null || attributes.length === 0;
    if (!degraded) {
      cache.set(cacheKey, { at: Date.now(), payload });
      return cachedPublicJson(payload, "token");
    }
    const lastGood = cache.get(cacheKey);
    if (lastGood) return cachedPublicJson(lastGood.payload, "token");
    return publicJson(payload, 200);
  } catch (error) {
    const hit2 = cache.get(cacheKey);
    if (hit2) return cachedPublicJson(hit2.payload, "token");
    return publicError(error, "Could not load this item.");
  }
}
