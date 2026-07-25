import { isAddressLike, normalizeAddress } from "@/lib/boards";
import { classifyWallet } from "@/lib/boards-store";
import { TradeApiError } from "@/lib/uniswap-server";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "boards-wallet", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    const url = new URL(req.url);
    const address = url.searchParams.get("address")?.trim() || "";
    if (!isAddressLike(address)) {
      throw new TradeApiError(400, "BAD_ADDRESS", "Query ?address=0x… required.");
    }

    const result = await classifyWallet(normalizeAddress(address));
    return publicJson({
      address: normalizeAddress(address),
      ...result,
    });
  } catch (err) {
    return publicError(err, "Wallet lookup failed.");
  }
}
