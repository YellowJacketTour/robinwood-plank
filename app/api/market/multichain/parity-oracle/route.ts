import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { publicError, publicJson, rateLimit } from "@/lib/security";
import { verifyDoorCookieValue, DOOR_COOKIE_NAME } from "@/lib/market-preview-door";
import { verifyPreviewCookieValue, MARKET_PREVIEW_COOKIE_NAME } from "@/lib/market-preview-auth";
import { CHAIN_MANIFESTS } from "@/lib/market/multichain/chains/manifest";
import { readParitySummaries, readParityRows } from "@/lib/market/multichain/parity/lane";

export const dynamic = "force-dynamic";

/** Door/admin-only: how our numbers agree with independent references, per chain, plus per-collection detail on request. */
export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "parity", limit: 60, windowMs: 60_000 });
    if (limited) return limited;
    const jar = await cookies().catch(() => null);
    const privileged = jar
      ? verifyDoorCookieValue(jar.get(DOOR_COOKIE_NAME)?.value) || verifyPreviewCookieValue(jar.get(MARKET_PREVIEW_COOKIE_NAME)?.value)
      : false;
    if (!privileged) return publicJson({ error: "NOT_FOUND" }, 404);
    const url = new URL(req.url);
    const chain = url.searchParams.get("chain");
    const keys = (url.searchParams.get("keys") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
    const summaries = await readParitySummaries(CHAIN_MANIFESTS.map((m) => m.chainSlug));
    const rows = chain && keys.length > 0 ? await readParityRows(chain, keys) : {};
    return NextResponse.json({ summaries, rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to read parity.");
  }
}
