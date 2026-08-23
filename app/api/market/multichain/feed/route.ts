import { NextRequest, NextResponse } from "next/server";
import { hasMultichainStore, listCollectionFeed } from "@/lib/market/multichain/store";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-feed", limit: 120, windowMs: 60_000 });
  if (limited) return limited;
  if (!hasMultichainStore()) return NextResponse.json({ error: "NOT_CONFIGURED" }, { status: 503 });

  const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? "60");
  const rawCursor = Number(req.nextUrl.searchParams.get("cursor") ?? "0");
  const chainSlug = req.nextUrl.searchParams.get("chainSlug")?.trim() || null;
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 60;
  const afterId = Number.isSafeInteger(rawCursor) && rawCursor >= 0 ? rawCursor : 0;
  try {
    const page = await listCollectionFeed({ limit, afterId, chainSlug });
    return NextResponse.json(page, {
      headers: { "Cache-Control": "public, max-age=30, s-maxage=300, stale-while-revalidate=1800" },
    });
  } catch (error) {
    return publicError(error, "Failed to load collection feed");
  }
}
