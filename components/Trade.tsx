"use client";

import { useCallback, useState } from "react";
import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";
import CopyCA from "@/components/CopyCA";
import CountdownTimer from "@/components/trade/CountdownTimer";
import SwapWidget from "@/components/trade/SwapWidget";
import { CHAIN, TRADE_PAUSED } from "@/lib/constants";
import { getCountdownParts } from "@/lib/trade";

export default function Trade() {
  const [isOpen, setIsOpen] = useState(() =>
    TRADE_PAUSED ? false : getCountdownParts().isOpen
  );
  const [expanded, setExpanded] = useState(false);
  const onOpenChange = useCallback((open: boolean) => {
    setIsOpen(TRADE_PAUSED ? false : open);
  }, []);

  return (
    <section id="trade" className="section-tight scroll-mt-20 px-3 sm:px-5">
      <div className="site-shell">
        <Reveal>
          <SectionHead
            eyebrow={TRADE_PAUSED ? "Stand by" : "Official Uniswap · verified CA"}
            title={TRADE_PAUSED ? "Trading Paused" : "Buy & Sell $PLANK"}
            lede={
              TRADE_PAUSED ? "Not live yet." : `${CHAIN.name} · verified contract only.`
            }
            artSrc="/images/collection/plank-insidertrader.png"
            artAlt="Insider Trader collection plank"
            center
            className="mx-auto max-w-xl"
          />
        </Reveal>

        <Reveal delayMs={40}>
          <div className="mx-auto mt-3 max-w-md">
            <CountdownTimer onOpenChange={onOpenChange} />
          </div>
        </Reveal>

        {!TRADE_PAUSED && isOpen && (
          <Reveal delayMs={55}>
            <div className="mx-auto mt-3 max-w-xl space-y-2.5">
              {!expanded ? (
                <>
                  <CopyCA />
                  <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="flex min-h-12 w-full items-center justify-center rounded-lg bg-gold-500 px-4 text-sm font-black text-wood-950 shadow-[0_6px_18px_-6px_rgba(217,164,65,0.55)] transition hover:bg-gold-400 sm:text-base"
                  >
                    Trade $PLANK
                  </button>
                </>
              ) : (
                <SwapWidget />
              )}
            </div>
          </Reveal>
        )}
      </div>
    </section>
  );
}
