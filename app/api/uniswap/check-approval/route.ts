import { CHAIN, CONTRACT_ADDRESS, NATIVE_TOKEN_ADDRESS } from "@/lib/constants";
import {
  assertNoClientFeeOrRouteOverride,
  assertTradeOpen,
  TradeApiError,
  uniswapFetch,
} from "@/lib/uniswap-server";
import {
  publicError,
  publicJson,
  rateLimit,
  readJsonBody,
  sanitizeUpstreamError,
} from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  walletAddress?: unknown;
  token?: unknown;
  amount?: unknown;
  chainId?: unknown;
};

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "approval", limit: 30, windowMs: 60_000 });
    if (limited) return limited;

    assertTradeOpen();

    const body = await readJsonBody<Body>(req);
    assertNoClientFeeOrRouteOverride(body as Record<string, unknown>);

    const walletAddress =
      typeof body.walletAddress === "string" ? body.walletAddress.trim() : "";
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const amount = typeof body.amount === "string" ? body.amount.trim() : "";

    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      throw new TradeApiError(400, "BAD_WALLET", "walletAddress must be a valid address.");
    }
    if (!token || !/^0x[a-fA-F0-9]{40}$/.test(token)) {
      throw new TradeApiError(400, "BAD_TOKEN", "token must be a valid address.");
    }
    if (!amount || !/^\d+$/.test(amount) || amount === "0") {
      throw new TradeApiError(400, "BAD_AMOUNT", "amount must be a positive integer string.");
    }

    // Force chain + only allow native/PLANK approvals
    const t = token.toLowerCase();
    const allowed = new Set([
      CONTRACT_ADDRESS.toLowerCase(),
      NATIVE_TOKEN_ADDRESS.toLowerCase(),
    ]);
    if (!allowed.has(t)) {
      throw new TradeApiError(400, "BAD_TOKEN", "Only ETH / $PLANK approvals are allowed.");
    }

    // Ignore client chainId — always Robinhood
    const upstream = await uniswapFetch("/check_approval", {
      walletAddress,
      token,
      amount,
      chainId: CHAIN.id,
    });

    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    if (!upstream.ok) {
      const clean = sanitizeUpstreamError(data, "Approval check failed.");
      return publicJson(clean, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    return publicJson(data);
  } catch (err) {
    return publicError(err, "Unexpected error checking approval.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
