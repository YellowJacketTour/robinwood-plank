/**
 * Server-side resolver for one bundle listing's rawOrder by id -- same
 * reason as native-order/route.ts: lib/market/bundle-orders-store.ts
 * touches Postgres and must never enter the client bundle. Read-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { getBundleListingRawOrder } from "@/lib/market/bundle-orders-store";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-native-bundle-order", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const rawOrder = await getBundleListingRawOrder(id);
    if (!rawOrder) {
      return NextResponse.json({ error: "NOT_FOUND", message: "This bundle is no longer available." }, { status: 404 });
    }
    return NextResponse.json({ rawOrder }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to resolve this bundle listing.");
  }
}
