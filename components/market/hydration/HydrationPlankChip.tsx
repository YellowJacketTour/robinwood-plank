"use client";

import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

export type HydrationPlankChipProps = {
  /** True while a real mesh job is processing this collection */
  active?: boolean;
  /** Real plank_data_jobs.source of the job currently running, when active.
   * Never fabricated -- see JobProcessingInfo's own header. */
  source?: string | null;
  /** Real archival_score (0-1) for this collection, when known. Renders
   * nothing (never a fabricated number) when null/undefined. */
  progress?: number | null;
  /** Bump when a real hydrate/archive write completes -- drives one pulse */
  pulseKey?: string | number | null;
  /** Optional compact label for SR; visual is decorative */
  label?: string;
  className?: string;
};

/** Real plank_data_jobs.source values this app enqueues (see
 * hydrationJobSources in lib/market/multichain/collection-demand.ts) mapped
 * to a short, honest, human label of the actual action -- never a made-up
 * generic "syncing" gloss when the real source is known. */
const SOURCE_LABEL: Record<string, string> = {
  "opensea-membership": "OpenSea listings",
  "opensea-stats": "OpenSea stats",
  "evm-metadata": "token metadata",
  "cryptopunks-native": "CryptoPunks book",
  "unisat-membership": "UniSat listings",
  "unisat-rarity": "UniSat rarity",
  "helius-membership": "Solana metadata",
  "magiceden-solana": "Magic Eden",
  "robinhood-membership": "RobinWood metadata",
};

function sourceLabel(source: string | null | undefined): string {
  if (!source) return "hydrating";
  return SOURCE_LABEL[source] ?? source.replace(/-/g, " ");
}

/**
 * Live per-collection hydration indicator for rankings rows. Motion is
 * event-driven only (active / pulseKey), never a decorative loop.
 *
 * Redesigned 2026-08-26 from the original always-visible wood-plank swatch:
 * real feedback was "the brown logo is not intuitive and is kind of tacky
 * ... hidden when inactive ... dynamic logos that actually depict the
 * relevant specific actions happening live" and "no progress % or
 * interactive visual progress bar". This renders NOTHING (zero footprint,
 * not just invisible) when idle and not mid-pulse, and when active shows a
 * real source label (whichever plank_data_jobs.source is actually running)
 * plus the real live archival_score as a percentage -- never fabricated,
 * omitted entirely when unknown.
 */
export function HydrationPlankChip({
  active = false,
  source = null,
  progress = null,
  pulseKey = null,
  label = "Hydration activity",
  className = "",
}: HydrationPlankChipProps) {
  const reduced = usePrefersReducedMotion();
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (reduced || pulseKey == null || pulseKey === "") return;
    setPulse(true);
    const t = window.setTimeout(() => setPulse(false), 1400);
    return () => window.clearTimeout(t);
  }, [pulseKey, reduced]);

  const visible = active || pulse;
  if (!visible) return null;

  const pct = progress != null ? Math.round(progress * 100) : null;

  return (
    <span
      className={[
        "inline-flex h-4 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[0.58rem] font-semibold leading-none",
        active
          ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
          : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
        className,
      ].join(" ")}
      role="status"
      aria-label={active ? `${label}: ${sourceLabel(source)}${pct != null ? `, ${pct}% archived` : ""}` : `${label}: updated`}
    >
      <span
        aria-hidden
        className={[
          "h-1.5 w-1.5 shrink-0 rounded-full",
          active ? "bg-sky-400" : "bg-emerald-400",
          active && !reduced ? "animate-pulse" : "",
        ].join(" ")}
      />
      <span className="max-w-[6.5rem] truncate normal-case">
        {active ? sourceLabel(source) : "updated"}
      </span>
      {active && pct != null && <span className="font-mono tabular-nums">{pct}%</span>}
    </span>
  );
}
