"use client";

import { useEffect, useState } from "react";
import { SNIPER_TRAP_MINUTES } from "@/lib/constants";
import { getCountdownParts, getTradeOpensAt, type CountdownParts } from "@/lib/trade";

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

type Phase = "pre_lp" | "death_trap" | "cooldown_window" | "free" | "unknown";

type Props = {
  onOpenChange?: (isOpen: boolean) => void;
  className?: string;
};

/**
 * Countdown synced to server clock via /api/trade/status to avoid client clock skew
 * unlocking the UI while the API is still TRADE_LOCKED (or vice versa).
 * Shows launch phase: pre-LP → death trap → OPEN.
 */
export default function CountdownTimer({ onOpenChange, className = "" }: Props) {
  const [parts, setParts] = useState<CountdownParts>(() => getCountdownParts());
  /** clientNow - serverNow; positive means client is ahead */
  const [skewMs, setSkewMs] = useState(0);
  const [phase, setPhase] = useState<Phase>("unknown");
  const [apiOpen, setApiOpen] = useState<boolean | null>(null);
  const [apiReady, setApiReady] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function sync() {
      try {
        const res = await fetch("/api/trade/status", { cache: "no-store" });
        const data = (await res.json()) as {
          serverNow?: string;
          opensAt?: string;
          isOpen?: boolean;
          tradingApiConfigured?: boolean;
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
        if (typeof data.tradingApiConfigured === "boolean") {
          setApiReady(data.tradingApiConfigured);
        }
        const p = data.listingWindow?.phase;
        if (
          p === "pre_lp" ||
          p === "death_trap" ||
          p === "cooldown_window" ||
          p === "free"
        ) {
          setPhase(p);
        }
      } catch {
        // Keep local clock if status fails; API still enforces lock.
      }
    }
    sync();
    const syncId = window.setInterval(sync, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(syncId);
    };
  }, []);

  useEffect(() => {
    const tick = () => {
      // Correct client clock toward server time
      const correctedNow = Date.now() - skewMs;
      const next = getCountdownParts(correctedNow);
      // Fail closed: if opensAt is invalid, stay locked
      const opens = getTradeOpensAt().getTime();
      if (Number.isNaN(opens)) {
        next.isOpen = false;
        next.totalMs = Number.MAX_SAFE_INTEGER;
      }
      // Prefer server isOpen when available (API is source of truth for unlock)
      if (apiOpen === false) {
        next.isOpen = false;
      } else if (apiOpen === true && next.isOpen) {
        next.isOpen = true;
      }
      setParts(next);
      onOpenChange?.(next.isOpen);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [onOpenChange, skewMs, apiOpen]);

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
          Official widget live — swap here only.
          {apiReady === false ? " · API key missing on server." : ""}
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
          body: `LP may be live · widget locked · ~${SNIPER_TRAP_MINUTES}m sniper window · off-site = Bad Boards`,
          tone: "border-orange-500/45 bg-[#3a1510]/85 text-orange-200",
        }
      : phase === "pre_lp"
        ? {
            title: "Pre-LP",
            body: "Community waits for the timer. Do not use Uniswap.app.",
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
      {apiReady === false && (
        <p className="mt-1.5 text-[0.65rem] text-red-300">
          Trading API not configured on server — set UNISWAP_API_KEY before open.
        </p>
      )}
    </div>
  );
}
