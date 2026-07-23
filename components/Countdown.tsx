"use client";

import { useEffect, useState } from "react";

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

export default function Countdown({ targetDate }: { targetDate?: string }) {
  const [remaining, setRemaining] = useState<Remaining | null>(null);
  const target = targetDate ? Date.parse(targetDate) : Number.NaN;

  useEffect(() => {
    if (!Number.isFinite(target)) return;
    const update = () => setRemaining(getRemaining(target));
    const initialUpdate = window.setTimeout(update, 0);
    const timer = window.setInterval(update, 1_000);
    return () => {
      window.clearTimeout(initialUpdate);
      window.clearInterval(timer);
    };
  }, [target]);

  if (!targetDate || !Number.isFinite(target)) return null;

  return (
    <div className="countdown wood-frame w-full max-w-3xl rounded-2xl bg-wood-950/95 p-5 sm:p-7">
      <p className="font-display text-2xl text-gold-300 sm:text-3xl">
        {remaining?.complete ? "Mint is live" : "Mint opens in"}
      </p>
      {!remaining?.complete && (
        <div className="mt-5 grid grid-cols-4 gap-2 sm:gap-4" role="timer" aria-live="off">
          {[
            ["Days", remaining?.days],
            ["Hours", remaining?.hours],
            ["Minutes", remaining?.minutes],
            ["Seconds", remaining?.seconds],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-xl border border-gold-500/40 bg-wood-900 p-3 sm:p-5">
              <strong className="block font-display text-3xl text-foreground sm:text-5xl">
                {typeof value === "number" ? String(value).padStart(2, "0") : "â€”"}
              </strong>
              <span className="mt-1 block text-xs font-black uppercase tracking-wide text-gold-300 sm:text-sm">
                {label}
              </span>
            </div>
          ))}
        </div>
      )}
      <time className="mt-4 block text-base font-extrabold text-foreground" dateTime={targetDate}>
        {new Intl.DateTimeFormat("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }).format(new Date(target))}
      </time>
    </div>
  );
}
