import {
  CONTRACT_ADDRESS,
  MARKET_FEE_RECIPIENT,
  MARKET_OFFER_CURRENCY,
  SITE_FEE,
} from "@/lib/constants";
import { ethCallMany, rpcCall } from "@/lib/market/fetch-rpc";
import { fetchTokenBalances } from "@/lib/market/blockscout";
import { readCoreVaultState } from "@/lib/market/vault-stats";
import { feeModelForVault, listVaultsForDisplay } from "@/lib/market/vault-registry";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Read-only treasury snapshot for /admin's Finance section. Every value is
 * public on-chain state read through the server RPC chain — no keys, nothing
 * signed, a dashboard not a wallet.
 *
 * Two different kinds of row, deliberately not sharing one column set
 * (2026-08-02 rework — the old shared shape put "$PLANK 0.00" and "WETH 0.00"
 * on every vault row, which is meaningless: a pool holds $PLANK NFTs and its
 * own share token, never the $PLANK ERC-20 or WETH):
 *
 * - `wallets` — treasury/fee EOAs. ETH plus EVERY ERC-20 the wallet actually
 *   holds (via Blockscout's token-balances indexer — see
 *   fetchWalletTokens below), plus each wallet's share-token holding in
 *   every configured vault (a vault contract IS its own ERC-20 share token,
 *   so this is balanceOf(vault, wallet) per vault — what the owner called
 *   "vROBIN"; excluded from the generic token list so it isn't double-
 *   counted in both places).
 *   - SITE_FEE.recipient — the swap integrator-fee wallet. Every swap path
 *     pays it, at the SAME address and the SAME 0x rate for both surfaces:
 *     Uniswap (42.07 bps), 0x same-chain, and 0x cross-chain (all three read
 *     from lib/zerox-server.ts's single getSwapFeeParams(), floored to 42
 *     bps for 0x — see app/api/zerox/quote and app/api/zerox/crosschain/quote).
 *     There is no separate 0x/cross-chain wallet to add.
 *   - MARKET_FEE_RECIPIENT — Marketplank's treasury (marketplace + vault fees).
 * - `pools` — every configured Instant Swap vault contract (current primary +
 *   every legacy, resolved through lib/market/vault-registry.ts's N-vault
 *   registry by address, never a hardcoded V1/V2 pair). ETH reserve, share
 *   reserve (its own share-token balance), and $PLANK NFTs held
 *   (heldTokenCount — the vault never holds the $PLANK ERC-20 or WETH).
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

type WalletToken = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  valueWei: string;
};

// Blockscout rate-limits this host hard (see lib/market/fetch-rpc.ts's own
// note on the same 429 behavior) — worth a short cache so a Finance-section
// refresh spam doesn't burn the budget for every other Blockscout consumer.
const TOKEN_BALANCE_CACHE_MS = 60_000;
const tokenBalanceCache = new Map<string, { at: number; tokens: WalletToken[] }>();

/**
 * Direct RPC probe for the two tokens known to matter (used only when
 * Blockscout is unreachable) — degrades to a partial, honestly-labeled view
 * rather than showing an empty wallet.
 */
async function fallbackTokenProbe(address: string): Promise<WalletToken[]> {
  const [plankHex, wethHex] = await ethCallMany([
    { to: CONTRACT_ADDRESS, data: balanceOfData(address) },
    { to: MARKET_OFFER_CURRENCY, data: balanceOfData(address) },
  ]).catch(() => [null, null] as (string | null)[]);
  const out: WalletToken[] = [];
  const plankWei = hexToDecString(plankHex);
  const wethWei = hexToDecString(wethHex);
  if (plankWei) {
    out.push({ symbol: "PLANK", name: "RobinWood", address: CONTRACT_ADDRESS, decimals: 18, valueWei: plankWei });
  }
  if (wethWei) {
    out.push({ symbol: "WETH", name: "Wrapped Ether", address: MARKET_OFFER_CURRENCY, decimals: 18, valueWei: wethWei });
  }
  return out;
}

/**
 * Every ERC-20 a wallet actually holds, not a fixed three-token probe — a
 * probe list is a guess, and USDG (3 tokens, never announced) went unseen on
 * the swap fee wallet because of exactly that guess. Falls back to the
 * direct RPC probe above if Blockscout fails and there's no cache to serve.
 */
async function fetchWalletTokens(
  address: string
): Promise<{ tokens: WalletToken[]; source: "blockscout" | "fallback" }> {
  const key = address.toLowerCase();
  const cached = tokenBalanceCache.get(key);
  if (cached && Date.now() - cached.at < TOKEN_BALANCE_CACHE_MS) {
    return { tokens: cached.tokens, source: "blockscout" };
  }
  try {
    const data = await fetchTokenBalances(address);
    const tokens: WalletToken[] = data
      .filter((entry) => entry.token?.type === "ERC-20" && entry.token.address_hash && entry.value)
      .map((entry) => ({
        symbol: entry.token?.symbol || "?",
        name: entry.token?.name || entry.token?.symbol || "Unknown token",
        address: entry.token?.address_hash as string,
        decimals: Number(entry.token?.decimals ?? "18") || 18,
        valueWei: entry.value as string,
      }));
    tokenBalanceCache.set(key, { at: Date.now(), tokens });
    return { tokens, source: "blockscout" };
  } catch {
    // Stale-but-real beats a guess — only fall back to the fixed probe when
    // there's genuinely nothing cached to serve.
    if (cached) return { tokens: cached.tokens, source: "blockscout" };
    return { tokens: await fallbackTokenProbe(address), source: "fallback" };
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
        label:
          "Swap fee wallet (Uniswap 0.4207% + 0x same-chain & cross-chain, both 0.42%)",
        address: SITE_FEE.recipient,
      },
      {
        key: "market-treasury",
        label: "Marketplank treasury (market + vault fees)",
        address: MARKET_FEE_RECIPIENT,
      },
    ];
    const vaults = listVaultsForDisplay();
    const vaultAddresses = new Set(vaults.map((v) => v.address.toLowerCase()));

    const [nativeResults, walletTokenResults, shareResults, poolStates] = await Promise.all([
      Promise.all(
        wallets.map((w) =>
          rpcCall<string>("eth_getBalance", [w.address, "latest"]).catch(
            () => null
          )
        )
      ),
      Promise.all(wallets.map((w) => fetchWalletTokens(w.address))),
      // Each vault contract is also its own ERC-20 share token, so a
      // wallet's share position in it is balanceOf(vault, wallet).
      ethCallMany(
        wallets.flatMap((w) =>
          vaults.map((v) => ({ to: v.address, data: balanceOfData(w.address) }))
        )
      ).catch(
        () =>
          wallets.flatMap(() => vaults.map(() => null)) as (string | null)[]
      ),
      Promise.all(
        vaults.map((v) =>
          readCoreVaultState(v.address, feeModelForVault(v.address)).catch(() => null)
        )
      ),
    ]);

    const walletBalances = wallets.map((w, i) => {
      const { tokens, source } = walletTokenResults[i];
      return {
        ...w,
        ethWei: hexToDecString(nativeResults[i]),
        // A vault's own share token also shows up in the generic Blockscout
        // list (it's a real ERC-20) — excluded here so it isn't counted
        // twice against the dedicated `shares` breakdown below.
        tokens: tokens.filter((t) => !vaultAddresses.has(t.address.toLowerCase())),
        tokensSource: source,
        shares: vaults.map((v, j) => ({
          vault: v.address,
          name: v.name,
          shareWei: hexToDecString(shareResults[i * vaults.length + j]),
        })),
      };
    });

    const pools = vaults.map((v, i) => {
      const core = poolStates[i];
      return {
        key: `vault-${v.role}-${v.generation}`,
        role: v.role,
        name: v.name,
        address: v.address,
        ethReserveWei: core ? core.ethReserveWei.toString() : null,
        shareReserveWei: core ? core.shareReserveWei.toString() : null,
        heldTokenCount: core ? core.heldTokenCount : null,
        poolOpen: core ? core.poolOpen : null,
      };
    });

    return publicJson({
      fetchedAt: new Date().toISOString(),
      // Renamed from `tokens` (2026-08-02) — collided with the per-wallet
      // `tokens` array added in the same change.
      knownTokens: {
        plank: CONTRACT_ADDRESS,
        weth: MARKET_OFFER_CURRENCY,
      },
      wallets: walletBalances,
      pools,
    });
  } catch (err) {
    return publicError(err, "Could not read treasury balances.");
  }
}
