"use client";

import { useCallback, useState } from "react";
import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";
import CountdownTimer from "@/components/trade/CountdownTimer";
import SwapWidget from "@/components/trade/SwapWidget";
import {
  CHAIN,
  CONTRACT_ADDRESS,
  RULES_RELAXED,
  SITE_FEE,
  SNIPER_TRAP_MINUTES,
  TRADE_PAUSED,
} from "@/lib/constants";
import { getCountdownParts, shortAddress } from "@/lib/trade";
import CopyCA from "@/components/CopyCA";

const STEPS = TRADE_PAUSED
  ? ([
      {
        n: "1",
        title: "Stand by",
        body: "Trading is not live. Wait for the official all-clear.",
      },
      {
        n: "2",
        title: "Widget locked",
        body: "Do not use Uniswap.app or any other frontend.",
      },
      {
        n: "3",
        title: "No off-site trades",
        body: "Protect yourself — wait on plank.love only.",
      },
      {
        n: "4",
        title: "We will unlock",
        body: "Timer + widget open here when trading goes live.",
      },
    ] as const)
  : ([
      {
        n: "1",
        title: "LP early",
        body: `~${SNIPER_TRAP_MINUTES}m before timer — bots only.`,
      },
      {
        n: "2",
        title: "Wait here",
        body: "Widget locked. Do not use Uniswap.app.",
      },
      {
        n: "3",
        title: "Bad Boards",
        body: "Off-widget $PLANK movers listed live — see Boards.",
      },
      {
        n: "4",
        title: "30m cooldowns",
        body: "Per wallet while we update blacklist / exclusions.",
      },
    ] as const);

export default function Trade() {
  const [isOpen, setIsOpen] = useState(() =>
    TRADE_PAUSED ? false : getCountdownParts().isOpen
  );
  const onOpenChange = useCallback((open: boolean) => {
    setIsOpen(TRADE_PAUSED ? false : open);
  }, []);

  // Live: keep unlocked when not paused (timer already open)
  const unlocked = !TRADE_PAUSED && isOpen;

  return (
    <section id="trade" className="section-tight scroll-mt-20 px-3 sm:px-5">
      <div className="site-shell">
        <Reveal>
          <SectionHead
            eyebrow={TRADE_PAUSED ? "Stand by" : "Official widget · live"}
            title={TRADE_PAUSED ? "Trading Paused" : "Buy & Sell $PLANK"}
            lede={
              TRADE_PAUSED
                ? "Community: stand by. Widget is off. Do not trade $PLANK anywhere until we unlock on plank.love."
                : `Connect wallet · buy or sell on ${CHAIN.name} · site fee ${SITE_FEE.label} · official CA only.`
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

        <div className="mt-4 grid items-start gap-3 sm:gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <Reveal delayMs={80}>
            <SwapWidget unlocked={unlocked} />
          </Reveal>

          <Reveal delayMs={80}>
            <div className="flex flex-col gap-2.5">
              <div className="dense-card p-3 sm:p-3.5">
                <h3 className="font-display text-base text-gold-300">
                  {TRADE_PAUSED ? "Right now" : "Launch rules"}
                </h3>
                <ol className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-1">
                  {STEPS.map((s) => (
                    <li key={s.n} className="flex gap-2 text-xs text-foreground/75 sm:text-sm">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-gold-500/45 bg-wood-950 text-[0.6rem] font-bold text-gold-300">
                        {s.n}
                      </span>
                      <span>
                        <strong className="text-foreground">{s.title}.</strong> {s.body}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="rounded-lg border border-dashed border-orange-500/45 bg-[#3a1510]/80 px-3 py-2 text-[0.7rem] leading-snug text-foreground/80 sm:text-xs">
                <strong className="text-orange-300">
                  {TRADE_PAUSED ? "Stand by." : RULES_RELAXED ? "Rules relaxed." : "Widget only."}
                </strong>{" "}
                {TRADE_PAUSED
                  ? "No trading yet — ignore other links and wait for the official unlock."
                  : RULES_RELAXED
                    ? "Prefer this trusted widget."
                    : "Off-site during the trap → "}
                {!TRADE_PAUSED && !RULES_RELAXED && (
                  <a href="#boards" className="text-gold-300 underline-offset-2 hover:underline">
                    Bad Boards
                  </a>
                )}
                {!TRADE_PAUSED && !RULES_RELAXED && "."}
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
                    <dt>Fee</dt>
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
