/**
 * A wallet's own recent sale/transfer activity across every chain OpenSea
 * indexes -- the global "Activity" tab's data source. Confirmed live
 * 2026-08-18: GET /events/accounts/{address} is a real endpoint distinct
 * from /events/collection/{slug} (used by activity/route.ts for the
 * per-collection tab) and does NOT require a chain param -- one call
 * covers every chain OpenSea tracks for that address, not one call per
 * chain.
 */
import { NextRequest, NextResponse } from "next/server";
import { pickOpenSeaKey } from "@/lib/market/multichain/discovery/opensea-key-pool";
import { publicError, rateLimit } from "@/lib/security";
import { activityValue } from "@/lib/market/activity-value";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OPENSEA = "https://api.opensea.io/api/v2";

type OpenSeaEvent = {
  event_type: string;
  event_timestamp: number;
  transaction: string | null;
  chain?: string | null;
  payment?: { quantity: string; token_address?: string; decimals?: number; symbol: string } | null;
  seller?: string | null;
  buyer?: string | null;
  from_address?: string | null;
  to_address?: string | null;
  nft?: { identifier?: string; name?: string; collection?: string; image_url?: string } | null;
};

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-account-activity", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const owner = searchParams.get("owner");
  const limitParam = Number(searchParams.get("limit") ?? "25");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 25;

  if (!owner) {
    return NextResponse.json({ error: "owner is required" }, { status: 400 });
  }

  try {
    const key = (await pickOpenSeaKey("live"))?.apiKey ?? null;
    if (!key) {
      return NextResponse.json({ error: "OpenSea API key is not configured on this deployment." }, { status: 503 });
    }
    const res = await fetch(`${OPENSEA}/events/accounts/${owner}?event_type=sale&event_type=transfer&limit=${limit}`, {
      headers: { "x-api-key": key, accept: "application/json" },
    });
    if (!res.ok) {
      return NextResponse.json({ error: `OpenSea ${res.status}` }, { status: 502 });
    }
    const data = (await res.json()) as { asset_events?: OpenSeaEvent[] };
    const events = await Promise.all((data.asset_events ?? []).map(async (e) => ({
      type: e.event_type,
      timestamp: new Date(e.event_timestamp * 1000).toISOString(),
      transaction: e.transaction,
      chain: e.chain ?? null,
      priceWei: e.payment?.quantity ?? null,
      ...(await activityValue({
        atomic: e.payment?.quantity,
        decimals: e.payment?.decimals,
        symbol: e.payment?.symbol,
        tokenAddress: e.payment?.token_address,
        chain: e.chain,
      })),
      from: e.seller ?? e.from_address ?? null,
      to: e.buyer ?? e.to_address ?? null,
      collection: e.nft?.collection ?? null,
      tokenId: e.nft?.identifier ?? null,
      tokenName: e.nft?.name ?? null,
    })));
    return NextResponse.json({ events }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to load your multichain activity");
  }
}
