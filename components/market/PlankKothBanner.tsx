"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { shortAddress } from "@/lib/trade";
import { formatUsd } from "@/lib/eth-price";
import { usePlankKoth } from "@/hooks/usePlankKoth";
import { formatPlankAmount } from "@/lib/plank-format";

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

/**
 * Season 2 "Biggest Buyer Board" — compact clickable banner for the
 * plank.love market page (replaces Season 1's EventCountdown in this same
 * slot). The full live dashboard (leading buy, live ticks, Board of
 * Biggest Buys, Fallen Champions) lives at /season2 -- this is a teaser
 * with just enough real, live-updating signal (countdown + current leader)
 * to earn the click, per the operator's own "banner takes you to the full
 * detail page with intelligence insights" direction.
 */
export default function PlankKothBanner() {
  const state = usePlankKoth();
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
  const prizeAmount = useMemo(
    () => (state?.prize?.plankAmount ? formatPlankAmount(state.prize.plankAmount) : null),
    [state?.prize?.plankAmount]
  );

  if (!state?.available || target == null) return null;

  const isLive = launched && !state.finalized;

  return (
    <Link
      href="/season2"
      className="group flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gold-500/40 bg-[linear-gradient(160deg,rgba(180,140,40,0.14),theme(colors.panel))] px-3 py-2.5 transition-colors hover:border-gold-400/70"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line-strong bg-wood-900 text-base">
          👑
        </div>
        <div className="min-w-0 leading-tight">
          <p className="flex items-center gap-1.5 truncate text-[0.72rem] font-bold text-gold-300">
            {isLive && (
              <span className="relative flex h-1.5 w-1.5" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
            )}
            Season 2 · Biggest Buyer Board
          </p>
          {launched && displayLeader ? (
            <p className="truncate text-[0.68rem] text-foreground/70">
              Leading: {formatPlankAmount(displayLeader.plankAmount).abbreviated} PLANK ·{" "}
              {displayLeader.usdValueAtBuy != null ? formatUsd(displayLeader.usdValueAtBuy) : "—"} ·{" "}
              {displayLeader.wallet ? shortAddress(displayLeader.wallet) : "—"}
            </p>
          ) : (
            <p className="truncate text-[0.68rem] text-foreground/55">
              {prizeAmount ? `Prize: ${prizeAmount.abbreviated} PLANK` : "Get ready"} — tap for the full board
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div className="text-right leading-tight" role="timer" aria-live="off">
          <p className="text-[0.55rem] font-bold uppercase tracking-wider text-foreground/45">
            {state.finalized ? "Closed" : launched ? "Closes in" : "Launches in"}
          </p>
          <p className="font-mono text-sm font-bold text-foreground">
            {pad(remaining?.days)}d {pad(remaining?.hours)}h {pad(remaining?.minutes)}m {pad(remaining?.seconds)}s
          </p>
        </div>
        <span className="text-gold-300 transition-transform group-hover:translate-x-0.5" aria-hidden>
          →
        </span>
      </div>
    </Link>
  );
}
