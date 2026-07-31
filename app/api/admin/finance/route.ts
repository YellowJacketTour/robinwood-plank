import {
  CONTRACT_ADDRESS,
  MARKET_FEE_RECIPIENT,
  MARKET_OFFER_CURRENCY,
  MARKET_VAULT_ADDRESS,
  MARKET_VAULT_LEGACY_ADDRESS,
  SITE_FEE,
} from "@/lib/constants";
import { ethCallMany, rpcCall } from "@/lib/market/fetch-rpc";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Read-only treasury snapshot for /admin's Finance section. Every value is
 * public on-chain state read through the server RPC chain — no keys, nothing
 * signed, a dashboard not a wallet.
 *
 * Addresses tracked:
 * - SITE_FEE.recipient — the swap integrator-fee wallet. BOTH swap paths pay
 *   it: Uniswap (42.07 bps) and 0x (the same fee, integer-floored to 42 bps —
 *   see lib/zerox-server.ts getSwapFeeParams).
 * - MARKET_FEE_RECIPIENT — Marketplank's treasury (marketplace + vault fees).
 * - The Instant Swap vault contracts (V2 + legacy V1) when configured.
 * Balances per address: native ETH, $PLANK (CONTRACT_ADDRESS), WETH
 * (MARKET_OFFER_CURRENCY — the offers denomination).
 */

const BALANCE_OF = "0x70a08231"; // balanceOf(address)

function balanceOfData(address: string): string {
  return BALANCE_OF + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function hexToDecString(hex: string | null | undefined): string | null {
  if (!hex || typeof hex !== "string") return null;
  try {
    return BigInt(hex === "0x" ? "0x0" : hex).toString();
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const limited = rateLimit(req, {
    key: "admin-finance",
    limit: 30,
    windowMs: 60_000,
  });
  if (limited) return limited;
  try {
    const wallets = [
      {
        key: "trade-fees",
        label: "Swap fee wallet (Uniswap 0.4207% + 0x 0.42%)",
        address: SITE_FEE.recipient,
      },
      {
        key: "market-treasury",
        label: "Marketplank treasury (market + vault fees)",
        address: MARKET_FEE_RECIPIENT,
      },
      ...(MARKET_VAULT_ADDRESS
        ? [
            {
              key: "vault-v2",
              label: "V2 vault contract (Instant Swap reserves)",
              address: MARKET_VAULT_ADDRESS,
            },
          ]
        : []),
      ...(MARKET_VAULT_LEGACY_ADDRESS
        ? [
            {
              key: "vault-v1",
              label: "V1 vault contract (legacy — migrate out)",
              address: MARKET_VAULT_LEGACY_ADDRESS,
            },
          ]
        : []),
    ];

    const [nativeResults, tokenResults] = await Promise.all([
      Promise.all(
        wallets.map((w) =>
          rpcCall<string>("eth_getBalance", [w.address, "latest"]).catch(
            () => null
          )
        )
      ),
      ethCallMany(
        wallets.flatMap((w) => [
          { to: CONTRACT_ADDRESS, data: balanceOfData(w.address) },
          { to: MARKET_OFFER_CURRENCY, data: balanceOfData(w.address) },
        ])
      ).catch(() => wallets.flatMap(() => [null, null]) as (string | null)[]),
    ]);

    const balances = wallets.map((w, i) => ({
      ...w,
      ethWei: hexToDecString(nativeResults[i]),
      plankWei: hexToDecString(tokenResults[i * 2]),
      wethWei: hexToDecString(tokenResults[i * 2 + 1]),
    }));

    return publicJson({
      fetchedAt: new Date().toISOString(),
      tokens: {
        plank: CONTRACT_ADDRESS,
        weth: MARKET_OFFER_CURRENCY,
      },
      balances,
    });
  } catch (err) {
    return publicError(err, "Could not read treasury balances.");
  }
}
