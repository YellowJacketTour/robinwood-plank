"use client";

import { useCallback, useEffect, useState } from "react";
import { ExplorerAddress } from "../ExplorerAddress";
import { BUTTON_SECONDARY, CARD, LABEL } from "../ui";

/**
 * Finance section — read-only treasury dashboard, from /api/admin/finance.
 * A dashboard, not a wallet: nothing here signs or moves funds.
 *
 * Two different kinds of row (2026-08-02 rework, replacing a single shared
 * ETH/$PLANK/WETH column set that put "$PLANK 0.00" and "WETH 0.00" on every
 * pool row — a pool never holds either; it holds $PLANK NFTs and its own
 * share token):
 * - `wallets` — treasury/fee EOAs: ETH plus every ERC-20 the wallet actually
 *   holds (via Blockscout, not a fixed probe list — see the route), plus
 *   each wallet's share-token position in every configured vault.
 * - `pools` — every configured Instant Swap vault: ETH reserve, share
 *   reserve, and $PLANK NFTs held. Supersedes the old separate
 *   /api/market/treasury card, which only ever covered the primary vault.
 */

type Finance = {
  fetchedAt: string;
  knownTokens: { plank: string; weth: string };
  wallets: {
    key: string;
    label: string;
    address: string;
    ethWei: string | null;
    tokens: { symbol: string; name: string; address: string; decimals: number; valueWei: string }[];
    tokensSource: "blockscout" | "fallback";
    shares: { vault: string; name: string; shareWei: string | null }[];
  }[];
  pools: {
    key: string;
    role: string;
    name: string;
    address: string;
    ethReserveWei: string | null;
    shareReserveWei: string | null;
    heldTokenCount: number | null;
    poolOpen: boolean | null;
  }[];
};

/**
 * wei (decimal string) → display units with thousands separators.
 *
 * A genuinely non-zero balance must never render as flat zeros at `dp`
 * places — that reads as "nothing has ever landed here," which is the wrong
 * conclusion for e.g. 0.000032768904 ETH shown as "0.0000". Below the whole
 * unit, precision extends until a significant digit is visible (capped so
 * dust doesn't produce a wall of digits); an exact zero still reads as "0".
 */
function fromWei(wei: string | null | undefined, decimals = 18, dp = 4): string {
  if (!wei) return "—";
  try {
    const v = BigInt(wei);
    if (v === BigInt(0)) return "0";
    const base = BigInt(10) ** BigInt(decimals);
    const whole = v / base;
    const frac = v % base;
    const fullFrac = frac.toString().padStart(decimals, "0");
    if (whole > BigInt(0)) {
      return `${whole.toLocaleString()}.${fullFrac.slice(0, dp)}`;
    }
    const MAX_DP = 8;
    const window = fullFrac.slice(0, MAX_DP);
    const firstSig = window.search(/[1-9]/);
    if (firstSig === -1) return `< 0.${"0".repeat(MAX_DP - 1)}1`;
    const places = Math.min(Math.max(dp, firstSig + 2), MAX_DP);
    return `0.${fullFrac.slice(0, places)}`;
  } catch {
    return "—";
  }
}

// Read-only — ignores the shell's `address` prop.
export default function FinanceSection() {
  const [finance, setFinance] = useState<Finance | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/finance", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setFinance((await res.json()) as Finance);
      setFailed(false);
    } catch {
      setFinance(null);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-gold-300">Team finance</h2>
          <p className={`mt-1 ${LABEL}`}>
            On-chain treasury balances · read-only
          </p>
        </div>
        <button type="button" className={BUTTON_SECONDARY} onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {failed ? (
        <p className="mt-4 text-sm text-rose-400">
          Could not read balances — RPC may be unavailable. Retry.
        </p>
      ) : finance === null ? (
        <p className="mt-4 text-sm text-cream-muted">Reading the chain…</p>
      ) : (
        <>
          <p className={`mt-4 ${LABEL}`}>Fee wallets</p>
          <div className="mt-2 grid gap-3 lg:grid-cols-2">
            {finance.wallets.map((wallet) => (
              <div
                key={wallet.key}
                className="rounded-md border border-line bg-panel-strong p-3"
              >
                <h3 className="text-sm font-bold text-cream">{wallet.label}</h3>
                <p className="mt-1 break-all text-xs text-cream-muted">
                  <ExplorerAddress address={wallet.address} />
                </p>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <dt className={LABEL}>ETH</dt>
                    <dd className="mt-1 tabular-nums text-gold-300">
                      {fromWei(wallet.ethWei)}
                    </dd>
                  </div>
                  {wallet.tokens.map((t) => (
                    <div key={t.address}>
                      <dt className={LABEL}>{t.symbol}</dt>
                      <dd className="mt-1 tabular-nums text-gold-300">
                        {fromWei(t.valueWei, t.decimals, 2)}
                      </dd>
                    </div>
                  ))}
                </dl>
                {wallet.tokensSource === "fallback" ? (
                  <p className="mt-2 text-xs text-cream-muted">
                    Blockscout unreachable — showing $PLANK / WETH only, not a
                    full inventory.
                  </p>
                ) : null}
                {wallet.shares.some((s) => s.shareWei && s.shareWei !== "0") ? (
                  <dl className="mt-2 grid grid-cols-1 gap-1 border-t border-line pt-2 text-xs sm:grid-cols-2">
                    {wallet.shares.map((s) => (
                      <div key={s.vault} className="flex items-center justify-between gap-2">
                        <dt className="text-cream-muted">{s.name} shares</dt>
                        <dd className="tabular-nums text-gold-300">
                          {fromWei(s.shareWei, 18, 2)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
            ))}
          </div>

          <p className={`mt-4 ${LABEL}`}>Instant Swap pools</p>
          <div className="mt-2 grid gap-3 lg:grid-cols-2">
            {finance.pools.map((pool) => (
              <div
                key={pool.key}
                className="rounded-md border border-line bg-panel-strong p-3"
              >
                <h3 className="text-sm font-bold text-cream">
                  {pool.name}{" "}
                  <span className={`ml-1 ${LABEL}`}>
                    {pool.role === "primary" ? "primary" : "legacy — migrate out"}
                  </span>
                </h3>
                <p className="mt-1 break-all text-xs text-cream-muted">
                  <ExplorerAddress address={pool.address} />
                </p>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <dt className={LABEL}>ETH reserve</dt>
                    <dd className="mt-1 tabular-nums text-gold-300">
                      {fromWei(pool.ethReserveWei)}
                    </dd>
                  </div>
                  <div>
                    <dt className={LABEL}>Share reserve</dt>
                    <dd className="mt-1 tabular-nums text-gold-300">
                      {fromWei(pool.shareReserveWei, 18, 2)}
                    </dd>
                  </div>
                  <div>
                    <dt className={LABEL}>Planks held</dt>
                    <dd className="mt-1 tabular-nums text-gold-300">
                      {pool.heldTokenCount ?? "—"}
                    </dd>
                  </div>
                </dl>
                {pool.poolOpen === false ? (
                  <p className="mt-2 text-xs text-cream-muted">Pool not open.</p>
                ) : null}
              </div>
            ))}
          </div>

          <p className="mt-3 text-xs text-cream-muted">
            Fetched {new Date(finance.fetchedAt).toLocaleTimeString()} · $PLANK{" "}
            <ExplorerAddress address={finance.knownTokens.plank} short />
            {" "}· WETH{" "}
            <ExplorerAddress address={finance.knownTokens.weth} short />
          </p>
        </>
      )}
    </section>
  );
}
