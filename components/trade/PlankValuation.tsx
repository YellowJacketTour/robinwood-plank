"use client";

import { useCallback, useEffect, useState } from "react";
import { CHAIN } from "@/lib/constants";
import { startVisibleInterval } from "@/lib/useVisibleInterval";
import {
  VALUATION_DIVERGENCE_WARN_PCT,
  formatCompactTokens,
  formatCompactUsd,
  formatTokenAmount,
} from "@/lib/plank-valuation";

type ValuationResponse = {
  basis: "fdv";
  fdvUsd: number | null;
  marketCapUsd: null;
  priceUsd: number;
  priceSource: string;
  totalSupply: number;
  totalSupplyRaw: string;
  burnAddressBalance: number;
  supplyRecipient: string;
  supplyRecipientBalance: number;
  supplyRecipientPct: number | null;
  crossCheck: {
    geckoterminalFdvUsd: number | null;
    geckoterminalMarketCapUsd: number | null;
    dexscreenerFdvUsd: number | null;
    geckoterminalDivergencePct: number | null;
    dexscreenerDivergencePct: number | null;
  };
  supplyFetchedAt: number;
  fetchedAt: number;
  stale: boolean;
};

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

function formatAsOf(timestamp: number | null | undefined): string {
  if (timestamp == null || !Number.isFinite(timestamp)) return "—";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * $PLANK's fully diluted valuation, and an explicit account of the supply it
 * is computed from.
 *
 * This panel exists because "market cap" is the number visitors ask for and
 * the number that is easiest to publish dishonestly. The full reasoning —
 * one constructor mint, ownership renounced, nothing burned, but 56.8% of
 * supply in a single UNLOCKED wallet — lives in lib/plank-valuation.ts. The
 * consequence for this component is a hard rule:
 *
 *   Never render the string "Market cap" against the FDV figure.
 *
 * Both third-party figures are shown next to ours rather than in place of
 * it, so the headline is verifiable on the page instead of asserted. The
 * concentration disclosure is not a footnote either: it is the single fact
 * an FDV number hides, so it renders at the same weight as the stats.
 *
 * Follows docs/TRADE_PAGE_SPEC.md §2 — the price behind this figure comes
 * from one pool, so the pool is named inline next to the number, not only in
 * a subtitle that can reflow away from it on mobile.
 */
export default function PlankValuation({ active = true }: { active?: boolean } = {}) {
  const [data, setData] = useState<ValuationResponse | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    return fetch("/api/trade/valuation")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json: ValuationResponse) => ({ ok: true as const, json }))
      .catch(() => ({ ok: false as const }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      load().then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setData(result.json);
          setError(false);
        } else {
          setError(true);
        }
      });
    };

    run();
    if (!active) return () => {
      cancelled = true;
    };

    // Price moves; supply does not. The 60s cadence here only refreshes the
    // price side — the supply read behind it is cached for six hours server
    // side (lib/plank-supply.ts), so this interval never reaches the chain.
    // startVisibleInterval (not a bare setInterval) so a backgrounded tab
    // stops entirely, per CONTRIBUTING.md "Chain reads and provider budget".
    const stop = startVisibleInterval(run, 60_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [active, load]);

  const isLoading = data == null && !error;
  const explorer = CHAIN.blockExplorers.default.url;

  const gtDivergence = data?.crossCheck.geckoterminalDivergencePct ?? null;
  const dsDivergence = data?.crossCheck.dexscreenerDivergencePct ?? null;
  const divergenceWarning =
    (gtDivergence != null && Math.abs(gtDivergence) > VALUATION_DIVERGENCE_WARN_PCT) ||
    (dsDivergence != null && Math.abs(dsDivergence) > VALUATION_DIVERGENCE_WARN_PCT);

  return (
    <div className="w-full min-w-0 space-y-2 rounded-xl border border-line bg-panel p-3">
      <div className="min-w-0">
        <p className="text-[0.76rem] font-black uppercase tracking-[0.06em] text-cream">
          $PLANK Valuation
        </p>
        <p className="text-[0.62rem] text-cream-muted">
          Fully diluted, not a circulating market cap — the supply behind the number is spelled out below
        </p>
      </div>

      {data?.stale && (
        <p className="w-fit rounded-md bg-[#8a6a1f]/25 px-2 py-1 text-[0.6rem] font-bold text-gold-300">
          Showing last known data — a live feed is temporarily unavailable
        </p>
      )}

      {error && data == null ? (
        <p className="rounded-lg border border-line bg-wood-950 px-3 py-6 text-center text-xs text-cream-muted">
          Could not load the $PLANK valuation.
        </p>
      ) : (
        <>
          {/* Headline. The label carries "FDV" and "fully diluted" together —
              "FDV" alone is jargon a first-time visitor can easily read as a
              synonym for market cap, which is the misreading this whole
              panel is built to prevent. */}
          <div className="rounded-lg border border-line bg-wood-950 px-3 py-2.5">
            <p className="text-[0.55rem] font-black uppercase tracking-[0.05em] text-cream-muted/70">
              FDV · Fully diluted valuation
            </p>
            {isLoading ? (
              <p className="text-2xl font-black leading-none text-cream-muted/40">···</p>
            ) : (
              <p className="text-2xl font-black leading-none tabular-nums text-gold-300">
                {formatCompactUsd(data?.fdvUsd)}
              </p>
            )}
            <p className="mt-1 text-[0.62rem] text-cream-muted">
              Total supply × the Uniswap v2 pool price (deepest of $PLANK&apos;s 5 pools)
            </p>
          </div>

          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            <StatTile
              label="Total supply"
              value={`${formatCompactTokens(data?.totalSupply)} PLANK`}
              note={data ? formatTokenAmount(data.totalSupply) : "—"}
            />
            <StatTile
              label="Burned"
              value={data ? formatCompactTokens(data.burnAddressBalance) : "—"}
              note="Nothing burned or sunk"
            />
            <StatTile
              label="Largest wallet"
              value={formatPct(data?.supplyRecipientPct)}
              note="of total supply, unlocked"
            />
          </div>

          {/* The disclosure. Deliberately not collapsed behind a tooltip:
              concentration is the fact an FDV figure conceals, so hiding it
              one interaction away would make the headline more trustworthy
              than the evidence supports. */}
          <div className="space-y-1 rounded-lg border border-line bg-wood-950 px-3 py-2">
            <p className="text-[0.55rem] font-black uppercase tracking-[0.05em] text-cream-muted/70">
              Why there is no market cap here
            </p>
            <p className="text-[0.66rem] leading-snug text-cream-muted">
              $PLANK&apos;s supply is fixed — the contract mints once in its constructor, has no
              mint function, is not upgradeable, and its owner has been renounced, so supply can
              only ever fall through burns. Nothing has been burned.{" "}
              {data?.supplyRecipientPct != null && (
                <>
                  But{" "}
                  <span className="font-bold text-cream">
                    {formatPct(data.supplyRecipientPct)} of supply
                  </span>{" "}
                  sits in the one wallet the constructor minted it to
                  {data.supplyRecipient && (
                    <>
                      {" "}
                      (
                      <a
                        href={`${explorer}/address/${data.supplyRecipient}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-bold text-gold-300 underline decoration-gold-500/40 underline-offset-2 hover:text-gold-200"
                      >
                        {shortAddress(data.supplyRecipient)} ↗
                      </a>
                      )
                    </>
                  )}
                  . That wallet is not a vesting, timelock, or LP-lock contract — those tokens are
                  freely transferable right now.
                </>
              )}{" "}
              A circulating market cap would mean subtracting supply that is provably locked, and
              none of it is, so we publish FDV and show you the concentration instead of quietly
              netting it out. GeckoTerminal reports no market cap for $PLANK for the same reason.
            </p>
            <p className="text-[0.6rem] text-cream-muted/70">
              Supply read on-chain from the $PLANK contract · as of {formatAsOf(data?.supplyFetchedAt)}
            </p>
          </div>

          {/* Cross-check against the two aggregators. Shown as data, not as a
              claim of agreement — if they ever diverge materially from our
              figure the panel says so rather than hiding it. */}
          <div className="space-y-1 rounded-lg border border-line bg-wood-950 px-3 py-2">
            <p className="text-[0.55rem] font-black uppercase tracking-[0.05em] text-cream-muted/70">
              Cross-check — same supply basis, independently computed
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.66rem] text-cream-muted">
              <span>
                Ours{" "}
                <span className="font-bold tabular-nums text-cream">
                  {formatCompactUsd(data?.fdvUsd)}
                </span>
              </span>
              <span>
                GeckoTerminal{" "}
                <span className="font-bold tabular-nums text-cream">
                  {formatCompactUsd(data?.crossCheck.geckoterminalFdvUsd)}
                </span>
              </span>
              <span>
                DexScreener{" "}
                <span className="font-bold tabular-nums text-cream">
                  {formatCompactUsd(data?.crossCheck.dexscreenerFdvUsd)}
                </span>
              </span>
            </div>
            {divergenceWarning ? (
              <p className="text-[0.6rem] font-bold text-[#fca5a5]">
                Our figure differs from a third party by more than{" "}
                {VALUATION_DIVERGENCE_WARN_PCT}% ({formatPct(gtDivergence, 2)} vs GeckoTerminal,{" "}
                {formatPct(dsDivergence, 2)} vs DexScreener) — treat all three as unreliable until
                that is explained.
              </p>
            ) : (
              <p className="text-[0.6rem] text-cream-muted/70">
                All three multiply the same total supply; small gaps are which pool and which
                second the price was quoted.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatTile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-line bg-wood-950 px-2 py-1.5">
      <p className="truncate text-[0.55rem] font-black uppercase tracking-[0.05em] text-cream-muted/70">
        {label}
      </p>
      <p className="truncate text-[0.72rem] font-black tabular-nums text-cream">{value}</p>
      <p className="truncate text-[0.55rem] text-cream-muted/70">{note}</p>
    </div>
  );
}
