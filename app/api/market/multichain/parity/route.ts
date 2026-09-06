/**
 * Trading parity matrix as data -- chain × feature × state with evidence.
 * A registry read (lib/market/multichain/trading/parity-matrix.ts), no
 * vendor call, no claim beyond what the registry records.
 */
import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/security";
import { fullParityMatrix, parityForChain, paritySummary } from "@/lib/market/multichain/trading/parity-matrix";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-parity", limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  const chainSlug = req.nextUrl.searchParams.get("chainSlug");
  const cells = chainSlug ? parityForChain(chainSlug) : fullParityMatrix();
  return NextResponse.json({ cells, summary: paritySummary(cells) }, { headers: { "Cache-Control": "public, max-age=300" } });
}
