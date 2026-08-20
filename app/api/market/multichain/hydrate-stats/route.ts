/**
 * Fills hub ranking cells from OpenSea stats for a bounded set of contracts
 * the viewer is actually looking at — not a 15k stampede. Fail closed.
 */
import { NextRequest, NextResponse } from "next/server";
import { publicError, rateLimit } from "@/lib/security";
import { refreshOpenSeaStatsForContract } from "@/lib/market/multichain/opensea-collection-stats";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-hydrate-stats", limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as { chainSlug?: string; contracts?: string[] } | null;
  const chainSlug = body?.chainSlug;
  const contracts = [...new Set((body?.contracts ?? []).filter((a) => typeof a === "string" && a.length > 0))].slice(0, 8);
  if (!chainSlug || contracts.length === 0) {
    return NextResponse.json({ error: "chainSlug and contracts[] are required" }, { status: 400 });
  }

  try {
    let ok = 0;
    for (const address of contracts) {
      const r = await refreshOpenSeaStatsForContract(chainSlug, address);
      if (r.ok) ok += 1;
    }
    return NextResponse.json({ hydrated: ok, attempted: contracts.length }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to hydrate collection stats");
  }
}
