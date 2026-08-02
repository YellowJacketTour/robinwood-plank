import { CONTRACT_ADDRESS, NATIVE_TOKEN_ADDRESS } from "@/lib/constants";
import { resolveCounterToken } from "@/lib/uniswap-tokenlist";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";
import { TradeApiError } from "@/lib/uniswap-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { address?: unknown };

/**
 * "Import by address" — the counter-token selector isn't limited to the
 * curated ~100-token list. A pasted 0x address is validated LIVE on-chain
 * (symbol/name/decimals/totalSupply via lib/uniswap-tokenlist's
 * validateArbitraryCounterToken, which resolveCounterToken also uses) —
 * never trusted from an off-chain registry, so there's nothing to spoof by
 * naming a contract "AAPL". Anything that resolves this way comes back
 * flagged unverified:true; the client must show a warning before the token
 * becomes selectable, mirroring how Uniswap's own import flow works.
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "import-token", limit: 20, windowMs: 60_000 });
    if (limited) return limited;

    const body = await readJsonBody<Body>(req);
    const address = typeof body.address === "string" ? body.address.trim() : "";
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      throw new TradeApiError(400, "BAD_ADDRESS", "Enter a valid token contract address.");
    }

    const lower = address.toLowerCase();
    if (lower === CONTRACT_ADDRESS.toLowerCase()) {
      throw new TradeApiError(400, "IS_PLANK", "$PLANK is already the other side of every trade here.");
    }
    if (lower === NATIVE_TOKEN_ADDRESS.toLowerCase()) {
      throw new TradeApiError(400, "IS_NATIVE", "ETH is already in the token list.");
    }

    const token = await resolveCounterToken(address);
    if (!token) {
      throw new TradeApiError(
        404,
        "NOT_ERC20",
        "Could not read this as an ERC-20 token on Robinhood Chain. Check the address."
      );
    }

    return publicJson({ token });
  } catch (err) {
    return publicError(err, "Could not import this token.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
