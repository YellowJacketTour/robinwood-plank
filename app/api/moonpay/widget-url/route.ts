import { buildBuyWidgetUrl, MOONPAY_ENABLED } from "@/lib/moonpay-server";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";
import { TradeApiError } from "@/lib/uniswap-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { walletAddress?: unknown; currencyCode?: unknown };

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "moonpay-widget-url", limit: 20, windowMs: 60_000 });
    if (limited) return limited;

    // Feature is OFF by default and MUST be a clean no-op when off -- same
    // gate shape as ZEROX_ENABLED / GASLESS_SWAPS_ENABLED elsewhere.
    if (!MOONPAY_ENABLED) {
      throw new TradeApiError(404, "MOONPAY_DISABLED", "MoonPay buying is not enabled.");
    }

    const body = await readJsonBody<Body>(req);
    const walletAddress = typeof body.walletAddress === "string" ? body.walletAddress.trim() : "";
    const currencyCode = typeof body.currencyCode === "string" && body.currencyCode.trim() ? body.currencyCode.trim() : undefined;
    if (!walletAddress) {
      throw new TradeApiError(400, "MISSING_WALLET_ADDRESS", "walletAddress is required.");
    }

    const { url, sandbox } = buildBuyWidgetUrl(walletAddress, currencyCode);
    return publicJson({ url, sandbox });
  } catch (err) {
    return publicError(err, "Unexpected error building MoonPay widget URL.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
