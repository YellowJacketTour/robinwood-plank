"use client";

import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

export type ArchivalDepthBarProps = {
  /** 0..1 when score_method is supply_ratio; null if unknown */
  archivalScore: number | null;
  scoreMethod: "supply_ratio" | "hits_only" | "unknown_supply" | string;
  tokensEverHydrated?: number | null;
  knownSupply?: number | null;
  /** Real event: score increased -- triggers fill emphasis once */
  pulseKey?: string | number | null;
  /** Thin, label-less inline variant for a rankings row -- same real fill
   * width + glow-on-update motion as the full detail-page bar, just sized
   * to sit next to a collection name instead of stacking a whole section.
   * Woven onto every row with a known score (2026-08-25, "live time motion
   * and visual effect progress bar for any and all collections") so the
   * whole rankings table reflects real backend hydration progress live,
   * not just the one collection a visitor has open. */
  compact?: boolean;
  className?: string;
};

/**
 * Wood-textured archive depth bar.
 * Accessible text always present; motion is optional decoration only.
 *
 * Verbatim from docs/marketplank/GROK-FINDINGS-immersive-hydration-
 * visualization-2026-08-25.md ("Detail page: archival depth bar").
 */
export function ArchivalDepthBar({
  archivalScore,
  scoreMethod,
  tokensEverHydrated = null,
  knownSupply = null,
  pulseKey = null,
  compact = false,
  className = "",
}: ArchivalDepthBarProps) {
  const reduced = usePrefersReducedMotion();
  const known = scoreMethod === "supply_ratio" && archivalScore != null;
  const pct = known
    ? Math.max(0, Math.min(100, Math.round(archivalScore * 100)))
    : null;

  const summary =
    known && knownSupply != null && tokensEverHydrated != null
      ? `Archive depth ${pct}% - ${tokensEverHydrated.toLocaleString()} of ${knownSupply.toLocaleString()} tokens stored`
      : tokensEverHydrated != null
        ? `Archive depth - ${tokensEverHydrated.toLocaleString()} tokens stored - supply unknown`
        : "Archive depth - not yet measured";

  if (compact) {
    // Nothing to show for a genuinely unmeasured collection -- never a
    // fabricated empty bar implying 0% when the real answer is "unknown".
    if (!known) return null;
    return (
      <span
        className={["inline-flex h-1.5 w-10 shrink-0 items-center", className].join(" ")}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={summary}
        aria-label={summary}
        title={summary}
      >
        <span
          className={[
            "relative h-1 w-full overflow-hidden rounded-full",
            "bg-[linear-gradient(180deg,#3d2412,#5c3a1e)]",
          ].join(" ")}
        >
          <span
            key={pulseKey ?? "fill"}
            className={[
              "absolute inset-y-0 left-0 rounded-full",
              "bg-[linear-gradient(90deg,#c4a574,#8b5a2b)]",
              !reduced ? "transition-[width] duration-700 ease-out" : "",
              !reduced && pulseKey != null ? "animate-plank-glow" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ width: `${pct}%` }}
          />
        </span>
      </span>
    );
  }

  return (
    <div className={["w-full", className].join(" ")}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs text-amber-100/80">
        <span className="font-medium tracking-wide text-amber-50/90">
          Archive depth
        </span>
        <span className="tabular-nums text-amber-100/70" aria-live="polite">
          {known ? `${pct}%` : "-"}
        </span>
      </div>

      <div
        className={[
          "relative h-3 w-full overflow-hidden rounded-sm",
          "border border-amber-950/60",
          "bg-[linear-gradient(90deg,rgba(0,0,0,0.2)_1px,transparent_1px),linear-gradient(180deg,#3d2412,#5c3a1e)]",
          "bg-[length:4px_100%,100%_100%]",
          "shadow-[inset_0_1px_2px_rgba(0,0,0,0.55)]",
        ].join(" ")}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={summary}
        aria-label={summary}
      >
        {/* fill -- only when we have a real ratio; unknown stays empty track */}
        {known && (
          <div
            key={pulseKey ?? "fill"}
            className={[
              "absolute inset-y-0 left-0",
              "bg-[linear-gradient(180deg,#c4a574_0%,#8b5a2b_45%,#6b4226_100%)]",
              "shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]",
              !reduced ? "transition-[width] duration-700 ease-out" : "",
              !reduced && pulseKey != null ? "animate-plank-glow" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ width: `${pct}%` }}
          />
        )}

        {/* end-cap plank when partial progress */}
        {known && pct !== null && pct > 0 && pct < 100 && (
          <span
            aria-hidden
            className="absolute top-0 h-full w-0.5 bg-amber-100/40"
            style={{ left: `calc(${pct}% - 1px)` }}
          />
        )}
      </div>

      {/* Always in DOM for AT and honesty */}
      <p className="mt-1 text-[11px] leading-snug text-amber-100/55">
        {summary}
        {scoreMethod === "unknown_supply" && (
          <span className="block text-amber-100/40">
            Completeness % requires a known supply; we do not invent one.
          </span>
        )}
      </p>
    </div>
  );
}
