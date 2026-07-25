"use client";

import { useEffect, useState } from "react";
import { getCountdownParts, type CountdownParts } from "@/lib/trade";

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

type Props = {
  onOpenChange?: (isOpen: boolean) => void;
  className?: string;
};

export default function CountdownTimer({ onOpenChange, className = "" }: Props) {
  const [parts, setParts] = useState<CountdownParts>(() => getCountdownParts());

  useEffect(() => {
    const tick = () => {
      const next = getCountdownParts();
      setParts(next);
      onOpenChange?.(next.isOpen);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [onOpenChange]);

  if (parts.isOpen) {
    return (
      <div
        className={`rounded-xl border border-forest-600/50 bg-forest-900/70 px-3 py-3 text-center sm:px-4 ${className}`}
        role="status"
        aria-live="polite"
      >
        <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.25em] text-gold-300">
          Trade window
        </p>
        <p className="mt-0.5 font-display text-2xl text-gold-300 sm:text-3xl">OPEN</p>
        <p className="mt-0.5 text-xs text-foreground/70">Official widget live — swap here only.</p>
      </div>
    );
  }

  const cells = [
    { label: "D", full: "Days", value: pad(parts.days) },
    { label: "H", full: "Hours", value: pad(parts.hours) },
    { label: "M", full: "Mins", value: pad(parts.minutes) },
    { label: "S", full: "Secs", value: pad(parts.seconds) },
  ];

  return (
    <div
      className={`rounded-xl border border-gold-500/30 bg-wood-950/80 px-3 py-3 text-center sm:px-4 sm:py-4 ${className}`}
      role="timer"
      aria-live="polite"
      aria-atomic="true"
    >
      <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.25em] text-gold-300/90">
        Official trade unlocks in
      </p>
      <div className="mt-2 grid grid-cols-4 gap-1.5 sm:mt-3 sm:gap-2">
        {cells.map((c) => (
          <div
            key={c.full}
            className="rounded-lg border border-gold-500/25 bg-wood-900/90 px-1 py-2 sm:px-2 sm:py-2.5"
          >
            <div className="font-display text-xl tabular-nums leading-none text-gold-300 sm:text-3xl">
              {c.value}
            </div>
            <div className="mt-1 text-[0.6rem] font-bold uppercase tracking-wider text-foreground/50 sm:text-[0.65rem]">
              <span className="sm:hidden">{c.label}</span>
              <span className="hidden sm:inline">{c.full}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
