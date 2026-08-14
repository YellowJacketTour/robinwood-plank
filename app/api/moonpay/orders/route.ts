import { getOrdersForWallet } from "@/lib/moonpay-orders";
import { publicError, publicJson, rateLimit } from "@/lib/security";
import { TradeApiError } from "@/lib/uniswap-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * `?wallet=0x...` — recent ramp orders for one wallet, so the panel can tell
 * a returning buyer what happened instead of leaving them to guess.
 *
 * Read-only and unauthenticated, matching the rest of this app's
 * wallet-keyed reads. What it exposes is a wallet's own fiat order history,
 * which is a real disclosure — so it returns status and amounts only, never
 * the stored raw payload (that carries MoonPay-side customer detail and
 * exists for forensics, not for the browser).
 */
export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "moonpay-orders", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    const url = new URL(req.url);
    const wallet = (url.searchParams.get("wallet") || "").trim();
    if (!HEX_ADDRESS.test(wallet)) {
      throw new TradeApiError(400, "BAD_WALLET_ADDRESS", "Valid wallet address required.");
    }

    const orders = await getOrdersForWallet(wallet, { limit: 5 });
    return publicJson({ ok: true, orders });
  } catch (err) {
    return publicError(err, "Failed to load MoonPay orders.");
  }
}
