import { MARKET_FEE_RECIPIENT, MARKET_VAULT_ADDRESS } from "@/lib/constants";
import { ethCall, rpcCall as vaultRpc } from "@/lib/market/fetch-rpc";
import { cachedPublicJson } from "@/lib/http-cache";
import { publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

  try {
    const [reserveHex, openHex] = await Promise.all([
      ethCall(vaultAddress, ETH_RESERVE_SELECTOR),
      ethCall(vaultAddress, POOL_OPEN_SELECTOR),
    ]);
    if (!reserveHex || !openHex) return null;

    return {
      source: "vault" as const,
      treasury: vaultAddress,
      balanceWei: BigInt(reserveHex).toString(),
      open: BigInt(openHex) !== BigInt(0),
    };
  } catch {
    return null;
  }
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
      if (vaultData) return cachedPublicJson(vaultData, "live");
      // Vault address configured but unreachable — fall through to the
      // treasury proxy rather than showing nothing.
    }

    // Prefer vault open state even when ethReserve call path failed — never
    // claim the pool is closed just because this fallback path is used.
    let open = false;
    if (MARKET_VAULT_ADDRESS) {
      try {
        const openHex = await ethCall(MARKET_VAULT_ADDRESS, "0x6c1fc9c5");
        open = Boolean(openHex && BigInt(openHex) !== BigInt(0));
      } catch {
        open = false;
      }
    }

    let balanceWei = "0";
    try {
      const balanceHex = await vaultRpc<string>("eth_getBalance", [MARKET_FEE_RECIPIENT, "latest"]);
      if (balanceHex) balanceWei = BigInt(balanceHex).toString();
    } catch {
      /* leave 0 */
    }

    return cachedPublicJson(
      {
        source: "treasury-proxy",
        treasury: MARKET_FEE_RECIPIENT,
        balanceWei,
        open,
      },
      "live"
    );
  } catch {
    return publicJson(
      { error: "RPC_ERROR", message: "Could not read the workshop fund right now." },
      502
    );
  }
}
