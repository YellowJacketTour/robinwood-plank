"use client";

import { useState } from "react";
import TradeWorkbench from "@/components/trade/TradeWorkbench";
import TradeStatusPanel from "@/components/trade/TradeStatusPanel";
import type { TradeMode, ZeroXStatusResponse } from "@/components/trade/TradeModeSwitch";

/**
 * Owns the one piece of state TradeStatusPanel needs but can't derive on its
 * own: which tab is active on TradeModeSwitch (buried two components deep,
 * inside TradeWorkbench). Without this, the status rail hardcoded "Uniswap
 * Trading API" even while a visitor was on the 0x cross-chain tab — the same
 * misattribution bug class the owner originally caught in the chart header,
 * just in a second component (docs/TRADE_PAGE_SPEC.md §5).
 *
 * TradeModeSwitch remains the single fetch owner for /api/zerox/status; this
 * component only receives what it already fetched via callback props, so
 * there's exactly one network call, not two independent ones drifting apart.
 */
export default function TradeActionZone() {
  const [mode, setMode] = useState<TradeMode>("same");
  const [zeroXStatus, setZeroXStatus] = useState<ZeroXStatusResponse | null>(null);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start sm:gap-5">
      <div className="min-w-0">
        <TradeWorkbench onModeChange={setMode} onZeroXStatusChange={setZeroXStatus} />
      </div>

      <TradeStatusPanel activeMode={mode} zeroXStatus={zeroXStatus} />
    </div>
  );
}
