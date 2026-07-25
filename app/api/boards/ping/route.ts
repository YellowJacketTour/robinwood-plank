import { isAddressLike, isListingWindowActive, normalizeAddress } from "@/lib/boards";
import { recordWidgetActivity } from "@/lib/boards-store";
import { TradeApiError } from "@/lib/uniswap-server";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Official widget heartbeat — call after quote/swap through plank.love.
 * Marks the wallet as widget-verified so chain activity is not auto-Bad-Boarded.
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "boards-ping", limit: 40, windowMs: 60_000 });
    if (limited) return limited;

    const body = await readJsonBody<{ address?: unknown; kind?: unknown }>(req);
    const address = typeof body.address === "string" ? body.address.trim() : "";
    const kind = body.kind === "swap" ? "swap" : "quote";

    if (!isAddressLike(address)) {
      throw new TradeApiError(400, "BAD_ADDRESS", "Valid wallet address required.");
    }

    const session = await recordWidgetActivity(normalizeAddress(address), kind);

    return publicJson({
      ok: true,
      listingWindow: isListingWindowActive(),
      session,
    });
  } catch (err) {
    return publicError(err, "Failed to record widget session.");
  }
}
