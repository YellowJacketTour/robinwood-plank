"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatUsd } from "@/lib/eth-price";
import { useLiveEthUsd } from "@/hooks/useLiveEthUsd";
import { useTickDirection, type TickDirection } from "@/hooks/useTickDirection";
import { formatPlankAmount, formatPlankUsdPrice, formatEthFixed } from "@/lib/plank-format";
import { swrJson } from "@/lib/market/swr-fetch";

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

type FinancialsResponse = {
  available: boolean;
  launchAt?: string;
  deadline?: string;
  launched?: boolean;
  prize?: { supplyFraction: number; plankAmount: string | null; usdValue: number | null; plankEth: number | null };
  plankUsd?: number | null;
};

function usePlankKothFinancials(): FinancialsResponse | null {
  const [state, setState] = useState<FinancialsResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    async function poll() {
      try {
        const data = await swrJson<FinancialsResponse>("/api/market/plank-koth-financials", {
          ttlMs: 3_000,
          swrMs: 15_000,
          session: true,
        });
        if (!cancelled) setState(data);
      } catch {
        // Keep last good state on a transient failure.
      }
      if (!cancelled) timer = window.setTimeout(poll, 3_000);
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);
  return state;
}

const TICK_CLASS: Record<TickDirection, string> = {
  up: "text-emerald-400",
  down: "text-red-400",
  flat: "text-foreground",
};

/**
 * Season 2 "Biggest Buyer Board" — financials-only banner.
 *
 * Production-safe subset: shows the real countdown (pre-launch, then the
 * real 31-day competition window) and the real, live prize amount/value
 * (PLANK + live USD + live ETH, all genuinely wired to the same live ETH/
 * USD WebSocket tick as the full dashboard -- see PlankKothBoard.tsx's
 * own header on why USD/ETH share one tick-direction signal). Does NOT
 * show a live leading-buy or leaderboard -- that requires the mesh-tick
 * job scheduler + fraud-gate pipeline (lib/market/plank-koth-watch.ts),
 * which this deployment does not yet run. This banner has zero
 * dependency on that backend or on Postgres beyond what getPlankSupply/
 * getPlankPoolStats already use elsewhere in this app.
 */
export default function PlankKothFinancialsBanner() {
  const state = usePlankKothFinancials();
  const { price: ethUsd, live: ethLive } = useLiveEthUsd();
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

  const prizeEth = state?.prize?.plankEth ?? null;
  const prizeUsdLive = prizeEth != null && ethUsd > 0 ? prizeEth * ethUsd : (state?.prize?.usdValue ?? null);
  const prizeDirection = useTickDirection(ethUsd || null);
  const prizeAmount = useMemo(
    () => (state?.prize?.plankAmount ? formatPlankAmount(state.prize.plankAmount) : null),
    [state?.prize?.plankAmount]
  );

  if (!state?.available || target == null) return null;

  return (
    <Link
      href="/season2"
      className="group flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gold-500/40 bg-[linear-gradient(160deg,rgba(180,140,40,0.14),theme(colors.panel))] px-4 py-3 transition-colors hover:border-gold-400/70"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="flex items-center gap-1.5 text-[0.72rem] font-bold text-gold-300">
          <span aria-hidden>🏆</span> Season 2 · Biggest Buyer Board
        </p>
        {prizeAmount ? (
          <p className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
            <span className="font-display font-bold text-gold-300" title={`${prizeAmount.full} PLANK`}>
              {prizeAmount.abbreviated} PLANK
            </span>
            <span
              className={`font-mono tabular-nums transition-colors duration-300 ${TICK_CLASS[prizeDirection]}`}
            >
              {prizeUsdLive != null ? formatUsd(prizeUsdLive) : "—"}
            </span>
            {prizeEth != null && (
              <span
                className={`font-mono text-[0.8em] tabular-nums transition-colors duration-300 ${TICK_CLASS[prizeDirection]}`}
              >
                ≈ {formatEthFixed(prizeEth, 3)} ETH
              </span>
            )}
          </p>
        ) : (
          <p className="text-[0.68rem] text-foreground/55">Prize value loading…</p>
        )}
        <p className="flex items-center gap-2 text-[0.6rem] text-foreground/45">
          <span className="flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${ethLive ? "bg-emerald-400" : "bg-foreground/30"}`} aria-hidden />
            ETH/USD {formatUsd(ethUsd || 0)}
          </span>
          <span>· $PLANK/USD {formatPlankUsdPrice(state.plankUsd)}</span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div className="text-right leading-tight" role="timer" aria-live="off">
          <p className="text-[0.55rem] font-bold uppercase tracking-wider text-foreground/45">
            {launched ? "Closes in" : "Launches in"}
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
