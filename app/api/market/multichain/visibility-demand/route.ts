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
import { prioritizeVisibleCollections } from "@/lib/market/multichain/collection-demand";

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
  // Same rate-limit helper/pattern every other market route uses (see e.g.
  // app/api/market/multichain/collection/route.ts) -- no auth required
  // (public market data), IP-scoped only. 30/min matches the design doc's
  // "Rate / safety checklist" section.
  const limited = rateLimit(req, { key: "market-multichain-visibility-demand", limit: 30, windowMs: 60_000 });
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
  const { chainSlug, keys, pageKeys, pageOrder, context } = body as Record<string, unknown>;

  if (typeof chainSlug !== "string" || !chainSlug.trim()) {
    return NextResponse.json({ error: "chainSlug is required" }, { status: 400 });
  }
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
