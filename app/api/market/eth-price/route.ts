import { getEthUsdPrice } from "@/lib/eth-price";
import { publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Public, read-only ETH/USD display reference for client-side estimates. */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-eth-price", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const price = await getEthUsdPrice();
  return publicJson({
    ethUsd: price.usd > 0 ? price.usd : null,
    source: price.source,
    ageMs: Number.isFinite(price.ageMs) ? price.ageMs : null,
  });
}
