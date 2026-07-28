import { NextResponse } from "next/server";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { getVaultHeldTokenIds } from "@/lib/market/vault-held";
import { resolveTokenImage } from "@/lib/market/token-image";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Cap how many images this route resolves per request — the vault could
 * hold hundreds of tokens; the picker only needs enough to fill a grid, not
 * the full set, and every extra id is an IPFS round trip. */
const MAX_PREVIEWED = 60;

/** This route had NO cache at all — every single call re-walked the
 * Transfer-log replay AND re-resolved up to MAX_PREVIEWED images via IPFS,
 * on top of publicJson forcing Cache-Control: no-store so the browser/CDN
 * couldn't help either. Vault membership changes rarely (deposits/redeems),
 * so a short cache here is nearly free correctness-wise and a large real
 * win for the "images load slowly on refresh" complaint. */
let cache: { at: number; data: unknown } | null = null;
const CACHE_MS = 20_000;

function cachedPublicJson(data: unknown): NextResponse {
  return NextResponse.json(data, {
    headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=120" },
  });
}

/**
 * Visual token picker for Redeem — "which specific Plank am I taking out" —
 * needs real artwork, not a bare id typed blind. See lib/market/vault-held.ts
 * for how "currently held" is derived (Transfer-log replay, not a stored
 * list, since the vault contract itself only exposes count/membership).
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "vault-held", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return cachedPublicJson(cache.data);
  }

  try {
    const ids = await getVaultHeldTokenIds();
    const previewIds = ids.slice(0, MAX_PREVIEWED);
    const images = await Promise.all(
      previewIds.map((id) => resolveTokenImage(NFT_CONTRACT_ADDRESS, id))
    );
    const tokens = previewIds.map((tokenId, i) => ({ tokenId, imageUrl: images[i] ?? null }));
    const data = { count: ids.length, tokens };
    cache = { at: Date.now(), data };
    return cachedPublicJson(data);
  } catch (error) {
    return publicError(error, "Could not read the vault's held tokens right now.");
  }
}
