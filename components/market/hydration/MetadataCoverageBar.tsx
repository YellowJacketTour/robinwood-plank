"use client";

import type { CSSProperties } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { useTweenedPercent } from "./useTweenedPercent";
import { chainBrandColorInverted } from "@/lib/market/multichain/trading/foreign-chain-registry";

export type MetadataCoverageBarProps = {
  /** 0..1, or null if not yet measured (see archival-ledger.ts's
   * ArchivalApiShape header for the real, separate L3 signal this reads --
   * never the same number as ArchivalDepthBar's membership score). */
  metadataCoverage: number | null;
  metadataTokens: number | null;
  /** Real denominator -- membership's own tokensEverHydrated, i.e. "how
   * many tokens do we even know exist right now" -- never knownSupply
   * directly, since metadata coverage can only ever be measured against
   * tokens this app has actually discovered so far. */
  knownTokens: number | null;
  pulseKey?: string | number | null;
  chainSlug?: string | null;
  /** Same real "a plank_data_jobs row is hydrating THIS collection right
   * now" signal ArchivalDepthBar's own `active` prop uses. */
  active?: boolean;
  compact?: boolean;
  className?: string;
};

/**
 * Real, separate "traits & metadata" bar -- external research brief's own
 * complaint made concrete by live evidence: a real collection (Doodles)
 * showed 100% archive depth while real trait/metadata coverage was only
 * 17.76% (1,776 of 10,000 known tokens), and the existing bar had no way
 * to show that real gap at all. Same visual language as ArchivalDepthBar
 * (wood-textured track, tweened percent, honest "unmeasured" state) but
 * its own distinct fill behavior per the owner's own design brief
 * (2026-08-27): while a real job is actively filling this collection's
 * traits right now, the fill cycles through the same 5 real rarity-tier
 * colors (lib/rarity.ts's own tierColor values) every other rarity badge
 * in this app already uses -- literally "traits are being discovered
 * right now" as color, not just a generic surge. At rest, it resolves to
 * the chain's own INVERTED brand color (chainBrandColorInverted), never
 * ArchivalDepthBar's wood/amber resting color or its own plain chain-
 * brand surge -- the two bars must never look identical in either state.
 */
export function MetadataCoverageBar({
  metadataCoverage,
  metadataTokens,
  knownTokens,
  pulseKey = null,
  chainSlug = null,
  active = false,
  compact = false,
  className = "",
}: MetadataCoverageBarProps) {
  const reduced = usePrefersReducedMotion();
  const known = metadataCoverage != null;
  const rawPct = known ? Math.max(0, Math.min(100, metadataCoverage * 100)) : null;
  const tweenedPct = useTweenedPercent(rawPct);
  const displayPct = tweenedPct ?? rawPct;
  const growing = known && tweenedPct != null && rawPct != null && Math.abs(tweenedPct - rawPct) > 0.01;
  const pctLabel = displayPct != null ? displayPct.toFixed(2) : null;
  const restColor = chainSlug ? chainBrandColorInverted(chainSlug) : null;

  const summary =
    known && knownTokens != null && metadataTokens != null
      ? `Traits & metadata ${pctLabel}% - ${metadataTokens.toLocaleString()} of ${knownTokens.toLocaleString()} known tokens`
      : metadataTokens != null
        ? `Traits & metadata - ${metadataTokens.toLocaleString()} tokens with real data - denominator unknown`
        : "Traits & metadata - not yet measured";

  // Nothing to show for a genuinely unmeasured collection, and nothing
  // to show once metadata has fully caught up to membership -- this bar
  // exists specifically to surface a real, current GAP, never to restate
  // "also 100%" a second time right under a bar that already said so.
  if (!known || (displayPct != null && displayPct >= 99.9)) return null;

  const fillStyle: CSSProperties = {
    width: `${displayPct}%`,
    background: active ? undefined : restColor ? `linear-gradient(180deg, color-mix(in srgb, ${restColor} 85%, white) 0%, ${restColor} 45%, color-mix(in srgb, ${restColor} 60%, black) 100%)` : undefined,
  };

  if (compact) {
    return (
      <span
        className={["inline-flex h-1.5 w-10 shrink-0 items-center", className].join(" ")}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={displayPct ?? undefined}
        aria-valuetext={summary}
        aria-label={summary}
        title={summary}
      >
        <span className="relative h-1 w-full overflow-hidden rounded-full bg-[linear-gradient(180deg,#3d2412,#5c3a1e)]">
          <span
            className={[
              "absolute inset-y-0 left-0 rounded-full transition-[background] duration-700",
              active ? "animate-rarity-cycle" : "",
              !reduced && growing ? "animate-archival-shimmer" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={fillStyle}
          />
        </span>
      </span>
    );
  }

  return (
    <div className={["w-full", className].join(" ")}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs text-amber-100/80">
        <span className="font-medium tracking-wide text-amber-50/90">Traits &amp; metadata</span>
        <span className="tabular-nums text-amber-100/70" aria-live="polite">
          {pctLabel}%
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
        aria-valuenow={displayPct ?? undefined}
        aria-valuetext={summary}
        aria-label={summary}
      >
        <div
          className={[
            "absolute inset-y-0 left-0 transition-[background] duration-700",
            "shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]",
            active ? "animate-rarity-cycle" : "",
            !reduced && pulseKey != null ? "animate-plank-glow" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={fillStyle}
        >
          {!reduced && growing && <span aria-hidden className="absolute inset-0 animate-archival-shimmer" />}
        </div>
        {displayPct !== null && displayPct > 0 && displayPct < 100 && (
          <span aria-hidden className="absolute top-0 h-full w-0.5 bg-amber-100/40" style={{ left: `calc(${displayPct}% - 1px)` }} />
        )}
      </div>
      <p className="mt-1 text-[11px] leading-snug text-amber-100/55">{summary}</p>
    </div>
  );
}
