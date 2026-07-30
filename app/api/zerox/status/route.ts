import {
  CROSSCHAIN_SOURCE_CHAINS,
  getPublicSiteFee,
  isZeroXConfigured,
  ZEROX_CROSSCHAIN_ENABLED,
  ZEROX_ENABLED,
} from "@/lib/zerox-server";
import { publicJson } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Public status probe — same shape/purpose as /api/crosschain/status: lets a
 * client component no-op cleanly when a feature flag is off or the server
 * has no API key configured yet, without needing to attempt a quote first.
 * Nothing here is secret (no key value, just booleans + public metadata).
 */
export function GET() {
  return publicJson({
    enabled: ZEROX_ENABLED,
    crossChainEnabled: ZEROX_CROSSCHAIN_ENABLED,
    configured: isZeroXConfigured(),
    sourceChains: CROSSCHAIN_SOURCE_CHAINS.map((c) => ({ chainId: c.chainId, name: c.name })),
    siteFee: getPublicSiteFee(),
    disclosure:
      "0x may additionally charge its own ~0.15% fee on select tokens (separate from plank.love's fee) on the free API tier.",
  });
}
