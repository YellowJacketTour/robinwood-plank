"use client";

import { useCallback, useState } from "react";
import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";
import CountdownTimer from "@/components/trade/CountdownTimer";
import SwapWidget from "@/components/trade/SwapWidget";
import UniswapOfficialWindow from "@/components/trade/UniswapOfficialWindow";
import {
  CHAIN,
  CONTRACT_ADDRESS,
  SITE_FEE,
  TRADE_PAUSED,
} from "@/lib/constants";
import { getCountdownParts, shortAddress } from "@/lib/trade";
import CopyCA from "@/components/CopyCA";

export default function Trade() {
  const [isOpen, setIsOpen] = useState(() =>
    TRADE_PAUSED ? false : getCountdownParts().isOpen
  );
  const onOpenChange = useCallback((open: boolean) => {
    setIsOpen(TRADE_PAUSED ? false : open);
  }, []);

  const unlocked = !TRADE_PAUSED && isOpen;

  return (
    <section id="trade" className="section-tight scroll-mt-20 px-3 sm:px-5">
      <div className="site-shell">
        <Reveal>
          <SectionHead
            eyebrow={TRADE_PAUSED ? "Stand by" : "Official Uniswap · verified CA"}
            title={TRADE_PAUSED ? "Trading Paused" : "Buy & Sell $PLANK"}
            lede={
              TRADE_PAUSED
                ? "Community: stand by. Trading is not live yet."
                : `Trade the verified $${"PLANK"} pair on official Uniswap (Robinhood Chain) or use the on-site widget · fee ${SITE_FEE.label} on widget only.`
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

        {/* Primary: official Uniswap FE with correct pair */}
        {!TRADE_PAUSED && (
          <Reveal delayMs={55}>
            <div className="mx-auto mt-3 max-w-xl">
              <UniswapOfficialWindow />
            </div>
          </Reveal>
        )}

        <div className="mt-4 grid items-start gap-3 sm:gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <Reveal delayMs={80}>
            <SwapWidget unlocked={unlocked} />
          </Reveal>

          <Reveal delayMs={80}>
            <div className="flex flex-col gap-2.5">
              <div className="dense-card p-3 sm:p-3.5">
                <h3 className="font-display text-base text-gold-300">How to trade</h3>
                <ol className="mt-2 space-y-1.5 text-xs text-foreground/75 sm:text-sm">
                  <li className="flex gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-gold-500/45 text-[0.6rem] font-bold text-gold-300">
                      1
                    </span>
                    <span>
                      <strong className="text-foreground">Uniswap (recommended).</strong> Use the
                      buttons above — opens app.uniswap.org on{" "}
                      <strong className="text-gold-300">{CHAIN.name}</strong> with the verified CA.
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-gold-500/45 text-[0.6rem] font-bold text-gold-300">
                      2
                    </span>
                    <span>
                      <strong className="text-foreground">On-site widget.</strong> Buy/sell here with
                      site fee {SITE_FEE.label}. Same official pair.
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-gold-500/45 text-[0.6rem] font-bold text-gold-300">
                      3
                    </span>
                    <span>
                      <strong className="text-foreground">Verify CA.</strong> Only{" "}
                      <code className="text-gold-300">{shortAddress(CONTRACT_ADDRESS, 6)}</code>
                    </span>
                  </li>
                </ol>
              </div>

              <div className="rounded-lg border border-dashed border-emerald-500/35 bg-forest-900/75 px-3 py-2 text-[0.7rem] leading-snug text-foreground/80 sm:text-xs">
                <strong className="text-emerald-300">Safe pair:</strong> ETH ↔ $PLANK on chain{" "}
                {CHAIN.id}. Never swap a different contract.
              </div>

              <div className="dense-card p-3 sm:p-3.5">
                <h3 className="text-[0.6rem] font-bold uppercase tracking-widest text-gold-300">
                  Verify
                </h3>
                <dl className="mt-1.5 space-y-1 text-[0.7rem] text-foreground/70 sm:text-xs">
                  <div className="flex justify-between gap-2">
                    <dt>Network</dt>
                    <dd className="font-semibold text-foreground">
                      {CHAIN.name} · {CHAIN.id}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Token</dt>
                    <dd className="font-mono text-gold-300" title={CONTRACT_ADDRESS}>
                      {shortAddress(CONTRACT_ADDRESS, 6)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Widget fee</dt>
                    <dd className="text-gold-300">{SITE_FEE.label}</dd>
                  </div>
                </dl>
                <div className="mt-2">
                  <CopyCA />
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
