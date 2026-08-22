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
import { getOpenSeaApiKey } from "@/lib/market/opensea";
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
    const key = await getOpenSeaApiKey();
    if (!key) {
      return NextResponse.json({ error: "OpenSea API key is not configured on this deployment." }, { status: 503 });
    }
    const res = await fetch(`https://api.opensea.io/api/v2/traits/${encodeURIComponent(collectionSlug)}`, {
      headers: { "x-api-key": key, accept: "application/json" },
    });
    if (!res.ok) {
      return NextResponse.json({ error: `OpenSea ${res.status}` }, { status: 502 });
    }
    const data = (await res.json()) as { counts?: Record<string, Record<string, number>> };
    return NextResponse.json({ counts: data.counts ?? {} }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to load multichain traits");
  }
}
