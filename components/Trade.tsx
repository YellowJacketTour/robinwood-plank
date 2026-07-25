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

export default function Trade() {
  const [isOpen, setIsOpen] = useState(() => getCountdownParts().isOpen);
  const onOpenChange = useCallback((open: boolean) => setIsOpen(open), []);

  return (
    <section id="trade" className="scroll-mt-24 px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <p className="lede text-center text-xs font-extrabold uppercase tracking-[0.3em] text-forest-600">
            Official plank.love widget only
          </p>
          <h2 className="section-title mt-2 text-center text-4xl text-gold-300 sm:text-5xl">
            Buy Real $PLANK
          </h2>
          <p className="lede mx-auto mt-4 max-w-2xl text-center text-base text-foreground/80 sm:text-lg">
            The only safe place to trade the real $PLANK contract until launch rules are relaxed.
            Powered by Uniswap routing under the hood — stay on this widget, not Uniswap.app or
            random links.
          </p>
        </Reveal>

        <Reveal delayMs={80}>
          <div className="mx-auto mt-10 max-w-xl">
            <CountdownTimer onOpenChange={onOpenChange} />
          </div>
        </Reveal>

        <div className="mt-12 grid items-start gap-8 lg:grid-cols-2">
          <Reveal delayMs={120}>
            <SwapWidget unlocked={isOpen} />
          </Reveal>

          <Reveal delayMs={200}>
            <div className="flex flex-col gap-5">
              <div className="rounded-2xl border border-gold-500/25 bg-wood-900/85 p-6">
                <h3 className="font-display text-xl text-gold-300">How the launch works</h3>
                <ol className="mt-4 space-y-4 text-sm text-foreground/75">
                  <li className="flex gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-500/50 bg-wood-950 text-xs font-bold text-gold-300">
                      1
                    </span>
                    <span>
                      <strong className="text-foreground">LP goes live early</strong> — about{" "}
                      {SNIPER_TRAP_MINUTES} minutes before this site timer. Only bots and snipers
                      will notice.
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-500/50 bg-wood-950 text-xs font-bold text-gold-300">
                      2
                    </span>
                    <span>
                      <strong className="text-foreground">Community waits for this timer</strong> —
                      the official widget stays locked. Do not open Uniswap.app or any other swap UI
                      first.
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-500/50 bg-wood-950 text-xs font-bold text-gold-300">
                      3
                    </span>
                    <span>
                      <strong className="text-foreground">Snipers land on the Plank List</strong> —
                      wallets that buy early (or off this widget while rules are hot) get blacklisted.
                      Anti-sniper / anti-whale stay on for that window.
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold-500/50 bg-wood-950 text-xs font-bold text-gold-300">
                      4
                    </span>
                    <span>
                      <strong className="text-foreground">Rules relaxed → free forever</strong> —
                      cooldowns and limits off, LP renounced / burned. Only then is trading elsewhere
                      as safe as pure open ERC-20 markets.
                    </span>
                  </li>
                </ol>
              </div>

              <div className="rounded-2xl border-2 border-dashed border-gold-500/40 bg-forest-900/75 p-5 text-sm text-foreground/80">
                <p>
                  <span aria-hidden="true">🪓</span>{" "}
                  <strong className="text-gold-300">
                    {RULES_RELAXED ? "Rules relaxed:" : "Official widget only:"}
                  </strong>{" "}
                  {RULES_RELAXED
                    ? "Launch controls are off. Still verify the CA — prefer this trusted widget."
                    : "Until launch rules are fully relaxed, swap only through this plank.love widget after the countdown. Anywhere else is the trap."}
                </p>
              </div>

              <div className="rounded-2xl border border-gold-500/20 bg-wood-900/85 p-5">
                <h3 className="text-xs font-bold uppercase tracking-widest text-gold-300">
                  Always verify
                </h3>
                <ul className="mt-3 space-y-2 text-sm text-foreground/70">
                  <li>
                    Network: <strong className="text-foreground">{CHAIN.name}</strong> (ID{" "}
                    {CHAIN.id})
                  </li>
                  <li>
                    Token:{" "}
                    <code className="text-gold-300" title={CONTRACT_ADDRESS}>
                      {shortAddress(CONTRACT_ADDRESS, 6)}
                    </code>
                  </li>
                  <li>
                    Venue:{" "}
                    <strong className="text-foreground">
                      {RULES_RELAXED
                        ? "plank.love widget (or open Uniswap after verify)"
                        : "plank.love official widget only"}
                    </strong>
                  </li>
                  <li>
                    Site fee:{" "}
                    <strong className="text-gold-300">{SITE_FEE.label}</strong> on widget swaps →{" "}
                    <code className="text-foreground/80" title={SITE_FEE.recipient}>
                      {shortAddress(SITE_FEE.recipient, 4)}
                    </code>
                  </li>
                </ul>
                <div className="mt-4">
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
