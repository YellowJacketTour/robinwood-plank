"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
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
 * Large, warm, front-and-center promotion for Season 2's "Biggest Buyer
 * Board" on the plank.love landing page itself -- owner directive: people
 * should be able to land on the homepage and instantly see the live
 * competition and one-click through to the full detail page (/season2),
 * not only discover it via the compact Nav-adjacent PlankKothBanner
 * elsewhere in the app (that one stays a minimal teaser by its own
 * design; this is deliberately the opposite -- the loudest, warmest
 * invitation on the page).
 *
 * Real, live-server state only (usePlankKoth, the same source every other
 * KOTH surface reads) -- never a static "there's a contest!" placeholder
 * that could contradict the real launched/finalized state.
 *
 * Mobile-layout discipline matches the fix already shipped for
 * PlankKothBanner.tsx tonight: nothing here truncates against a
 * non-shrinking sibling. Every line gets to wrap onto its own row on a
 * narrow viewport; the compact single-row layout only applies once
 * there's genuinely enough width for it.
 */
export default function PlankKothLandingBanner() {
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
  const prizeAmount = state?.prize?.plankAmount ? formatPlankAmount(state.prize.plankAmount) : null;

  if (!state?.available || target == null) return null;

  const isLive = launched && !state.finalized;

  return (
    <section className="px-3 pt-6 sm:px-5 sm:pt-8">
      <div className="site-shell">
        <Link
          href="/season2"
          className="group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-gold-500/50 bg-[linear-gradient(155deg,rgba(180,140,40,0.22),rgba(20,16,11,0.4)_55%,theme(colors.panel))] p-5 shadow-[0_0_60px_-20px_rgba(217,164,65,0.5)] transition-colors hover:border-gold-400/80 sm:p-7 lg:flex-row lg:items-center lg:justify-between lg:gap-6"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_15%,rgba(217,164,65,0.18),transparent_55%)]"
          />
          <div className="relative flex min-w-0 flex-1 items-start gap-3.5 sm:gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-gold-500/40 bg-wood-950/70 text-2xl sm:h-14 sm:w-14 sm:text-3xl">
              🏆
            </div>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.7rem] font-bold uppercase tracking-widest text-gold-300 sm:text-xs">
                {isLive && (
                  <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                  </span>
                )}
                Season 2 {isLive && <span className="text-emerald-400">· LIVE now</span>}
              </p>
              <h2 className="mt-1 font-display text-xl font-bold text-foreground sm:text-2xl lg:text-[1.7rem]">
                The Biggest Buyer Board
              </h2>
              <p className="mt-1 max-w-md text-sm text-foreground/70 sm:text-[0.95rem]">
                {launched
                  ? "Make the single largest $PLANK buy of the season and take home the prize pool."
                  : "The largest single $PLANK buy of the season wins the prize pool — get ready."}
              </p>
              {launched && displayLeader && (
                <p className="mt-2 text-[0.8rem] text-foreground/60 sm:text-sm">
                  Current leader:{" "}
                  <span className="font-semibold text-gold-300">
                    {formatPlankAmount(displayLeader.plankAmount).abbreviated} PLANK
                  </span>
                  {displayLeader.usdValueAtBuy != null && (
                    <span className="text-foreground/50"> ({formatUsd(displayLeader.usdValueAtBuy)})</span>
                  )}
                </p>
              )}
            </div>
          </div>

          <div className="relative flex shrink-0 flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-5 lg:items-end lg:gap-4">
            <div className="flex w-full items-center justify-between gap-4 sm:w-auto sm:justify-start sm:gap-5">
              {prizeAmount && (
                <div className="leading-tight">
                  <p className="text-[0.62rem] font-bold uppercase tracking-wider text-foreground/45">Prize</p>
                  <p className="font-mono text-base font-bold text-gold-300 sm:text-lg">
                    {prizeAmount.abbreviated} PLANK
                  </p>
                </div>
              )}
              <div className="text-right leading-tight sm:text-left" role="timer" aria-live="off">
                <p className="text-[0.62rem] font-bold uppercase tracking-wider text-foreground/45">
                  {state.finalized ? "Closed" : launched ? "Closes in" : "Launches in"}
                </p>
                <p className="font-mono text-base font-bold tabular-nums text-foreground sm:text-lg">
                  {pad(remaining?.days)}d {pad(remaining?.hours)}h {pad(remaining?.minutes)}m {pad(remaining?.seconds)}s
                </p>
              </div>
            </div>
            <span className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-gold-500/50 bg-gold-500/10 px-4 py-2 text-sm font-bold text-gold-200 transition-colors group-hover:bg-gold-500/20 sm:w-auto">
              View the competition
              <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </span>
          </div>
        </Link>
      </div>
    </section>
  );
}
