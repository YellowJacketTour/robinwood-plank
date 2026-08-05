import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { fetchNftMetadata, resolveIpfsUrl } from "@/lib/ipfs";
import { getOwnerFromIndex } from "@/lib/market/owner-index";
import { robinwoodTokenUri, resolveTokenImage } from "@/lib/market/token-image";
import { readChainActivity } from "@/lib/market/chain-events";
import { fetchTokenInstanceTransfers } from "@/lib/market/blockscout";
import { compactRarityFor, getRaritySnapshot } from "@/lib/market/rarity-snapshot";
import { cachedPublicJson } from "@/lib/http-cache";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Fixed supply of the collection, confirmed on-chain during the audit. */
const MAX_TOKEN_ID = 1542;

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; payload: unknown }>();

/**
 * Owner for display, from the collection-wide index rather than a per-token
 * ownerOf.
 *
 * This route is the app's largest source of DISTINCT provider reads: every
 * visitor opens different tokens, so each view was its own uncacheable 26 CU
 * eth_call and the egress cache could never collapse them. The index answers
 * all 1,542 tokens from one aggregator walk instead — see
 * lib/market/owner-index.ts.
 *
 * Display only. This value is never used to authorize anything; order
 * validation reads ownerOf on the authoritative RPC path (see
 * app/api/market/orders/route.ts).
 */
async function readOwner(tokenId: string): Promise<string | null> {
  try {
    return await getOwnerFromIndex(tokenId, NFT_CONTRACT_ADDRESS);
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
    // Canonical store first. This route is the per-item view: every visitor
    // opens a different token, so nothing collapses these into a shared cache,
    // and traits are immutable data we already hold in Postgres. Reaching out
    // to an IPFS gateway per request to re-learn them is work we stopped
    // needing to do.
    try {
      const { getRobinwoodMetadataMap } = await import("@/lib/market/robinwood-metadata");
      const stored = (await getRobinwoodMetadataMap()).get(Number(tokenId));
      if (stored) {
        attributes = stored.attributes ?? [];
        if (!image && stored.imageUri) image = resolveIpfsUrl(stored.imageUri);
      }
    } catch {
      /* fall through to IPFS */
    }

    // Fallback, unchanged: a token missing from the store must still render.
    // Metadata comes from IPFS and may be slow or missing; the token is still
    // real without it, so a failure degrades to "no traits" rather than a 500.
    if (attributes.length === 0) {
      try {
        const metadata = await fetchNftMetadata(robinwoodTokenUri(tokenId));
        attributes = metadata.attributes ?? [];
        if (!image && metadata.image) {
          image = resolveIpfsUrl(metadata.image);
        }
      } catch {
        attributes = [];
      }
    }

    // History is optional. Item detail passes history=1; fence/image callers
    // skip it for a fast art resolve.
    let history: unknown[] = [];
    if (wantHistory) {
      // Ask for THIS token's transfers directly. Filtering a collection-wide
      // recent-activity scan (what this did before) only ever saw what had
      // moved lately — so a plank that hadn't traded since it was minted showed
      // "No transfers recorded", and one that had moved recently showed that
      // move with its mint missing. Measured 2026-08-02: #1533 and #1542 each
      // have exactly one real transfer (their mint) and rendered as empty.
      try {
        const transfers = await fetchTokenInstanceTransfers(NFT_CONTRACT_ADDRESS, tokenId);
        history = transfers.slice(0, 12).map((t) => ({
          // A mint comes from the zero address; Blockscout labels the call that
          // produced it (publicMint / freeMint / allowlistMint), which is more
          // detail than the panel needs.
          kind: /^0x0{40}$/i.test(t.from?.hash ?? "") ? "mint" : t.method || "transfer",
          // This endpoint carries no price. Sales still show their price in the
          // Activity feed, which prices fills from the marketplace method.
          priceEth: null,
          txHash: t.transaction_hash ?? "",
          timestamp: t.timestamp ?? null,
          from: t.from?.hash ?? "",
          to: t.to?.hash ?? "",
        }));
      } catch {
        // Blockscout rate-limits hard. Fall back to the permanent ledger
        // (migration 008_chain_events.sql) rather than showing nothing —
        // partial history beats none. Reads this token's real, complete
        // history, not a capped recent-events window like the old fallback.
        try {
          const page = await readChainActivity({
            limit: 12,
            offset: 0,
            tokenId,
            source: "nft",
          });
          history = page.events;
        } catch {
          history = [];
        }
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
