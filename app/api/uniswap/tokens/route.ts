import { getCounterTokens, PLANK_TOKEN } from "@/lib/uniswap-tokenlist";
import { cachedPublicJson } from "@/lib/http-cache";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Token list for the trade widget's selector: $PLANK plus every allowed
 * counter token (native ETH + the official Uniswap list entries for this
 * chain). The server-side allowlist in lib/uniswap-tokenlist.ts is the
 * authority — this route only mirrors it for display.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "uniswap-tokens", limit: 120, windowMs: 60_000 });
  if (limited) return limited;
  try {
    const counters = await getCounterTokens();
    return cachedPublicJson({ plank: PLANK_TOKEN, counters }, "market");
  } catch (error) {
    return publicError(error, "Could not load the token list.");
  }
}
