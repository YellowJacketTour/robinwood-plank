/**
 * Real collection-wide trait value counts (GET /v2/traits/{slug}, verified
 * live 2026-08-18) -- powers the Details view's "N% of the collection has
 * this trait" signal. Deliberately NOT a full numeric rank: OpenSea's
 * response gives counts per trait value, not a per-token ranking, and
 * computing a real rank would mean fetching every token in the collection
 * (thousands, for a collection this size) on a live request. The honest
 * scope here is "how common is this specific trait value," not "what
 * place does this token hold overall."
 */
import { NextRequest, NextResponse } from "next/server";
import { pickOpenSeaKey } from "@/lib/market/multichain/discovery/opensea-key-pool";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-traits", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const collectionSlug = searchParams.get("collectionSlug");
  if (!collectionSlug) {
    return NextResponse.json({ error: "collectionSlug is required" }, { status: 400 });
  }

  try {
    const key = (await pickOpenSeaKey("live"))?.apiKey ?? null;
    if (!key) {
      return NextResponse.json({ error: "OpenSea API key is not configured on this deployment." }, { status: 503 });
    }
    // Live user-facing route with no caching at all -- every Details-view
    // open hit OpenSea's traits endpoint directly. Same class of bug as the
    // Magic Eden stats fetch fixed in collection/route.ts; wrapped in the
    // same getOrRefresh singleflight/stale-while-revalidate helper (see its
    // own header). Trait-value counts move on human timescales, not
    // per-second -- same TTLs as the collection-stats site.
    const { getOrRefresh } = await import("@/lib/market/multichain/singleflight-cache");
    const data = await getOrRefresh<{ counts?: Record<string, Record<string, number>> }>(
      `opensea-traits:${collectionSlug}`,
      { softTtlMs: 60_000, hardTtlMs: 10 * 60_000, provider: "opensea" },
      async () => {
        // Throw, don't return null/{} -- a transient upstream failure must
        // never poison the cache with a false "no traits" result (same
        // discipline as every other getOrRefresh fetcher in this codebase).
        const res = await fetch(`https://api.opensea.io/api/v2/traits/${encodeURIComponent(collectionSlug)}`, {
          headers: { "x-api-key": key, accept: "application/json" },
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) throw new Error(`OpenSea traits HTTP ${res.status}`);
        return (await res.json()) as { counts?: Record<string, Record<string, number>> };
      }
    );
    return NextResponse.json({ counts: data.counts ?? {} }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to load multichain traits");
  }
}
