"use client";

import { useEffect, useState } from "react";

/** 8/4/26 — assumed UTC midnight; adjust if a specific timezone was meant. */
const TARGET_ISO = "2026-08-04T00:00:00Z";

type Remaining = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  complete: boolean;
};

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

function pad(n: number | undefined) {
  return typeof n === "number" ? String(n).padStart(2, "0") : "—";
}

/**
 * Compact event countdown for the Buy & Sell / Activity tab headers —
 * TODO: the specific event feature/name wasn't fully specified ("features
 * the king of the...", message cut off), so this reads generically as
 * "Special event" until that's confirmed. Same remaining-time math as
 * components/Countdown.tsx (the big mint-hero card) but sized for a tab
 * strip instead of a full section.
 */
export default function EventCountdown() {
  const target = Date.parse(TARGET_ISO);
  const [remaining, setRemaining] = useState<Remaining | null>(null);

  useEffect(() => {
    const update = () => setRemaining(getRemaining(target));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [target]);

  if (remaining?.complete) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gold-500/30 bg-wood-900/70 px-3 py-2">
      <p className="text-xs font-bold uppercase tracking-wide text-gold-300">Special event</p>
      <div className="flex items-center gap-1.5 font-mono text-sm text-foreground" role="timer" aria-live="off">
        <span>{pad(remaining?.days)}d</span>
        <span className="text-foreground/40">:</span>
        <span>{pad(remaining?.hours)}h</span>
        <span className="text-foreground/40">:</span>
        <span>{pad(remaining?.minutes)}m</span>
        <span className="text-foreground/40">:</span>
        <span>{pad(remaining?.seconds)}s</span>
      </div>
    </div>
  );
}
