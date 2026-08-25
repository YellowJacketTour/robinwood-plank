/**
 * Live "is a real job hydrating this collection right now" check for a
 * small, client-bounded set of on-screen rows -- companion to
 * getArchivalStatsBatch (lib/market/multichain/archival-ledger.ts), which
 * deliberately skips this same check across its own up-to-5000-row
 * response. This route exists specifically so the rankings table's
 * HydrationPlankChip (currently rendered rows only, capped at 100 by
 * GlobalMarketHub's own "Show 10/25/50/100") can show a real, non-fabricated
 * hydrating indicator without paying that 5000-row cost anywhere.
 *
 * Read-only, public market data, no auth. Rate-limited by IP.
 */
import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/security";
import { getJobProcessingBatch } from "@/lib/market/multichain/archival-ledger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_PAIRS = 100;

type Pair = { chainSlug: string; collectionKey: string };

function asPairs(value: unknown): Pair[] {
  if (!Array.isArray(value)) return [];
  const out: Pair[] = [];
  for (const item of value) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>).chainSlug === "string" &&
      typeof (item as Record<string, unknown>).collectionKey === "string"
    ) {
      const chainSlug = (item as Record<string, unknown>).chainSlug as string;
      const collectionKey = (item as Record<string, unknown>).collectionKey as string;
      if (chainSlug.trim() && collectionKey.trim()) out.push({ chainSlug, collectionKey });
    }
    if (out.length >= MAX_PAIRS) break;
  }
  return out;
}

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-hydration-status", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
  }
  const pairs = asPairs((body as Record<string, unknown>).pairs);
  if (pairs.length === 0) {
    return NextResponse.json({ jobProcessing: {} }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const map = await getJobProcessingBatch(pairs);
    const jobProcessing: Record<string, { source: string }> = {};
    for (const [key, value] of map) jobProcessing[key] = value;
    return NextResponse.json({ jobProcessing }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // Fail closed and honest: never report a fabricated hydrating state.
    return NextResponse.json({ jobProcessing: {} }, { headers: { "Cache-Control": "no-store" } });
  }
}
