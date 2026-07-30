"use client";

import { useEffect, useState } from "react";
import SwapWidget from "@/components/trade/SwapWidget";
import ZeroXCrossChainPanel from "@/components/trade/ZeroXCrossChainPanel";
import CrossChainDisclaimer from "@/components/trade/CrossChainDisclaimer";

type SourceChainOption = { chainId: number; name: string };
/** Only the fields this component (and TradeStatusPanel, via the callbacks
 * below) actually reads — the full shape lives in app/api/zerox/status/route.ts. */
export type ZeroXStatusResponse = {
  crossChainEnabled?: boolean;
  configured?: boolean;
  sourceChains?: SourceChainOption[];
  siteFee?: { label: string; enabled: boolean };
};

export type TradeMode = "same" | "crosschain";

type Props = {
  /** Reports the active tab up so a sibling (TradeStatusPanel) can render a
   * mode-aware Routing/fee value instead of a same-chain-only hardcoded one —
   * see docs/TRADE_PAGE_SPEC.md §5, "Routing row is mode-blind". */
  onModeChange?: (mode: TradeMode) => void;
  /** Reports the same /api/zerox/status payload this component already
   * fetches, so the status rail can show the real 0x fee instead of guessing
   * or re-fetching. */
  onStatusChange?: (status: ZeroXStatusResponse | null) => void;
};

/**
 * Same-chain vs cross-chain is a mode switch, not a variant of one flow —
 * one is a single signed transaction on Robinhood Chain, the other spans two
 * chains and a third-party bridge/fill. The switch itself only exists once
 * /api/zerox/status confirms the feature is actually on; with the flag off
 * (the default) this renders exactly SwapWidget alone, byte-for-byte what
 * /trade showed before this component existed — no dead tab, no empty
 * switch, no layout shift.
 */
export default function TradeModeSwitch({ onModeChange, onStatusChange }: Props) {
  const [status, setStatus] = useState<ZeroXStatusResponse | null>(null);
  const [mode, setMode] = useState<TradeMode>("same");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/zerox/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ZeroXStatusResponse | null) => {
        if (!cancelled) {
          setStatus(d);
          onStatusChange?.(d);
        }
      })
      .catch(() => {
        /* switch just stays hidden — same-chain widget still works */
      });
    return () => {
      cancelled = true;
    };
    // onStatusChange intentionally excluded — it's a setState callback from
    // the parent and re-running this fetch on every parent render would
    // defeat the "fetch once" contract the comment above documents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const crossChainReady = Boolean(status?.crossChainEnabled && status?.configured);

  useEffect(() => {
    onModeChange?.(crossChainReady ? mode : "same");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, crossChainReady]);

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
