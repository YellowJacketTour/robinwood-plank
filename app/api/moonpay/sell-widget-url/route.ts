import { buildSellWidgetUrl, MOONPAY_ENABLED } from "@/lib/moonpay-server";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";
import { TradeApiError } from "@/lib/uniswap-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { refundWalletAddress?: unknown; baseCurrencyCode?: unknown; baseCurrencyAmount?: unknown };

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "moonpay-sell-widget-url", limit: 20, windowMs: 60_000 });
    if (limited) return limited;

    if (!MOONPAY_ENABLED) {
      throw new TradeApiError(404, "MOONPAY_DISABLED", "MoonPay selling is not enabled.");
    }

    const body = await readJsonBody<Body>(req);
    const refundWalletAddress = typeof body.refundWalletAddress === "string" ? body.refundWalletAddress.trim() : "";
    const baseCurrencyCode =
      typeof body.baseCurrencyCode === "string" && body.baseCurrencyCode.trim() ? body.baseCurrencyCode.trim() : undefined;
    const baseCurrencyAmount =
      typeof body.baseCurrencyAmount === "string" && body.baseCurrencyAmount.trim() ? body.baseCurrencyAmount.trim() : undefined;
    if (!refundWalletAddress) {
      throw new TradeApiError(400, "MISSING_WALLET_ADDRESS", "refundWalletAddress is required.");
    }

    const { url, sandbox } = buildSellWidgetUrl(refundWalletAddress, baseCurrencyCode, baseCurrencyAmount);
    return publicJson({ url, sandbox });
  } catch (err) {
    return publicError(err, "Unexpected error building MoonPay sell widget URL.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
