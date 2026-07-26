"use client";

import { useCallback, useState } from "react";
import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";
import CountdownTimer from "@/components/trade/CountdownTimer";
import UniswapOfficialWindow from "@/components/trade/UniswapOfficialWindow";
import { CHAIN, TRADE_PAUSED } from "@/lib/constants";
import { getCountdownParts } from "@/lib/trade";

export default function Trade() {
  const [isOpen, setIsOpen] = useState(() =>
    TRADE_PAUSED ? false : getCountdownParts().isOpen
  );
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
            artSrc="/images/collection/plank-knightwood.png"
            artAlt="KnightWood collection plank"
          />
        </Reveal>

        <Reveal delayMs={40}>
          <div className="mx-auto mt-3 max-w-md">
            <CountdownTimer onOpenChange={onOpenChange} />
          </div>
        </Reveal>

        {!TRADE_PAUSED && isOpen && (
          <Reveal delayMs={55}>
            <div className="mx-auto mt-3 max-w-xl">
              <UniswapOfficialWindow />
            </div>
          </Reveal>
        )}
      </div>
    </section>
  );
}
