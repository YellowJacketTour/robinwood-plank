"use client";

import { useCallback, useState } from "react";
import CopyCA from "@/components/CopyCA";
import CountdownTimer from "@/components/trade/CountdownTimer";
import TradeModeSwitch from "@/components/trade/TradeModeSwitch";
import { TRADE_PAUSED } from "@/lib/constants";
import { getCountdownParts } from "@/lib/trade";

/**
 * Same open/paused gate as the homepage Trade section (Trade.tsx) — this
 * page is the trading destination now, so the widget renders directly
 * instead of behind an extra "Trade $PLANK" reveal click.
 */
export default function TradeWorkbench() {
  const [isOpen, setIsOpen] = useState(() => (TRADE_PAUSED ? false : getCountdownParts().isOpen));
  const onOpenChange = useCallback((open: boolean) => {
    setIsOpen(TRADE_PAUSED ? false : open);
  }, []);

  return (
    <div className="space-y-3">
      <CountdownTimer onOpenChange={onOpenChange} />
      {!TRADE_PAUSED && isOpen ? (
        <>
          <CopyCA />
          <TradeModeSwitch />
        </>
      ) : (
        !TRADE_PAUSED && (
          <p className="rounded-lg border border-line bg-panel px-3 py-2.5 text-center text-xs text-cream-muted">
            The widget unlocks automatically the moment trading opens — no action needed.
          </p>
        )
      )}
    </div>
  );
}
