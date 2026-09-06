"use client";

import { useMemo, useState } from "react";
import { parityForChain, paritySummary, type ParityCell, type ParityState } from "@/lib/market/multichain/trading/parity-matrix";
import { chainDisplayName } from "@/lib/market/multichain/trading/foreign-chain-registry";

/**
 * Trading coverage for one chain, rendered as COVERAGE, never a claim:
 * every feature shows its registry state and, on demand, the evidence line
 * (what proved it, or what gates it). Same panel tokens DESIGN.md gives the
 * market shell (border-line, bg-panel, foreground opacities).
 */

const STATE_LABEL: Record<ParityState, string> = {
  proven: "Proven",
  "built-unproven": "Built, unproven",
  gated: "Owner-gated",
  unavailable: "No venue",
};

const STATE_CLASS: Record<ParityState, string> = {
  proven: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  "built-unproven": "bg-amber-500/15 text-amber-200 border-amber-500/30",
  gated: "bg-sky-500/15 text-sky-200 border-sky-500/30",
  unavailable: "bg-foreground/5 text-foreground/40 border-line",
};

function featureLabel(feature: ParityCell["feature"]): string {
  return feature.replace(/-/g, " ");
}

export default function TradingParityMatrix({ chainSlug }: { chainSlug: string }) {
  const cells = useMemo(() => parityForChain(chainSlug), [chainSlug]);
  const summary = useMemo(() => paritySummary(cells), [cells]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="rounded-lg border border-line bg-panel p-3" aria-label={`Trading coverage on ${chainDisplayName(chainSlug)}`}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Trading coverage · {chainDisplayName(chainSlug)}</h3>
        <p className="text-[0.68rem] text-foreground/50">
          {summary.proven} proven · {summary["built-unproven"]} built · {summary.gated} gated · {summary.unavailable} no venue. A state is a registry
          entry with evidence, not a promise.
        </p>
      </div>
      <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
        {cells.map((cell) => {
          const isOpen = open === cell.feature;
          return (
            <li key={cell.feature}>
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : cell.feature)}
                aria-expanded={isOpen}
                className={`flex w-full flex-col items-start rounded-md border px-2 py-1.5 text-left transition-colors hover:border-gold-400/60 ${STATE_CLASS[cell.state]}`}
              >
                <span className="text-[0.7rem] font-semibold capitalize leading-tight">{featureLabel(cell.feature)}</span>
                <span className="text-[0.62rem] opacity-80">{STATE_LABEL[cell.state]}</span>
              </button>
              {isOpen && <p className="mt-1 rounded-md border border-line bg-background/60 p-2 text-[0.66rem] leading-snug text-foreground/70">{cell.evidence}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
