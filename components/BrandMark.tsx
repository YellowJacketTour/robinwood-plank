"use client";

import { useEffect, useState } from "react";
import { swrJson } from "@/lib/market/swr-fetch";

/**
 * Growth Ring brand mark -- replaces the static plank-logo.webp mascot in
 * the nav (see docs review 2026-08-26: "it just doesnt seem intuitive nor
 * does it live signal actual real growing progress"). The ring's fill is
 * real platform-wide archival completeness from
 * /api/market/multichain/archival-summary (see getGlobalArchivalSummary's
 * header for exactly how "verifiably synced" is resolved) -- never a
 * decorative loop. No data yet -> renders the plain outline, honestly,
 * rather than fabricating a percentage.
 *
 * Same visual language as ArchivalDepthBar/HydrationPlankChip elsewhere in
 * the app: this mark and those per-collection indicators are the same real
 * metric at different scopes (whole platform vs. one collection), not two
 * competing designs.
 */
type ArchivalSummary = {
  verifiableCount: number;
  syncedCount: number;
  syncedRatio: number | null;
  totalTracked: number;
  asOf: string;
};

const RADIUS = 15;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  const [summary, setSummary] = useState<ArchivalSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    swrJson<ArchivalSummary>("/api/market/multichain/archival-summary", { ttlMs: 5 * 60_000, swrMs: 30 * 60_000 })
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch(() => {
        // Honest no-op: BrandMark just stays in its idle outline state.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ratio = summary?.syncedRatio ?? null;
  const title =
    ratio == null
      ? "RobinWood"
      : `RobinWood — ${Math.round(ratio * 100)}% of ${summary?.verifiableCount.toLocaleString()} verifiably-synced collections fully hydrated`;
  const offset = ratio == null ? CIRCUMFERENCE : CIRCUMFERENCE - ratio * CIRCUMFERENCE;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <circle cx="16" cy="16" r={RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="3" />
      {ratio != null && (
        <circle
          cx="16"
          cy="16"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          transform="rotate(-90 16 16)"
          style={{ transition: "stroke-dashoffset 600ms ease" }}
        />
      )}
    </svg>
  );
}
