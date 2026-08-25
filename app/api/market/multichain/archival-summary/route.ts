/**
 * Platform-wide "how much of what we track is verifiably synced" number --
 * see getGlobalArchivalSummary's own header (lib/market/multichain/
 * archival-ledger.ts) for the real, honest resolution rule (score_method
 * must be 'supply_ratio', i.e. a real known supply, not just any row; 98%+
 * of that real supply to count as synced). Backs the nav BrandMark, which
 * renders on every page -- this route is cheap only because
 * getGlobalArchivalSummary caches the underlying aggregate for 5 minutes.
 *
 * Read-only, public market data, no auth. Rate-limited by IP.
 */
import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/security";
import { getGlobalArchivalSummary } from "@/lib/market/multichain/archival-ledger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-archival-summary", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const summary = await getGlobalArchivalSummary();
    return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // Fail closed and honest: never report a fabricated ratio.
    return NextResponse.json(
      { verifiableCount: 0, syncedCount: 0, syncedRatio: null, totalTracked: 0, asOf: new Date(0).toISOString() },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }
}
