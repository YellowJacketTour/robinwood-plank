"use client";

import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";
import CopyCA from "@/components/CopyCA";
import CountdownTimer from "@/components/trade/CountdownTimer";
import { CHAIN, SITE_FEE, TRADE_PAUSED } from "@/lib/constants";
import { getCountdownParts } from "@/lib/trade";

/** The real widget from /trade — same component, not a copy. Loaded on
 * demand so the wallet/quote/swap stack stays out of the homepage's
 * initial bundle. */
const SwapWidget = dynamic(() => import("@/components/trade/SwapWidget"), {
  ssr: false,
  loading: () => (
    <div className="min-h-[26rem] rounded-xl border border-line bg-panel" aria-hidden="true" />
  ),
});

/**
 * Homepage trade section. Follows the approved mockup's two-column shape —
 * swap on the left, three trust facts on the right — using the SAME
 * SwapWidget the /trade page renders rather than a mock-up of one.
 */
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
              TRADE_PAUSED
                ? "Not live yet."
                : `${CHAIN.name} · verified contract only. Trading is open — no bots, no snipe window.`
            }
            center
            className="mx-auto max-w-2xl"
          />
        </Reveal>

        {!TRADE_PAUSED && !isOpen && (
          <Reveal delayMs={40}>
            <div className="mx-auto mt-3 max-w-md">
              <CountdownTimer onOpenChange={onOpenChange} />
            </div>
          </Reveal>
        )}

        <Reveal delayMs={55}>
          <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-stretch sm:mt-6 sm:gap-4">
            {/* The real widget from /trade — same component, not a copy */}
            <div className="min-w-0">
              <SwapWidget />
            </div>

            {/* Trust facts — stretched to the widget's height, with the
                verified contract strip closing the column so the space
                beside the widget stays useful rather than empty. */}
            <div className="flex min-w-0 flex-col gap-3">
              {[
                {
                  title: "Verified contract",
                  body: "Only this on-site widget and the official Uniswap app are safe — never trust a third-party UI or an unverified deep-link.",
                },
                {
                  title: `Chain ID ${CHAIN.id}`,
                  body: `${CHAIN.name} · gas paid in ETH · Blockscout explorer for every transaction.`,
                },
                {
                  title: "Full transparency",
                  body: `Trading fee is fixed at ${SITE_FEE.label} — hard-coded server-side, never client-overridable.`,
                },
              ].map((f) => (
                <div
                  key={f.title}
                  className="flex flex-1 flex-col justify-center rounded-xl border border-line bg-panel p-3 sm:p-4"
                >
                  <strong className="block font-display text-lg text-gold-300">{f.title}</strong>
                  <span className="mt-1 block text-sm text-cream-muted">{f.body}</span>
                </div>
              ))}

              <Link
                href="/trade"
                className="group flex flex-1 flex-col justify-center rounded-xl bg-gold-500 p-3 text-wood-950 shadow-[0_8px_24px_-10px_rgba(217,164,65,0.7)] transition hover:bg-gold-400 sm:p-4"
              >
                <strong className="flex items-center gap-2 font-display text-xl">
                  Open the trade page
                  <span
                    aria-hidden="true"
                    className="transition-transform group-hover:translate-x-1"
                  >
                    →
                  </span>
                </strong>
                <span className="mt-1 block text-sm font-bold text-wood-950/80">
                  Live $PLANK price chart, every pool and its depth, and buying in from another
                  chain in one transaction.
                </span>
              </Link>

              <CopyCA />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
