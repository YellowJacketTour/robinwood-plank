import { isListingWindowActive } from "@/lib/boards";
import { scanPlankTransfers } from "@/lib/boards-scanner";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Scan chain for off-widget $PLANK transfers during the death trap / cooldown window.
 * Public (rate-limited) so the boards UI can refresh live; also callable by ops.
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "boards-scan", limit: 10, windowMs: 60_000 });
    if (limited) return limited;

    if (!isListingWindowActive()) {
      return publicJson({
        ok: true,
        skipped: true,
        message: "Listing window inactive — cooldowns complete or rules relaxed.",
      });
    }

    const result = await scanPlankTransfers();
    return publicJson({ ok: true, ...result });
  } catch (err) {
    return publicError(err, "Chain scan failed.");
  }
}

export async function GET(req: Request) {
  return POST(req);
}
