/**
 * Real recent activity (sales, transfers) for ONE collection on a foreign
 * chain -- the Activity-tab equivalent for the multichain surface.
 *
 * Live-verified 2026-08-18 against GRiBBiTS on Base:
 * GET /events/collection/{slug}?event_type=sale&event_type=transfer returns
 * real asset_events with a real transaction hash, real payment amount, and
 * real buyer/seller/from/to addresses -- confirmed with a real API key
 * (unauthenticated requests get a clean 401, not silently-empty data, so a
 * misconfigured deployment fails loud here rather than showing a fake
 * "no activity" state).
 */
import { NextRequest, NextResponse } from "next/server";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OPENSEA = "https://api.opensea.io/api/v2";

type OpenSeaEvent = {
  event_type: "sale" | "transfer" | string;
  event_timestamp: number;
  transaction: string | null;
  payment?: { quantity: string; token_address: string; decimals: number; symbol: string } | null;
  seller?: string | null;
  buyer?: string | null;
  from_address?: string | null;
  to_address?: string | null;
  nft?: { identifier?: string; name?: string; image_url?: string } | null;
};

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-activity", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const collectionSlug = searchParams.get("collectionSlug");
  const limitParam = Number(searchParams.get("limit") ?? "25");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 25;

  if (!chainSlug || !collectionSlug) {
    return NextResponse.json({ error: "chainSlug and collectionSlug are required" }, { status: 400 });
  }
  if (!foreignChainByChainSlug(chainSlug)) {
    return NextResponse.json({ error: `"${chainSlug}" is not a supported foreign chain` }, { status: 400 });
  }

  try {
    const key = await getOpenSeaApiKey();
    if (!key) {
      return NextResponse.json({ error: "OpenSea API key is not configured on this deployment." }, { status: 503 });
    }
    const url =
      `${OPENSEA}/events/collection/${encodeURIComponent(collectionSlug)}` +
      `?event_type=sale&event_type=transfer&limit=${limit}`;
    const res = await fetch(url, { headers: { "x-api-key": key, accept: "application/json" } });
    if (!res.ok) {
      return NextResponse.json({ error: `OpenSea ${res.status}` }, { status: 502 });
    }
    const data = (await res.json()) as { asset_events?: OpenSeaEvent[] };
    const events = (data.asset_events ?? []).map((e) => ({
      type: e.event_type,
      timestamp: new Date(e.event_timestamp * 1000).toISOString(),
      transaction: e.transaction,
      priceWei: e.payment?.quantity ?? null,
      priceSymbol: e.payment?.symbol ?? null,
      from: e.seller ?? e.from_address ?? null,
      to: e.buyer ?? e.to_address ?? null,
      tokenId: e.nft?.identifier ?? null,
      tokenName: e.nft?.name ?? null,
      imageUrl: e.nft?.image_url ?? null,
    }));
    return NextResponse.json({ events }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to load multichain activity");
  }
}
