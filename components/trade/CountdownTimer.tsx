"use client";

import { useEffect, useState } from "react";
import { SNIPER_TRAP_MINUTES, TRADE_PAUSED } from "@/lib/constants";
import { getCountdownParts, getTradeOpensAt, type CountdownParts } from "@/lib/trade";
import { startVisibleInterval } from "@/lib/useVisibleInterval";

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

type Phase = "pre_lp" | "death_trap" | "cooldown_window" | "free" | "paused" | "unknown";

type Props = {
  onOpenChange?: (isOpen: boolean) => void;
  className?: string;
};

/**
 * Countdown synced to server clock via /api/trade/status.
 * When TRADE_PAUSED: shows STAND BY — widget never unlocks.
 */
export default function CountdownTimer({ onOpenChange, className = "" }: Props) {
  const [parts, setParts] = useState<CountdownParts>(() => getCountdownParts());
  const [skewMs, setSkewMs] = useState(0);
  const [phase, setPhase] = useState<Phase>(TRADE_PAUSED ? "paused" : "unknown");
  const [apiOpen, setApiOpen] = useState<boolean | null>(null);
  const [apiPaused, setApiPaused] = useState<boolean | null>(TRADE_PAUSED ? true : null);
  const [standByMsg, setStandByMsg] = useState<string | null>(
    TRADE_PAUSED ? "Trading is paused. Stand by." : null
  );

  useEffect(() => {
    let cancelled = false;
    async function sync() {
      try {
        const res = await fetch("/api/trade/status", { cache: "no-store" });
        const data = (await res.json()) as {
          serverNow?: string;
          isOpen?: boolean;
          paused?: boolean;
          message?: string;
          listingWindow?: { phase?: string };
        };
        if (cancelled) return;
        if (data.serverNow) {
          const serverNow = Date.parse(data.serverNow);
          if (!Number.isNaN(serverNow)) {
            setSkewMs(Date.now() - serverNow);
          }
        }
        if (typeof data.isOpen === "boolean") setApiOpen(data.isOpen);
        if (typeof data.paused === "boolean") setApiPaused(data.paused);
        if (typeof data.message === "string") setStandByMsg(data.message);
        const p = data.listingWindow?.phase;
        if (
          p === "pre_lp" ||
          p === "death_trap" ||
          p === "cooldown_window" ||
          p === "free" ||
          p === "paused"
        ) {
          setPhase(p);
        }
      } catch {
        /* keep local */
      }
    }
    sync();
    const stop = startVisibleInterval(() => void sync(), 12_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  useEffect(() => {
    const tick = () => {
      const correctedNow = Date.now() - skewMs;
      const next = getCountdownParts(correctedNow);
      const opens = getTradeOpensAt().getTime();
      if (Number.isNaN(opens)) {
        next.isOpen = false;
        next.totalMs = Number.MAX_SAFE_INTEGER;
      }
      // Server is source of truth for pause + lock
      if (apiPaused === true || TRADE_PAUSED) {
        next.isOpen = false;
        next.paused = true;
      } else if (apiOpen === false) {
        next.isOpen = false;
      }
      setParts(next);
      onOpenChange?.(false); // never unlock while paused path reports open
      if (!(apiPaused === true || TRADE_PAUSED || next.paused)) {
        onOpenChange?.(next.isOpen);
      } else {
        onOpenChange?.(false);
      }
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [onOpenChange, skewMs, apiOpen, apiPaused]);

  const paused = parts.paused || apiPaused === true || TRADE_PAUSED;

  if (paused) {
    return (
      <div
        className={`flex items-center justify-center gap-2 rounded-lg border border-orange-500/50 bg-[#2a1208]/95 px-3 py-2 text-center ${className}`}
        role="status"
        aria-live="polite"
      >
        <span className="font-display text-base text-gold-300">STAND BY</span>
        <span className="text-xs text-foreground/75">
          {standByMsg || "Not live yet."}
        </span>
      </div>
    );
  }

  // Open state needs no card of its own — the Uniswap module rendered
  // right below already carries the "trade is live" signal.
  if (parts.isOpen) return null;

  const cells = [
    { label: "D", full: "Days", value: pad(parts.days) },
    { label: "H", full: "Hours", value: pad(parts.hours) },
    { label: "M", full: "Mins", value: pad(parts.minutes) },
    { label: "S", full: "Secs", value: pad(parts.seconds) },
  ];

  const phaseBanner =
    phase === "death_trap"
      ? {
          title: "Death trap live",
          body: `LP may be live · ~${SNIPER_TRAP_MINUTES}m sniper window · early buys → Bad Boards`,
          tone: "border-orange-500/45 bg-[#3a1510]/85 text-orange-200",
        }
      : phase === "pre_lp"
        ? {
            title: "Pre-LP",
            body: "Wait for the timer — don't swap yet.",
            tone: "border-gold-500/30 bg-wood-900/90 text-foreground/75",
          }
        : null;

  return (
    <div
      className={`rounded-xl border border-gold-500/30 bg-wood-950/90 px-3 py-2.5 text-center sm:px-4 sm:py-3 ${className}`}
      role="timer"
      aria-live="polite"
      aria-atomic="true"
    >
      <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.25em] text-gold-300/90">
        Trade unlocks in
      </p>
      <div className="mt-2 grid grid-cols-4 gap-1.5 sm:mt-2.5 sm:gap-2">
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
      {phaseBanner && (
        <div
          className={`mt-2.5 rounded-lg border px-2.5 py-1.5 text-left text-[0.65rem] leading-snug sm:text-xs ${phaseBanner.tone}`}
        >
          <strong className="font-extrabold uppercase tracking-wide">
            {phaseBanner.title}
          </strong>
          <span className="opacity-90"> — {phaseBanner.body}</span>
        </div>
      )}
    </div>
  );
}
