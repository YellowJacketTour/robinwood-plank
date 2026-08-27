/**
 * Viewport-aware continuous hydration -- docs/marketplank/GROK-FINDINGS-
 * viewport-predictive-hydration-2026-08-25.md. Thin route: validates input,
 * caps batch size, rate-limits by IP, and hands off to
 * prioritizeVisibleCollections (lib/market/multichain/collection-demand.ts)
 * for all real priority logic. Returns only counts, never payload data --
 * this is a write-only demand signal, not a read path.
 *
 * Same scope boundary as that function's own docstring: this can only
 * change mesh-queue ORDERING via the existing enqueueDataJob dedup. It never
 * calls a third-party provider directly and never touches singleflight-
 * cache/freshness-budget's live-read paths.
 */
import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/security";
import { prioritizeVisibleCollections, partitionKnownCollectionKeys, dedupeAndCapKeys } from "@/lib/market/multichain/collection-demand";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_KEYS = 40;
const MAX_PAGE_ORDER = 200;
const VALID_CONTEXTS = new Set(["rankings", "detail", "rail", "movers"]);

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
  }
  const { chainSlug, keys, pageKeys, pageOrder, context } = body as Record<string, unknown>;

  if (typeof chainSlug !== "string" || !chainSlug.trim()) {
    return NextResponse.json({ error: "chainSlug is required" }, { status: 400 });
  }

  // Same rate-limit helper/pattern every other market route uses (see e.g.
  // app/api/market/multichain/collection/route.ts) -- no auth required
  // (public market data), IP-scoped. 30/min matches the design doc's
  // "Rate / safety checklist" section, but scoped PER CHAIN (not one shared
  // budget across every chain from one IP): GlobalMarketHub.tsx's own
  // continuous-hydration effect fires one POST per distinct chain visible
  // on the page every 20s, so an aggregate/all-chains view (the rankings
  // page's default) legitimately sends N chains x 3 ticks/min -- with the
  // real current chain count (12), that's 36/min against a single flat
  // 30/min bucket, guaranteed to self-throttle real demand signal even
  // with zero abuse. Live-confirmed 2026-08-27: ~11% of real calls (253 of
  // 2368) were dropped by exactly this. Each chain is already an
  // independent mesh-tick priority lane, so budgeting it independently
  // here is the correct unit, not a loosened limit.
  const limited = rateLimit(req, { key: `market-multichain-visibility-demand:${chainSlug}`, limit: 30, windowMs: 60_000 });
  if (limited) return limited;
  const ctx = typeof context === "string" && VALID_CONTEXTS.has(context)
    ? (context as "rankings" | "detail" | "rail" | "movers")
    : undefined;

  // "keys" (client IntersectionObserver hits) and "pageKeys" (server-known
  // page set, per section 1's "SSR/API already knows the page" note) are
  // merged into one visible-key list -- both are equally real signal that a
  // collection is on this page right now.
  const merged = [...asStringArray(keys), ...asStringArray(pageKeys)].slice(0, MAX_KEYS * 2);
  if (merged.length === 0) {
    return NextResponse.json({ accepted: 0, enqueued: 0 }, { headers: { "Cache-Control": "no-store" } });
  }
  const order = asStringArray(pageOrder).slice(0, MAX_PAGE_ORDER);

  // Demand admission hardening (docs/marketplank/GROK-FINDINGS-sustainable-
  // archival-mining-2026-08-25.md section C / build order item 3): a
  // request that names even one key never seen in this app's own tracked-
  // collections registry gets a much tighter per-IP budget than plain
  // visibility pings -- prioritizeVisibleCollections itself also caps that
  // key's mesh priority (DEMAND_PRIORITY.UNKNOWN_KEY) and skips its durable
  // aging row, but the two checks are independent: this stops a client from
  // even repeatedly TRYING junk keys, regardless of how low their eventual
  // priority would be.
  const { unknown } = await partitionKnownCollectionKeys(chainSlug, dedupeAndCapKeys(merged, MAX_KEYS)).catch(
    () => ({ known: new Set<string>(), unknown: new Set<string>() })
  );
  if (unknown.size > 0) {
    const tightened = rateLimit(req, { key: "market-multichain-visibility-demand-unknown-key", limit: 8, windowMs: 60_000 });
    if (tightened) return tightened;
  }

  try {
    const result = await prioritizeVisibleCollections(chainSlug, merged, {
      context: ctx,
      pageOrder: order.length > 0 ? order : undefined,
    });
    return NextResponse.json(
      { accepted: Math.min(merged.length, MAX_KEYS), enqueued: result.enqueued },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    // Fail closed with a clear, honest message -- never fabricate a success
    // count when the underlying enqueue actually failed.
    return NextResponse.json({ error: "Failed to record visibility demand" }, { status: 500 });
  }
}
