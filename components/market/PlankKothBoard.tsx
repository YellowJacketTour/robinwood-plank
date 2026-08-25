"use client";

import { useEffect, useMemo, useState } from "react";
import { formatTokenAmount, shortAddress } from "@/lib/trade";
import { formatUsd } from "@/lib/eth-price";
import { usePlankKoth, type PlankKothBuy, type PlankKothLeaderboardRow } from "@/hooks/usePlankKoth";
import { useLiveEthUsd } from "@/hooks/useLiveEthUsd";
import { useTickDirection, type TickDirection } from "@/hooks/useTickDirection";
import { explorerTxUrl, explorerAddressUrl } from "@/lib/market/explorer-links";

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
function LiveUsd({ value, label }: { value: number | null; label: string }) {
  const direction = useTickDirection(value);
  if (value == null) return <span className="text-foreground/40">{"—"}</span>;
  return (
    <span className={`font-mono tabular-nums transition-colors duration-300 ${TICK_CLASS[direction]}`} title={label}>
      {formatUsd(value, value < 1 ? 6 : 2)}
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

  const target = state?.deadline ? Date.parse(state.deadline) : null;
  useEffect(() => {
    if (target == null) return;
    const update = () => setRemaining(getRemaining(target));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [target]);

  const displayLeader = state?.finalized ? state.winner : state?.leadingBuy;
  const leaderboard: PlankKothLeaderboardRow[] = useMemo(() => state?.leaderboard ?? [], [state?.leaderboard]);

  if (!state?.available) return null;

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-line bg-panel p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-gold-300">Season 2 · King of the Hill</p>
          <h2 className="mt-1 font-display text-xl font-bold text-foreground sm:text-2xl">
            Largest Single $PLANK Buy
          </h2>
        </div>
        <div className="text-right leading-tight" role="timer" aria-live="off">
          <p className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">
            {state.finalized ? "Winner locked in" : "Competition closes in"}
          </p>
          <p className="font-mono text-lg font-bold text-foreground sm:text-xl">
            {pad(remaining?.days)}d {pad(remaining?.hours)}h {pad(remaining?.minutes)}m {pad(remaining?.seconds)}s
          </p>
          {!state.finalized && remaining && remaining.days === 0 && remaining.hours < 2 && (
            <p className="text-[0.6rem] font-bold text-red-400">
              Final stretch — any new record buy extends the clock 4h
            </p>
          )}
        </div>
      </div>

      {/* Live price tick strip */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line-strong bg-wood-900/40 px-3 py-2 text-xs">
        <span className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${ethLive ? "bg-emerald-400" : "bg-foreground/30"}`} aria-hidden />
          <span className="text-foreground/55">ETH/USD</span>
          <LiveUsd value={ethUsd || null} label="Live ETH/USD, Coinbase ticker feed" />
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-foreground/55">$PLANK/USD</span>
          <LiveUsd value={plankUsd} label="Live $PLANK/USD from the canonical pool" />
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Current leading buy */}
        <div className="rounded-xl border border-line-strong bg-wood-900/30 p-3">
          <p className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/45">
            {state.finalized ? "Winning buy" : "Current leading buy"}
          </p>
          {displayLeader ? (
            <div className="mt-1.5 flex flex-col gap-1">
              <p className="font-display text-lg font-bold text-gold-300">
                {formatTokenAmount(displayLeader.plankAmount, 18, 2)} PLANK
              </p>
              <p className="text-sm text-foreground/80">
                {Number(displayLeader.ethPaidWei) > 0 ? (
                  <>
                    {formatTokenAmount(displayLeader.ethPaidWei, 18, 4)} ETH
                    {displayLeader.usdValueAtBuy != null && (
                      <span className="ml-1.5 text-foreground/50">{formatUsd(displayLeader.usdValueAtBuy)}</span>
                    )}
                  </>
                ) : (
                  displayLeader.usdValueAtBuy != null && (
                    <span>Paid in USDG · {formatUsd(displayLeader.usdValueAtBuy)}</span>
                  )
                )}
              </p>
              <p className="flex items-center gap-2 text-[0.68rem] text-foreground/55">
                <WalletLink wallet={displayLeader.wallet} />
                <BuyTxLink buy={displayLeader} />
              </p>
            </div>
          ) : (
            <p className="mt-1.5 text-sm text-foreground/50">No qualifying buy yet — be the first.</p>
          )}
        </div>

        {/* Prize */}
        <div className="rounded-xl border border-line-strong bg-wood-900/30 p-3">
          <p className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/45">
            Prize · {state.prize ? `${(state.prize.supplyFraction * 100).toFixed(5)}%` : ""} of total supply
          </p>
          {state.prize?.plankAmount ? (
            <div className="mt-1.5 flex flex-col gap-1">
              <p className="font-display text-lg font-bold text-gold-300">
                {formatTokenAmount(state.prize.plankAmount, 18, 0)} PLANK
              </p>
              <p className="text-sm">
                <LiveUsd value={state.prize.usdValue} label="Live prize USD value" />
              </p>
            </div>
          ) : (
            <p className="mt-1.5 text-sm text-foreground/50">Prize value unavailable right now.</p>
          )}
        </div>
      </div>

      {/* Tower of top buys */}
      <div>
        <p className="mb-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-foreground/45">
          Tower of top buys
        </p>
        {leaderboard.length === 0 ? (
          <p className="text-sm text-foreground/50">No confirmed buys yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line-strong">
            <table className="w-full text-left text-xs">
              <thead className="bg-wood-900/50 text-[0.6rem] uppercase tracking-wider text-foreground/45">
                <tr>
                  <th className="px-2.5 py-1.5">#</th>
                  <th className="px-2.5 py-1.5">Buyer</th>
                  <th className="px-2.5 py-1.5">$PLANK</th>
                  <th className="px-2.5 py-1.5">Value</th>
                  <th className="px-2.5 py-1.5">Tx</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((row, i) => (
                  <tr key={row.txHash} className="border-t border-line/60">
                    <td className="px-2.5 py-1.5 font-mono text-foreground/60">{i + 1}</td>
                    <td className="px-2.5 py-1.5">
                      <WalletLink wallet={row.wallet} />
                    </td>
                    <td className="px-2.5 py-1.5 font-mono tabular-nums text-foreground/85">
                      {formatTokenAmount(row.plankAmount, 18, 2)}
                    </td>
                    <td className="px-2.5 py-1.5 font-mono tabular-nums text-gold-300">
                      {row.usdValueAtBuy != null ? formatUsd(row.usdValueAtBuy) : "—"}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <BuyTxLink buy={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
