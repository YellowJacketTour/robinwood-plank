"use client";

import { useCallback, useState } from "react";
import Reveal from "@/components/Reveal";
import CountdownTimer from "@/components/trade/CountdownTimer";
import SwapWidget from "@/components/trade/SwapWidget";
import {
  CHAIN,
  CONTRACT_ADDRESS,
  RULES_RELAXED,
  SITE_FEE,
  SNIPER_TRAP_MINUTES,
} from "@/lib/constants";
import { getCountdownParts, shortAddress } from "@/lib/trade";
import CopyCA from "@/components/CopyCA";

const STEPS = [
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
] as const;

export default function Trade() {
  const [isOpen, setIsOpen] = useState(() => getCountdownParts().isOpen);
  const onOpenChange = useCallback((open: boolean) => setIsOpen(open), []);

  return (
    <section id="trade" className="section-tight scroll-mt-24 px-3 sm:px-5">
      <div className="mx-auto max-w-5xl">
        <Reveal>
          <p className="lede text-center text-[0.65rem] font-extrabold uppercase tracking-[0.28em] text-forest-600 sm:text-xs">
            Official plank.love widget only
          </p>
          <h2 className="section-title mt-1.5 text-center text-3xl text-gold-300 sm:text-4xl md:text-5xl">
            Buy Real $PLANK
          </h2>
          <p className="lede mx-auto mt-2 max-w-xl text-center text-sm text-foreground/75 sm:text-base">
            Real CA · Uniswap AMM routing · stay on this widget until rules relax.
          </p>
        </Reveal>

        <Reveal delayMs={60}>
          <div className="mx-auto mt-5 max-w-md sm:mt-6">
            <CountdownTimer onOpenChange={onOpenChange} />
          </div>
        </Reveal>

        {/* Widget first on all breakpoints; side info stacks below on mobile */}
        <div className="mt-6 grid items-start gap-4 sm:mt-8 sm:gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-6">
          <Reveal delayMs={80}>
            <SwapWidget unlocked={isOpen} />
          </Reveal>

          <Reveal delayMs={120}>
            <div className="flex flex-col gap-3 sm:gap-4">
              <div className="rounded-xl border border-gold-500/25 bg-wood-900/85 p-4 sm:p-5">
                <h3 className="font-display text-lg text-gold-300 sm:text-xl">Launch rules</h3>
                <ol className="mt-3 space-y-2.5">
                  {STEPS.map((s) => (
                    <li key={s.n} className="flex gap-2.5 text-sm text-foreground/75">
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-gold-500/45 bg-wood-950 text-[0.65rem] font-bold text-gold-300">
                        {s.n}
                      </span>
                      <span>
                        <strong className="text-foreground">{s.title}.</strong> {s.body}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="rounded-xl border border-dashed border-gold-500/40 bg-forest-900/75 px-3.5 py-3 text-xs leading-relaxed text-foreground/80 sm:text-sm">
                <strong className="text-gold-300">
                  {RULES_RELAXED ? "Rules relaxed." : "Widget only."}
                </strong>{" "}
                {RULES_RELAXED
                  ? "Still verify the CA — prefer this trusted widget."
                  : "Until limits are off, swap only here after countdown. Anywhere else is the trap."}
              </div>

              <div className="rounded-xl border border-gold-500/20 bg-wood-900/85 p-4 sm:p-5">
                <h3 className="text-[0.65rem] font-bold uppercase tracking-widest text-gold-300">
                  Verify
                </h3>
                <dl className="mt-2.5 space-y-1.5 text-xs text-foreground/70 sm:text-sm">
                  <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
                    <dt>Network</dt>
                    <dd className="font-semibold text-foreground">
                      {CHAIN.name} · {CHAIN.id}
                    </dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
                    <dt>Token</dt>
                    <dd className="font-mono text-gold-300" title={CONTRACT_ADDRESS}>
                      {shortAddress(CONTRACT_ADDRESS, 6)}
                    </dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
                    <dt>Venue</dt>
                    <dd className="font-semibold text-foreground">
                      {RULES_RELAXED ? "Widget (+ open markets)" : "plank.love only"}
                    </dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
                    <dt>Site fee</dt>
                    <dd className="text-gold-300">
                      {SITE_FEE.label} →{" "}
                      <span className="font-mono" title={SITE_FEE.recipient}>
                        {shortAddress(SITE_FEE.recipient, 4)}
                      </span>
                    </dd>
                  </div>
                </dl>
                <div className="mt-3">
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
