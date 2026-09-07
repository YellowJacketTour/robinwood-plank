import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { publicJson, rateLimit } from "@/lib/security";
import { verifyDoorCookieValue, DOOR_COOKIE_NAME } from "@/lib/market-preview-door";
import { verifyPreviewCookieValue, MARKET_PREVIEW_COOKIE_NAME } from "@/lib/market-preview-auth";
import { readMeshDiagnostics } from "@/lib/market/multichain/edge/mesh-diagnostics";

export const dynamic = "force-dynamic";

/** Door/admin-only mesh ground truth. See lib/market/multichain/edge/mesh-diagnostics.ts. */
export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "mesh-diagnostics", limit: 30, windowMs: 60_000 });
    if (limited) return limited;
    const jar = await cookies().catch(() => null);
    const privileged = jar
      ? verifyDoorCookieValue(jar.get(DOOR_COOKIE_NAME)?.value) || verifyPreviewCookieValue(jar.get(MARKET_PREVIEW_COOKIE_NAME)?.value)
      : false;
    if (!privileged) return publicJson({ error: "NOT_FOUND" }, 404);
    const value = await readMeshDiagnostics();
    return NextResponse.json(value ?? { error: "NO_POSTGRES" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Door-only route: the real failure text is exactly what the reader needs.
    return NextResponse.json({ error: "INTERNAL", detail: error instanceof Error ? error.message : String(error) }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
