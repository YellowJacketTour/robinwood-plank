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
    // Registry first: chain-discovered and ranked by real traded volume, so the
    // picker opens on what people actually trade rather than on an alphabetical
    // wall of tokenised equities. Falls back to the venue list when the
    // registry has not been built yet, which keeps a cold cache working.
    const { readTokenRegistry } = await import("@/lib/market/token-registry");
    const registry = await readTokenRegistry().catch(() => []);
    if (registry.length > 0) {
      const plank = PLANK_TOKEN.address.toLowerCase();
      const counters = registry
        .filter((t) => t.address !== plank)
        .map((t) => ({
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          ...(t.logoURI ? { logoURI: t.logoURI } : {}),
        }));
      return cachedPublicJson({ plank: PLANK_TOKEN, counters }, "market");
    }

    const counters = await getCounterTokens();
    return cachedPublicJson({ plank: PLANK_TOKEN, counters }, "market");
  } catch (error) {
    return publicError(error, "Could not load the token list.");
  }
}
