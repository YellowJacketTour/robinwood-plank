"use client";

import { useEffect, useState } from "react";
import { SNIPER_TRAP_MINUTES, TRADE_PAUSED } from "@/lib/constants";
import { getCountdownParts, getTradeOpensAt, type CountdownParts } from "@/lib/trade";

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
    const syncId = window.setInterval(sync, 12_000);
    return () => {
      cancelled = true;
      window.clearInterval(syncId);
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
        className={`rounded-xl border border-orange-500/50 bg-[#2a1208]/95 px-3 py-4 text-center sm:px-4 ${className}`}
        role="status"
        aria-live="polite"
      >
        <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.28em] text-orange-300">
          Community notice
        </p>
        <p className="mt-1 font-display text-2xl text-gold-300 sm:text-3xl">STAND BY</p>
        <p className="mt-1.5 text-sm font-semibold text-orange-100/95">
          Trading is not live
        </p>
        <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-foreground/75">
          {standByMsg || "Wait for the all-clear on plank.love."}
        </p>
      </div>
    );
  }

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
        <p className="mt-0.5 text-xs text-foreground/70">
          Trade on Uniswap below.
        </p>
      </div>
    );
  }

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
            tone: "border-gold-500/30 bg-wood-900/80 text-foreground/75",
          }
        : null;

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
