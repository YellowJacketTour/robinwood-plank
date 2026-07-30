import { CHAIN, CONTRACT_ADDRESS, TOKEN } from "@/lib/constants";
import { CROSSCHAIN_ENABLED } from "@/lib/crosschain-constants";
import { getPublicSiteFee } from "@/lib/uniswap-server";
import { getPublicSourceChains, isCrossChainApiConfigured } from "@/lib/crosschain-server";
import { publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Public feature status for the "Buy from another chain" panel. When the
 * flag is off, this still responds (so the client can render nothing
 * cleanly) but never advertises source chains or a configured API.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "crosschain-status", limit: 180, windowMs: 60_000 });
  if (limited) return limited;

  if (!CROSSCHAIN_ENABLED) {
    return publicJson({ enabled: false });
  }

  return publicJson({
    enabled: true,
    configured: isCrossChainApiConfigured(),
    destination: {
      chainId: CHAIN.id,
      chainName: CHAIN.name,
      token: CONTRACT_ADDRESS,
      symbol: TOKEN.symbol,
    },
    sourceChains: getPublicSourceChains(),
    siteFee: getPublicSiteFee(),
    disclosure:
      "Cross-chain buys settle in minutes, not seconds, and involve multiple transactions across two chains. If the final step fails after the bridge leg completes, you may be left holding an intermediate token instead of $PLANK — see the status view to track and recover.",
  });
}

export function POST() {
  return publicJson({ error: "METHOD", message: "Use GET." }, 405);
}
