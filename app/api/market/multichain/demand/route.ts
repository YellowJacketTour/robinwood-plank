/**
 * The demand bus's single public entry point -- POST one or more intents
 * (viewport, hover, click, search, wallet-connect, sweep, facet). Thin:
 * validates, bounds, rate-limits per chain, hashes the client, hands off to
 * publishIntent (lib/market/multichain/edge/demand-bus.ts). Returns counts
 * and the per-subject priority decision (explainable, never payload data).
 * Write-only demand signal, not a read path; it never calls a vendor.
 *
 * /api/market/multichain/visibility-demand stays as the viewport-tier
 * writer (its aging schedule is the authority for that tier); this route
 * is the superset every OTHER intent kind publishes through.
 */
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, rateLimit } from "@/lib/security";
import { clientHash, publishIntent, type DemandIntent, type IntentKind } from "@/lib/market/multichain/edge/demand-bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const KINDS = new Set<IntentKind>(["viewport", "hover", "click", "search", "wallet-connect", "sweep", "facet", "read"]);
const MAX_INTENTS = 8;

function asStringArray(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, cap);
}

function parseIntent(raw: unknown): DemandIntent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === "string" && KINDS.has(r.kind as IntentKind) ? (r.kind as IntentKind) : null;
  const chainSlug = typeof r.chainSlug === "string" ? r.chainSlug.trim() : "";
  if (!kind || !chainSlug) return null;
  const subjects = asStringArray(r.subjects, 40);
  if (subjects.length === 0) return null;
  const money = typeof r.moneyAtStakeUsd === "number" && Number.isFinite(r.moneyAtStakeUsd) ? Math.max(0, r.moneyAtStakeUsd) : 0;
  return {
    kind,
    chainSlug,
    subjects,
    moneyAtStakeUsd: money,
    tokenIds: asStringArray(r.tokenIds, 48),
    context: typeof r.context === "string" ? r.context.slice(0, 40) : undefined,
  };
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const list = Array.isArray(body) ? body : [body];
  const intents = list.map(parseIntent).filter((i): i is DemandIntent => i !== null).slice(0, MAX_INTENTS);
  if (intents.length === 0) {
    return NextResponse.json({ error: "No valid intents" }, { status: 400 });
  }
  // Per-chain buckets, same reasoning as visibility-demand/route.ts.
  for (const chain of new Set(intents.map((i) => i.chainSlug))) {
    const limited = rateLimit(req, { key: `market-multichain-demand:${chain}`, limit: 60, windowMs: 60_000 });
    if (limited) return limited;
  }
  const client = { hash: clientHash(getClientIp(req), req.headers.get("user-agent")) };
  try {
    const results = await Promise.all(intents.map((intent) => publishIntent(intent, client)));
    return NextResponse.json(
      {
        accepted: results.reduce((n, r) => n + r.accepted, 0),
        enqueued: results.reduce((n, r) => n + r.enqueued, 0),
        decisions: results.flatMap((r, i) => r.decisions.map((d) => ({ kind: intents[i].kind, chainSlug: intents[i].chainSlug, ...d }))),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Failed to record demand" }, { status: 500 });
  }
}
