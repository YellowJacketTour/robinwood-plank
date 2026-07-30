"use client";

import { useEffect, useState } from "react";
import SwapWidget from "@/components/trade/SwapWidget";
import ZeroXCrossChainPanel from "@/components/trade/ZeroXCrossChainPanel";
import CrossChainDisclaimer from "@/components/trade/CrossChainDisclaimer";

type SourceChainOption = { chainId: number; name: string };
type StatusResponse = {
  crossChainEnabled?: boolean;
  configured?: boolean;
  sourceChains?: SourceChainOption[];
};

type Mode = "same" | "crosschain";

/**
 * Same-chain vs cross-chain is a mode switch, not a variant of one flow —
 * one is a single signed transaction on Robinhood Chain, the other spans two
 * chains and a third-party bridge/fill. The switch itself only exists once
 * /api/zerox/status confirms the feature is actually on; with the flag off
 * (the default) this renders exactly SwapWidget alone, byte-for-byte what
 * /trade showed before this component existed — no dead tab, no empty
 * switch, no layout shift.
 */
export default function TradeModeSwitch() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [mode, setMode] = useState<Mode>("same");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/zerox/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: StatusResponse | null) => {
        if (!cancelled && d) setStatus(d);
      })
      .catch(() => {
        /* switch just stays hidden — same-chain widget still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const crossChainReady = Boolean(status?.crossChainEnabled && status?.configured);

  if (!crossChainReady) return <SwapWidget />;

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-1 rounded-lg border border-gold-500/20 bg-wood-900/90 p-1">
        {(
          [
            { id: "same", label: "Same chain" },
            { id: "crosschain", label: "From another chain" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setMode(tab.id)}
            aria-pressed={mode === tab.id}
            className={`min-h-10 rounded-md text-xs font-bold uppercase tracking-wide transition-colors sm:text-sm ${
              mode === tab.id ? "bg-gold-500 text-wood-950" : "text-foreground/65 hover:text-gold-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {mode === "same" ? (
        <SwapWidget />
      ) : (
        <div className="space-y-2.5">
          <CrossChainDisclaimer sourceChains={status?.sourceChains ?? []} />
          <ZeroXCrossChainPanel />
        </div>
      )}
    </div>
  );
}
