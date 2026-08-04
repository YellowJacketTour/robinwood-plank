"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { isAddress, formatEther } from "ethers";
import { useRouter, useSearchParams } from "next/navigation";
import { useWallet } from "@/lib/wallet-context";

type PortfolioPosition = {
  vaultAddress: string;
  vaultName: string;
  vaultShortName: string;
  sharesHeldWei: string;
  costBasisWei: string;
  avgCostPerShareWei: string;
  realizedPnlWei: string;
  realizedProceedsWei: string;
  realizedCostWei: string;
  feeDragWei: string;
  unmatchedSharesWei: string;
  unmatchedProceedsWei: string;
  eventCount: number;
  updatedAt: string;
  currentNavPerShareWei: string;
  navSource: "live" | "unavailable";
  currentValueWei: string | null;
  unrealizedPnlWei: string | null;
};

type PortfolioResponse = {
  wallet: string;
  positions: PortfolioPosition[];
  note?: string;
  error?: string;
  message?: string;
};

// tsconfig targets ES2017, so `0n` literal syntax is a compile error — the
// rest of this codebase writes bigint constants as BigInt(...) for the same
// reason (see lib/market/vault.ts, lib/market/vault-stats.ts).
const ZERO = BigInt(0);

function fmtEth(wei: string | null | undefined, digits = 4): string {
  if (wei == null) return "—";
  try {
    const value = Number(formatEther(BigInt(wei)));
    return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  } catch {
    return "—";
  }
}

function pnlClass(wei: string | null | undefined): string {
  if (!wei) return "text-cream-muted";
  try {
    const v = BigInt(wei);
    if (v > ZERO) return "text-emerald-400";
    if (v < ZERO) return "text-rose-400";
    return "text-cream-muted";
  } catch {
    return "text-cream-muted";
  }
}

/**
 * Wallet portfolio PnL viewer. Reads /api/portfolio (precomputed
 * CohortPositions, see lib/market/portfolio-pnl.ts + scripts/refresh-market-data.ts's
 * "portfolio" step) — never recomputes anything client-side. Data-heavy /
 * app-style surface: mounts inside a `data-market-shell` boundary (see
 * DESIGN.md) so the marketing type clamps don't repaint the financial
 * figures gold/oversized.
 */
export default function PortfolioView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { address: connectedAddress } = useWallet();

  const initialWallet = searchParams.get("wallet") || "";
  const [input, setInput] = useState(initialWallet);
  const [wallet, setWallet] = useState(initialWallet);
  const [inputError, setInputError] = useState("");
  // One result slot tagged with the wallet it belongs to. Loading is DERIVED
  // from that tag (`result.wallet !== wallet`) rather than held in its own
  // state — a separate `setLoading(true)` in the effect body is a synchronous
  // setState inside an effect, which this repo's eslint config rejects
  // (react-hooks/set-state-in-effect). Tagging also means a stale response
  // for a previous wallet can never be rendered under a new one.
  const [result, setResult] = useState<{
    wallet: string;
    data: PortfolioResponse | null;
    error: string;
  } | null>(null);

  const loading = Boolean(wallet) && result?.wallet !== wallet;
  const data = result?.wallet === wallet ? result.data : null;
  const fetchError = result?.wallet === wallet ? result.error : "";

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    fetch(`/api/portfolio?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json()) as PortfolioResponse;
        if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`);
        return json;
      })
      .then((json) => {
        if (!cancelled) setResult({ wallet, data: json, error: "" });
      })
      .catch((err) => {
        if (!cancelled) {
          setResult({ wallet, data: null, error: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = input.trim();
    if (!isAddress(trimmed)) {
      setInputError("Enter a valid EVM wallet address.");
      return;
    }
    setInputError("");
    setWallet(trimmed);
    router.replace(`/portfolio?wallet=${encodeURIComponent(trimmed)}`);
  }

  // NOT a hook despite operating on state — deliberately not named `useX`.
  function applyConnectedWallet() {
    if (!connectedAddress) return;
    setInput(connectedAddress);
    setInputError("");
    setWallet(connectedAddress);
    router.replace(`/portfolio?wallet=${encodeURIComponent(connectedAddress)}`);
  }

  const totals = useMemo(() => {
    if (!data?.positions?.length) return null;
    let realized = ZERO;
    let unrealized = ZERO;
    let value = ZERO;
    let hasUnmatched = false;
    for (const p of data.positions) {
      realized += BigInt(p.realizedPnlWei);
      if (p.unrealizedPnlWei) unrealized += BigInt(p.unrealizedPnlWei);
      if (p.currentValueWei) value += BigInt(p.currentValueWei);
      if (BigInt(p.unmatchedSharesWei) > ZERO) hasUnmatched = true;
    }
    return { realized, unrealized, value, hasUnmatched };
  }, [data]);

  return (
    <div data-market-shell className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 lg:py-12">
      <div className="dense-card p-4 sm:p-6">
        <h1 className="font-display text-2xl text-gold-300 sm:text-3xl">Portfolio</h1>
        <p className="mt-1.5 text-sm text-cream-muted">
          Weighted-average cost basis and NAV-based value across every RobinWood vault, per wallet.
        </p>

        <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-2 sm:flex-row">
          <label htmlFor="portfolio-wallet" className="sr-only">
            Wallet address
          </label>
          <input
            id="portfolio-wallet"
            type="text"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setInputError("");
            }}
            placeholder="0x… wallet address"
            spellCheck={false}
            autoComplete="off"
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-wood-950 px-3 text-sm font-bold text-cream outline-none placeholder:text-cream-muted/60 focus:border-gold-300"
          />
          <button
            type="submit"
            className="min-h-11 shrink-0 rounded-lg border border-line-strong bg-gold-500 px-4 text-sm font-bold text-wood-950 transition hover:bg-gold-400"
          >
            View
          </button>
          {connectedAddress && (
            <button
              type="button"
              onClick={applyConnectedWallet}
              className="min-h-11 shrink-0 rounded-lg border border-line-strong px-4 text-sm font-bold text-gold-300 transition hover:border-gold-400"
            >
              Use connected wallet
            </button>
          )}
        </form>
        {inputError && (
          <p role="alert" className="mt-2 text-xs font-bold text-rose-400">
            {inputError}
          </p>
        )}
      </div>

      {!wallet && (
        <p className="mt-6 text-sm text-cream-muted">
          Enter a wallet address (or connect one) to see its vault positions.
        </p>
      )}

      {wallet && loading && <p className="mt-6 text-sm text-cream-muted">Loading positions…</p>}

      {wallet && !loading && fetchError && (
        <div className="dense-card mt-6 border border-rose-400/30 p-4">
          <p className="text-sm font-bold text-rose-400">Could not load this wallet&apos;s portfolio.</p>
          <p className="mt-1 text-xs text-cream-muted">{fetchError}</p>
        </div>
      )}

      {wallet && !loading && !fetchError && data && (
        <>
          {data.note && (
            <p className="mt-6 text-sm text-cream-muted">{data.note}</p>
          )}

          {data.positions.length === 0 && !data.note && (
            <p className="mt-6 text-sm text-cream-muted">
              No vault activity found for this wallet yet — positions are computed on a periodic
              refresh, so a very recent trade may not show up immediately.
            </p>
          )}

          {totals && (
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="dense-card p-4">
                <div className="text-[0.6875rem] font-black uppercase tracking-wide text-cream-muted">
                  Current value
                </div>
                <div className="mt-1 font-display text-xl text-gold-300">
                  {fmtEth(totals.value.toString())} ETH
                </div>
              </div>
              <div className="dense-card p-4">
                <div className="text-[0.6875rem] font-black uppercase tracking-wide text-cream-muted">
                  Realized PnL
                </div>
                <div className={`mt-1 font-display text-xl ${pnlClass(totals.realized.toString())}`}>
                  {fmtEth(totals.realized.toString())} ETH
                </div>
              </div>
              <div className="dense-card p-4">
                <div className="text-[0.6875rem] font-black uppercase tracking-wide text-cream-muted">
                  Unrealized PnL
                </div>
                <div className={`mt-1 font-display text-xl ${pnlClass(totals.unrealized.toString())}`}>
                  {fmtEth(totals.unrealized.toString())} ETH
                </div>
              </div>
            </div>
          )}

          {totals?.hasUnmatched && (
            <div className="dense-card mt-4 border border-gold-500/40 p-4">
              <p className="text-sm font-bold text-gold-300">Data gap in this wallet&apos;s history</p>
              <p className="mt-1 text-xs text-cream-muted">
                One or more positions include shares sold/redeemed that this cohort&apos;s tracked
                history never saw arrive (an earlier buy/deposit outside the indexed window, or a
                vault migration not reflected here). Their proceeds are shown separately below and
                are <span className="font-bold">excluded</span> from Realized PnL rather than
                counted as invented profit — see each vault row&apos;s &quot;Untracked shares&quot; line.
              </p>
            </div>
          )}

          <div className="mt-6 space-y-3">
            {data.positions.map((p) => (
              <div key={p.vaultAddress} className="dense-card p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-display text-lg text-gold-300">{p.vaultShortName}</h2>
                  <span className="text-[0.6875rem] font-black uppercase tracking-wide text-cream-muted">
                    {p.navSource === "live" ? "NAV live" : "NAV unavailable"}
                  </span>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-[0.6875rem] font-black uppercase tracking-wide text-cream-muted">
                      Shares held
                    </dt>
                    <dd className="mt-0.5 font-bold text-cream">{fmtEth(p.sharesHeldWei, 4)}</dd>
                  </div>
                  <div>
                    <dt className="text-[0.6875rem] font-black uppercase tracking-wide text-cream-muted">
                      Avg cost / share
                    </dt>
                    <dd className="mt-0.5 font-bold text-cream">{fmtEth(p.avgCostPerShareWei, 5)} ETH</dd>
                  </div>
                  <div>
                    <dt className="text-[0.6875rem] font-black uppercase tracking-wide text-cream-muted">
                      Current value
                    </dt>
                    <dd className="mt-0.5 font-bold text-cream">
                      {p.currentValueWei ? `${fmtEth(p.currentValueWei)} ETH` : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[0.6875rem] font-black uppercase tracking-wide text-cream-muted">
                      Unrealized PnL
                    </dt>
                    <dd className={`mt-0.5 font-bold ${pnlClass(p.unrealizedPnlWei)}`}>
                      {p.unrealizedPnlWei ? `${fmtEth(p.unrealizedPnlWei)} ETH` : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[0.6875rem] font-black uppercase tracking-wide text-cream-muted">
                      Realized PnL
                    </dt>
                    <dd className={`mt-0.5 font-bold ${pnlClass(p.realizedPnlWei)}`}>
                      {fmtEth(p.realizedPnlWei)} ETH
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[0.6875rem] font-black uppercase tracking-wide text-cream-muted">
                      Realized proceeds
                    </dt>
                    <dd className="mt-0.5 font-bold text-cream">{fmtEth(p.realizedProceedsWei)} ETH</dd>
                  </div>
                  <div>
                    <dt className="text-[0.6875rem] font-black uppercase tracking-wide text-cream-muted">
                      Fee drag
                    </dt>
                    <dd className="mt-0.5 font-bold text-cream">{fmtEth(p.feeDragWei)} ETH</dd>
                  </div>
                  <div>
                    <dt className="text-[0.6875rem] font-black uppercase tracking-wide text-cream-muted">
                      Events
                    </dt>
                    <dd className="mt-0.5 font-bold text-cream">{p.eventCount}</dd>
                  </div>
                </dl>

                {BigInt(p.unmatchedSharesWei) > ZERO && (
                  <div className="mt-3 rounded-md border border-gold-500/40 bg-wood-950/60 p-3">
                    <p className="text-xs font-black uppercase tracking-wide text-gold-300">
                      Untracked shares
                    </p>
                    <p className="mt-1 text-xs text-cream-muted">
                      {fmtEth(p.unmatchedSharesWei, 4)} shares sold/redeemed with no known cost basis
                      in this cohort&apos;s history — {fmtEth(p.unmatchedProceedsWei)} ETH of proceeds
                      excluded from Realized PnL above.
                    </p>
                  </div>
                )}

                <p className="mt-3 text-[0.6875rem] text-cream-muted">
                  Positions updated {new Date(p.updatedAt).toLocaleString()}.
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
