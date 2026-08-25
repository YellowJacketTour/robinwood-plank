"use client";

import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

export type HydrationPlankChipProps = {
  /** True while a real mesh job is processing this collection */
  active?: boolean;
  /** Bump when a real hydrate/archive write completes -- drives one pulse */
  pulseKey?: string | number | null;
  /** Optional compact label for SR; visual is decorative */
  label?: string;
  className?: string;
};

/**
 * Tiny wood "plank" indicator for rankings rows.
 * Motion is event-driven only (active / pulseKey). Never decorative-loop.
 *
 * Verbatim from docs/marketplank/GROK-FINDINGS-immersive-hydration-
 * visualization-2026-08-25.md ("Rankings row: physical plank chip").
 */
export function HydrationPlankChip({
  active = false,
  pulseKey = null,
  label = "Hydration activity",
  className = "",
}: HydrationPlankChipProps) {
  const reduced = usePrefersReducedMotion();
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (reduced || pulseKey == null || pulseKey === "") return;
    setPulse(true);
    const t = window.setTimeout(() => setPulse(false), 700);
    return () => window.clearTimeout(t);
  }, [pulseKey, reduced]);

  return (
    <span
      className={[
        "relative inline-flex h-3.5 w-5 shrink-0 items-center justify-center",
        "rounded-[2px] border border-amber-900/40",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_1px_2px_rgba(0,0,0,0.35)]",
        // procedural-ish grain via layered gradients (no image fetch)
        "bg-[linear-gradient(90deg,rgba(0,0,0,0.12)_1px,transparent_1px),linear-gradient(180deg,#8b5a2b_0%,#a67c52_35%,#6b4226_70%,#4a2c14_100%)]",
        "bg-[length:3px_100%,100%_100%]",
        !reduced && active ? "animate-plank-glow" : "",
        !reduced && pulse ? "animate-plank-flip" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label={
        active
          ? `${label}: processing`
          : pulse
            ? `${label}: updated`
            : `${label}: idle`
      }
      data-active={active ? "true" : "false"}
      data-pulse={pulse ? "true" : "false"}
    >
      {/* specular edge -- pure CSS, no WebGL */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-100/50 to-transparent"
      />
    </span>
  );
}
