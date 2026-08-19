import { getMultiAssetUsdPrices } from "@/lib/multi-asset-price";
import { publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Public, read-only ETH/SOL/BTC USD display reference for client-side estimates across every tracked chain. */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-asset-prices", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const prices = await getMultiAssetUsdPrices();
  return publicJson({ prices });
}
