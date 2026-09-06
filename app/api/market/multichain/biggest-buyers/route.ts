/**
 * Biggest buyers for one collection from the real fill ledger. Read-only,
 * rate-limited; goes through the edge gateway so N viewers of one board
 * cost one Postgres aggregate per TTL window.
 */
import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/security";
import { readBiggestBuyers } from "@/lib/market/multichain/biggest-buyers";
import { edgeRead } from "@/lib/market/multichain/edge/read-gateway";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-biggest-buyers", limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  const chainSlug = req.nextUrl.searchParams.get("chainSlug");
  const collectionKey = req.nextUrl.searchParams.get("collectionKey");
  const hours = Number(req.nextUrl.searchParams.get("hours") ?? "168");
  if (!chainSlug || !collectionKey) return NextResponse.json({ error: "chainSlug and collectionKey are required" }, { status: 400 });
  try {
    const { value, freshness, ageMs } = await edgeRead(
      { kind: "activity", chainSlug, subject: collectionKey, variant: { board: "buyers", hours } },
      async () => {
        const board = await readBiggestBuyers({ chainSlug, collectionKey, windowHours: hours });
        if (!board) throw new Error("ledger unavailable");
        return board;
      }
    );
    return NextResponse.json({ ...value, freshness, ageMs }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Biggest buyers unavailable (no fill ledger)" }, { status: 503 });
  }
}
