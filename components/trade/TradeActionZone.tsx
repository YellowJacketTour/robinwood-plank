"use client";

import { useState } from "react";
import TradeWorkbench from "@/components/trade/TradeWorkbench";
import TradeStatusPanel from "@/components/trade/TradeStatusPanel";
import TradeSafetyNotes from "@/components/trade/TradeSafetyNotes";
import type { TradeMode, ZeroXStatusResponse } from "@/components/trade/TradeModeSwitch";

/**
 * Owns the one piece of state two siblings need but can't derive on their
 * own: which tab is active on TradeModeSwitch (buried two components deep,
 * inside TradeWorkbench).
 *
 * Without this, TradeStatusPanel hardcoded "Uniswap Trading API" even on the
 * 0x cross-chain tab, and — more seriously — TradeSafetyNotes asserted
 * "Not a bridge" even while cross-chain mode was actively bridging funds via
 * 0x. Same root cause (a mode-blind sibling), same fix: one source of truth
 * for "which mode am I in," consumed by both (docs/TRADE_PAGE_SPEC.md §5 and
 * the follow-up safety-band accuracy fix).
 *
 * TradeModeSwitch remains the single fetch owner for /api/zerox/status; this
 * component only receives what it already fetched via callback props, so
 * there's exactly one network call, not three independent ones drifting
 * apart.
 */
export default function TradeActionZone() {
  const [mode, setMode] = useState<TradeMode>("same");
  const [zeroXStatus, setZeroXStatus] = useState<ZeroXStatusResponse | null>(null);

  return (
    <>
      <div className="mx-auto w-full max-w-4xl">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start sm:gap-5">
          <div className="min-w-0">
            <TradeWorkbench onModeChange={setMode} onZeroXStatusChange={setZeroXStatus} />
          </div>

          <TradeStatusPanel activeMode={mode} zeroXStatus={zeroXStatus} />
        </div>
      </div>

      <TradeSafetyNotes activeMode={mode} zeroXStatus={zeroXStatus} />
    </>
  );
}
