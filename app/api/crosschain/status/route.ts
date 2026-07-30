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
    // The live flow (2026-07-30): Uniswap's CHAINED routing does not yet
    // stitch a source-chain -> $PLANK hop for this pair ("No quotes
    // available", confirmed empirically, not $PLANK-specific). What DOES
    // work today is bridging native currency into native ETH on Robinhood
    // Chain, then swapping that ETH for $PLANK through the existing widget.
    flow: "bridge_then_swap",
    disclosure:
      "This is two transactions across two chains and takes minutes, not seconds — don't close the tab. Bridging is executed by a third party (Across, via Uniswap); we don't control settlement. If the bridge step fails after your ETH leaves your wallet, you may end up holding ETH on Robinhood Chain instead of completing the transfer — that ETH is recoverable and swappable, not stranded in an exotic token. Every step gives you a transaction hash and explorer link so a stuck flow is traceable.",
    stepTwo:
      "After the bridge lands, swap your ETH on Robinhood Chain for $PLANK using the trade widget — the normal 0.4207% fee applies there, same as any same-chain swap.",
  });
}

export function POST() {
  return publicJson({ error: "METHOD", message: "Use GET." }, 405);
}
