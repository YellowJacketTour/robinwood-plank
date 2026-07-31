"use client";

import { useCallback, useEffect, useState } from "react";
import { BUTTON_SECONDARY, CARD, LABEL } from "../ui";

/**
 * Finance section — read-only treasury dashboard. On-chain balances for the
 * two fee wallets (from /api/admin/finance) plus the vault treasury reading
 * the market already exposes (/api/market/treasury). A dashboard, not a
 * wallet: nothing here signs or moves funds.
 */

type Finance = {
  fetchedAt: string;
  tokens: { plank: string; weth: string };
  balances: {
    key: string;
    label: string;
    address: string;
    ethWei: string | null;
    plankWei: string | null;
    wethWei: string | null;
  }[];
};

type Treasury = {
  source: string;
  treasury: string;
  balanceWei?: string;
  open?: boolean;
};

/** wei (decimal string) → display units with thousands separators. */
function fromWei(wei: string | null | undefined, decimals = 18, dp = 4): string {
  if (!wei) return "—";
  try {
    const v = BigInt(wei);
    const base = BigInt(10) ** BigInt(decimals);
    const whole = v / base;
    const frac = v % base;
    const fracStr = (base + frac).toString().slice(1, 1 + dp);
    return `${whole.toLocaleString()}.${fracStr}`;
  } catch {
    return "—";
  }
}

// Read-only — ignores the shell's `address` prop.
export default function FinanceSection() {
  const [finance, setFinance] = useState<Finance | null>(null);
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [financeRes, treasuryRes] = await Promise.all([
        fetch("/api/admin/finance", { cache: "no-store" }),
        fetch("/api/market/treasury", { cache: "no-store" }),
      ]);
      if (!financeRes.ok) throw new Error();
      setFinance((await financeRes.json()) as Finance);
      setTreasury(
        treasuryRes.ok ? ((await treasuryRes.json()) as Treasury) : null
      );
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
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {finance.balances.map((wallet) => (
              <div
                key={wallet.key}
                className="rounded-md border border-line bg-panel-strong p-3"
              >
                <h3 className="text-sm font-bold text-cream">{wallet.label}</h3>
                <p className="mt-1 break-all font-mono text-xs text-cream-muted">
                  {wallet.address}
                </p>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <dt className={LABEL}>ETH</dt>
                    <dd className="mt-1 tabular-nums text-gold-300">
                      {fromWei(wallet.ethWei)}
                    </dd>
                  </div>
                  <div>
                    <dt className={LABEL}>$PLANK</dt>
                    <dd className="mt-1 tabular-nums text-gold-300">
                      {fromWei(wallet.plankWei, 18, 2)}
                    </dd>
                  </div>
                  <div>
                    <dt className={LABEL}>WETH</dt>
                    <dd className="mt-1 tabular-nums text-gold-300">
                      {fromWei(wallet.wethWei)}
                    </dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>

          {treasury ? (
            <div className="mt-3 rounded-md border border-line bg-panel-strong p-3">
              <h3 className="text-sm font-bold text-cream">
                Vault treasury{" "}
                <span className={`ml-1 ${LABEL}`}>
                  {treasury.source === "vault"
                    ? "V2 vault ETH reserve"
                    : "fee-recipient fallback"}
                </span>
              </h3>
              <p className="mt-1 break-all font-mono text-xs text-cream-muted">
                {treasury.treasury}
              </p>
              <p className="mt-2 tabular-nums text-gold-300">
                {fromWei(treasury.balanceWei)} ETH
                {treasury.open === false ? (
                  <span className="ml-2 text-xs text-cream-muted">
                    (pool not open)
                  </span>
                ) : null}
              </p>
            </div>
          ) : null}

          <p className="mt-3 text-xs text-cream-muted">
            Fetched {new Date(finance.fetchedAt).toLocaleTimeString()} · $PLANK{" "}
            <span className="font-mono">{finance.tokens.plank.slice(0, 10)}…</span>{" "}
            · WETH{" "}
            <span className="font-mono">{finance.tokens.weth.slice(0, 10)}…</span>
          </p>
        </>
      )}
    </section>
  );
}
