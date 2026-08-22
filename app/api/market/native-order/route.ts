/**
 * Server-side resolver for a single native order's rawOrder by id --
 * exists for the exact same reason app/api/market/native-collection/
 * route.ts does: lib/market/orders-store.ts touches Postgres (via
 * lib/postgres.ts's `pg`) and node:fs, and lib/market/multichain/trading/
 * foreign-fulfill.ts -- which THIS route's real callers live in
 * (buyRobinhoodListingNow, acceptRobinhoodOfferNowImpl) -- is imported by
 * client components (MultichainCollectionView.tsx). A same-file dynamic
 * `await import("@/lib/market/orders-store")` inside foreign-fulfill.ts
 * still gets resolved into the browser build graph by Turbopack, which
 * broke the entire app with "Module not found: Can't resolve 'dns'" the
 * moment a Robinhood-Chain collection page loaded (see
 * lib/market/collections-server.ts's header for the first occurrence of
 * this exact failure mode, fixed the same way: move the Postgres-touching
 * call behind a real HTTP boundary instead of a same-bundle dynamic
 * import).
 *
 * Read-only. No state-changing action lives behind this route.
 */
import { NextRequest, NextResponse } from "next/server";
import { getListingRawOrder, getOfferRawOrder } from "@/lib/market/orders-store";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-native-order", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    const kind = searchParams.get("kind") === "offer" ? "offer" : "listing";
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const rawOrder = kind === "offer" ? await getOfferRawOrder(id) : await getListingRawOrder(id);
    if (!rawOrder) {
      return NextResponse.json({ error: "NOT_FOUND", message: "This order is no longer available." }, { status: 404 });
    }
    return NextResponse.json({ rawOrder }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to resolve this order.");
  }
}
