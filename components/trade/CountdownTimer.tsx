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
      <div className={`text-center ${className}`} role="status" aria-live="polite">
        <p className="text-xs font-extrabold uppercase tracking-[0.3em] text-forest-600">
          Community trade window
        </p>
        <p className="mt-2 font-display text-3xl text-gold-300 sm:text-4xl">OPEN</p>
        <p className="mt-2 text-sm text-foreground/70">Free trading is live. Buy the real $PLANK.</p>
      </div>
    );
  }

  const cells = [
    { label: "Days", value: pad(parts.days) },
    { label: "Hours", value: pad(parts.hours) },
    { label: "Mins", value: pad(parts.minutes) },
    { label: "Secs", value: pad(parts.seconds) },
  ];

  return (
    <div className={`text-center ${className}`} role="timer" aria-live="polite" aria-atomic="true">
      <p className="text-xs font-extrabold uppercase tracking-[0.3em] text-gold-300/80">
        Official trade unlocks in
      </p>
      <div className="mt-4 grid grid-cols-4 gap-2 sm:gap-3">
        {cells.map((c) => (
          <div
            key={c.label}
            className="rounded-xl border border-gold-500/30 bg-wood-950/80 px-2 py-3 sm:px-3 sm:py-4"
          >
            <div className="font-display text-2xl tabular-nums text-gold-300 sm:text-4xl">{c.value}</div>
            <div className="mt-1 text-[0.65rem] font-bold uppercase tracking-widest text-foreground/50">
              {c.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
