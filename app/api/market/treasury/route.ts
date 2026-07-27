import { CHAIN, MARKET_FEE_RECIPIENT, MARKET_VAULT_SEED_TARGET_ETH } from "@/lib/constants";
import { publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Public, read-only balance check on the fee treasury — no auth needed,
 * it's just an address anyone could look up on the explorer anyway. This is
 * the actual "liquidity engine" the community can watch grow: fees in ETH,
 * not a new token.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-treasury", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const res = await fetch(CHAIN.rpcUrls.default, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBalance",
        params: [MARKET_FEE_RECIPIENT, "latest"],
      }),
      cache: "no-store",
    });
    const data = (await res.json()) as { result?: string };
    const balanceWei = data.result ? BigInt(data.result) : BigInt(0);
    const targetWei = BigInt(Math.round(MARKET_VAULT_SEED_TARGET_ETH * 1e18));

    return publicJson({
      treasury: MARKET_FEE_RECIPIENT,
      balanceWei: balanceWei.toString(),
      targetWei: targetWei.toString(),
      readyToSeed: balanceWei >= targetWei,
      progressPct: targetWei > BigInt(0)
        ? Math.min(100, Number((balanceWei * BigInt(10000)) / targetWei) / 100)
        : 0,
    });
  } catch {
    return publicJson(
      { error: "RPC_ERROR", message: "Could not read treasury balance right now." },
      502
    );
  }
}
