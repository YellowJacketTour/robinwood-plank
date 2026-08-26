"use client";

import { useEffect, useMemo, useState } from "react";
import { formatTokenAmount, shortAddress } from "@/lib/trade";
import { formatUsd } from "@/lib/eth-price";
import { usePlankKoth, type PlankKothBuy, type PlankKothLeaderboardRow } from "@/hooks/usePlankKoth";
import { useLiveEthUsd } from "@/hooks/useLiveEthUsd";
import { useTickDirection, type TickDirection } from "@/hooks/useTickDirection";
import { explorerTxUrl, explorerAddressUrl } from "@/lib/market/explorer-links";
import { formatPlankAmount, formatPlankUsdPrice, formatPlankFull } from "@/lib/plank-format";

type Remaining = { days: number; hours: number; minutes: number; seconds: number; complete: boolean };

function getRemaining(target: number): Remaining {
  const distance = Math.max(0, target - Date.now());
  return {
    days: Math.floor(distance / 86_400_000),
    hours: Math.floor((distance / 3_600_000) % 24),
    minutes: Math.floor((distance / 60_000) % 60),
    seconds: Math.floor((distance / 1_000) % 60),
    complete: distance === 0,
  };
}

function pad(n: number | undefined): string {
  return typeof n === "number" ? String(n).padStart(2, "0") : "—";
}

const TICK_CLASS: Record<TickDirection, string> = {
  up: "text-emerald-400",
  down: "text-red-400",
  flat: "text-foreground",
};

/** Small "$X.XX" span that genuinely flashes green/red on a real change and
 * settles back to the theme-neutral color when flat -- see
 * hooks/useTickDirection.ts's own header on the honesty constraint. */
function LiveUsd({ value, label, scientific }: { value: number | null; label: string; scientific?: boolean }) {
  const direction = useTickDirection(value);
  if (value == null) return <span className="text-foreground/40">{"—"}</span>;
  return (
    <span className={`font-mono tabular-nums transition-colors duration-300 ${TICK_CLASS[direction]}`} title={label}>
      {scientific ? formatPlankUsdPrice(value) : formatUsd(value)}
    </span>
  );
}

/** PLANK amounts on this dashboard range from a few tokens to trillions
 * (the prize alone is ~6.17T) -- always show the abbreviated K/M/B/T form
 * as the headline, with the real comma-grouped full number as a hover
 * tooltip so precision is never actually lost, just not force-fit into the
 * main line. */
function PlankAmount({ raw, className }: { raw: string; className?: string }) {
  const { abbreviated, full } = formatPlankAmount(raw);
  return (
    <span className={className} title={`${full} PLANK`}>
      {abbreviated}
    </span>
  );
}

function BuyTxLink({ buy }: { buy: PlankKothBuy }) {
  return (
    <a
      href={explorerTxUrl(buy.txHash)}
      target="_blank"
      rel="noreferrer noopener"
      className="font-mono text-[0.68rem] text-gold-300 underline decoration-dotted underline-offset-2 hover:text-gold-200"
      title="Inspect this transaction on the block explorer"
    >
      {shortAddress(buy.txHash)}
    </a>
  );
}

function WalletLink({ wallet }: { wallet: string | null }) {
  if (!wallet) return <span className="text-foreground/40">{"—"}</span>;
  return (
    <a
      href={explorerAddressUrl(wallet)}
      target="_blank"
      rel="noreferrer noopener"
      className="font-mono text-[0.7rem] text-foreground/75 underline decoration-dotted underline-offset-2 hover:text-foreground"
    >
      {shortAddress(wallet)}
    </a>
  );
}

/**
 * Season 2 $PLANK King of the Hill — live competition dashboard.
 *
 * Real, server-authoritative state from /api/market/plank-koth (lib/market/
 * plank-koth.ts, reusing king-of-the-hill-rules.ts's unmodified extend-on-
 * new-record engine) laid out per the operator's own spec: the current
 * leading buy (ETH amount + USD value), the prize (PLANK amount + live USD
 * value), a live ETH/USD + PLANK/USD tick strip with green/red/flat
 * coloring (see useLiveEthUsd.ts + useTickDirection.ts for the real,
 * honest data sources behind that), the "tower of top buys" leaderboard,
 * and a direct block-explorer link on every transaction.
 */
export default function PlankKothBoard() {
  const state = usePlankKoth();
  const { price: ethUsd, live: ethLive } = useLiveEthUsd();
  const plankUsd = state?.plankUsd ?? null;
  const [remaining, setRemaining] = useState<Remaining | null>(null);
  const [localLaunched, setLocalLaunched] = useState(false);

  const launchAt = state?.launchAt ? Date.parse(state.launchAt) : null;
  const deadline = state?.deadline ? Date.parse(state.deadline) : null;
  const launched = (state?.launched ?? false) || localLaunched;
  const target = launched ? deadline : launchAt;

  useEffect(() => {
    if (target == null) return;
    const update = () => {
      const r = getRemaining(target);
      setRemaining(r);
      if (!launched && r.complete) setLocalLaunched(true);
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [target, launched]);

  const displayLeader = state?.finalized ? state.winner : state?.leadingBuy;
  const leaderboard: PlankKothLeaderboardRow[] = useMemo(() => state?.leaderboard ?? [], [state?.leaderboard]);
  // Real ETH-equivalent of the live prize -- derived from the same real
  // USD value the server already computed (prize.usdValue) divided by the
  // live ETH/USD tick, not a second independent source, so it can never
  // disagree with the USD figure shown right next to it.
  const prizeEth = state?.prize?.usdValue != null && ethUsd > 0 ? state.prize.usdValue / ethUsd : null;

  if (!state?.available || target == null) return null;

  const isLive = launched && !state.finalized;
  const inFinalStretch = isLive && remaining != null && remaining.days === 0 && remaining.hours < 2;

  return (
    <div
      className={[
        "flex flex-col gap-4 overflow-hidden rounded-2xl border p-4 sm:p-6",
        inFinalStretch
          ? "border-red-500/60 bg-[linear-gradient(160deg,rgba(127,29,29,0.25),theme(colors.panel))] shadow-[0_0_40px_-12px_rgba(248,113,113,0.4)]"
          : "border-gold-500/40 bg-[linear-gradient(160deg,rgba(180,140,40,0.14),theme(colors.panel))]",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-gold-300">
            {isLive && (
              <span className="relative flex h-2 w-2" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
            )}
            Season 2 · King of the Hill {isLive && <span className="text-emerald-400">· LIVE</span>}
          </p>
          <h2 className="mt-1 font-display text-2xl font-bold text-foreground sm:text-3xl">
            Largest Single $PLANK Buy
          </h2>
        </div>
        <div className="text-right leading-tight" role="timer" aria-live="off">
          <p className="text-[0.62rem] font-bold uppercase tracking-wider text-foreground/45">
            {state.finalized ? "Winner locked in" : launched ? "Competition closes in" : "Launches in"}
          </p>
          <p
            className={[
              "font-mono text-2xl font-bold tabular-nums sm:text-3xl",
              inFinalStretch ? "text-red-400" : "text-foreground",
            ].join(" ")}
          >
            {pad(remaining?.days)}d {pad(remaining?.hours)}h {pad(remaining?.minutes)}m {pad(remaining?.seconds)}s
          </p>
          {inFinalStretch && (
            <p className="mt-0.5 text-[0.65rem] font-bold text-red-400">
              ⚠ Final stretch — any new record buy extends the clock 4h
            </p>
          )}
        </div>
      </div>

      {/* Live price tick strip */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line-strong bg-wood-900/50 px-4 py-2.5 text-sm">
        <span className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${ethLive ? "bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.6)]" : "bg-foreground/30"}`} aria-hidden />
          <span className="text-foreground/55">ETH/USD</span>
          <LiveUsd value={ethUsd || null} label="Live ETH/USD, Coinbase ticker feed" />
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-gold-400/70" aria-hidden />
          <span className="text-foreground/55">$PLANK/USD</span>
          <LiveUsd value={plankUsd} label="Live $PLANK/USD from the canonical pool" scientific />
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Current leading buy — the hero element */}
        <div className="relative overflow-hidden rounded-xl border border-gold-500/50 bg-[linear-gradient(150deg,rgba(180,140,40,0.18),rgba(0,0,0,0.15))] p-4">
          <p className="flex items-center gap-1.5 text-[0.68rem] font-bold uppercase tracking-wider text-gold-300">
            <span aria-hidden>👑</span> {state.finalized ? "Winning buy" : "Current leading buy"}
          </p>
          {displayLeader ? (
            <div className="mt-2 flex flex-col gap-1">
              <p className="font-display text-2xl font-bold text-gold-300">
                <PlankAmount raw={displayLeader.plankAmount} /> PLANK
              </p>
              <p className="text-base text-foreground/85">
                {Number(displayLeader.ethPaidWei) > 0 ? (
                  <>
                    {formatTokenAmount(displayLeader.ethPaidWei, 18, 4)} ETH
                    {displayLeader.usdValueAtBuy != null && (
                      <span className="ml-1.5 text-foreground/55">{formatUsd(displayLeader.usdValueAtBuy)}</span>
                    )}
                  </>
                ) : (
                  displayLeader.usdValueAtBuy != null && (
                    <span>Paid in USDG · {formatUsd(displayLeader.usdValueAtBuy)}</span>
                  )
                )}
              </p>
              <p className="flex items-center gap-2 text-[0.7rem] text-foreground/60">
                <WalletLink wallet={displayLeader.wallet} />
                <BuyTxLink buy={displayLeader} />
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-foreground/50">No qualifying buy yet — be the first.</p>
          )}
        </div>

        {/* Prize */}
        <div className="rounded-xl border border-line-strong bg-wood-900/30 p-4">
          <p className="flex items-center gap-1.5 text-[0.68rem] font-bold uppercase tracking-wider text-foreground/45">
            <span aria-hidden>🏆</span> Prize ·{" "}
            {state.prize ? `${(state.prize.supplyFraction * 100).toFixed(5)}%` : ""} of total supply
          </p>
          {state.prize?.plankAmount ? (
            <div className="mt-2 flex flex-col gap-1">
              <p className="font-display text-2xl font-bold text-gold-300">
                <PlankAmount raw={state.prize.plankAmount} /> PLANK
              </p>
              <p className="text-base">
                <LiveUsd value={state.prize.usdValue} label="Live prize USD value" />
                {prizeEth != null && (
                  <span className="ml-1.5 text-foreground/55">≈ {formatPlankFull(prizeEth, 3)} ETH</span>
                )}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-foreground/50">Prize value unavailable right now.</p>
          )}
        </div>
      </div>

      {/* Tower of top buys */}
      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-[0.68rem] font-bold uppercase tracking-wider text-foreground/45">
          <span aria-hidden>🗼</span> Tower of top buys
        </p>
        {leaderboard.length === 0 ? (
          <p className="rounded-lg border border-line-strong bg-wood-900/20 p-4 text-center text-sm text-foreground/50">
            No confirmed buys yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line-strong">
            <table className="w-full text-left text-xs">
              <thead className="bg-wood-900/60 text-[0.62rem] uppercase tracking-wider text-foreground/45">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Buyer</th>
                  <th className="px-3 py-2">$PLANK</th>
                  <th className="px-3 py-2">Value</th>
                  <th className="px-3 py-2">Tx</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((row, i) => {
                  const rankStyle =
                    i === 0
                      ? "border-t border-gold-500/50 bg-gold-500/10"
                      : i === 1
                        ? "border-t border-line/60 bg-foreground/[0.04]"
                        : i === 2
                          ? "border-t border-line/60 bg-orange-900/10"
                          : "border-t border-line/60";
                  const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : null;
                  return (
                    <tr key={row.txHash} className={rankStyle}>
                      <td className="px-3 py-2 font-mono text-foreground/70">{medal ?? i + 1}</td>
                      <td className="px-3 py-2">
                        <WalletLink wallet={row.wallet} />
                      </td>
                      <td className={`px-3 py-2 font-mono tabular-nums ${i === 0 ? "font-bold text-gold-300" : "text-foreground/85"}`}>
                        <PlankAmount raw={row.plankAmount} />
                      </td>
                      <td className={`px-3 py-2 font-mono tabular-nums ${i === 0 ? "font-bold text-gold-300" : "text-gold-300/85"}`}>
                        {row.usdValueAtBuy != null ? formatUsd(row.usdValueAtBuy) : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <BuyTxLink buy={row} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
