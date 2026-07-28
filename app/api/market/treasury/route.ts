import { CHAIN, MARKET_FEE_RECIPIENT, MARKET_VAULT_ADDRESS } from "@/lib/constants";
import { publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function rpcCall(method: string, params: unknown[]): Promise<string | null> {
  const res = await fetch(CHAIN.rpcUrls.default, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  const data = (await res.json()) as { result?: string };
  return typeof data.result === "string" ? data.result : null;
}

/**
 * There is no fixed ETH target any more — see contracts/MarketplankVault.sol
 * revision 5: the owner seeds at their own pace across as many calls as they
 * want, then explicitly calls `openPool()` whenever THEY decide it's enough.
 * `ethReserve()` and `poolOpen()` are the only two facts worth reading.
 */
async function readFromVault(vaultAddress: string) {
  // Computed with ethers' id("ethReserve()").slice(0,10) etc. and
  // cross-checked against the compiled ABI via Interface.encodeFunctionData
  // — never hand-typed, a wrong selector here reverts or silently reads the
  // wrong storage.
  const ETH_RESERVE_SELECTOR = "0xd62ccb3f"; // ethReserve()
  const POOL_OPEN_SELECTOR = "0x6c1fc9c5"; // poolOpen()

  const [reserveHex, openHex] = await Promise.all([
    rpcCall("eth_call", [{ to: vaultAddress, data: ETH_RESERVE_SELECTOR }, "latest"]),
    rpcCall("eth_call", [{ to: vaultAddress, data: POOL_OPEN_SELECTOR }, "latest"]),
  ]);
  if (!reserveHex || !openHex) return null;

  return {
    source: "vault" as const,
    treasury: vaultAddress,
    balanceWei: BigInt(reserveHex).toString(),
    open: BigInt(openHex) !== BigInt(0),
  };
}

/**
 * Public, read-only view of the workshop fund — no auth needed, it's all
 * data anyone could look up on the explorer anyway.
 *
 * Pre-deploy: a proxy reading the fee treasury's raw ETH balance — the only
 * real number that exists yet, and not tied to any target since there isn't
 * one. Post-deploy: the real on-chain vault state — `ethReserve()` is the
 * actual accumulated pool, `poolOpen()` says whether the owner has already
 * thrown the one-way switch that makes trading public.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-treasury", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    if (MARKET_VAULT_ADDRESS) {
      const vaultData = await readFromVault(MARKET_VAULT_ADDRESS);
      if (vaultData) return publicJson(vaultData);
      // Vault address configured but unreachable — fall through to the
      // treasury proxy rather than showing nothing.
    }

    const balanceHex = await rpcCall("eth_getBalance", [MARKET_FEE_RECIPIENT, "latest"]);
    const balanceWei = balanceHex ? BigInt(balanceHex) : BigInt(0);

    return publicJson({
      source: "treasury-proxy",
      treasury: MARKET_FEE_RECIPIENT,
      balanceWei: balanceWei.toString(),
      open: false,
    });
  } catch {
    return publicJson(
      { error: "RPC_ERROR", message: "Could not read the workshop fund right now." },
      502
    );
  }
}
