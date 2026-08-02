import Image from "next/image";
import CopyCA from "@/components/CopyCA";
import { TRADE_PAUSED } from "@/lib/constants";
import { getCountdownParts } from "@/lib/trade";

export default function Hero() {
  // Server-computed at request time — CountdownTimer (in the Trade section)
  // remains the source of truth for the live unlock/paused/counting states;
  // this just decides whether the hero shows a "trading live" pill or stays
  // quiet, so it never contradicts real trade status (DESIGN.md: never
  // replace live state with static content).
  const tradeIsOpen = !TRADE_PAUSED && getCountdownParts().isOpen;

  return (
    <section
      id="home"
      className="wood-grain-surface relative overflow-hidden px-3 pb-8 pt-14 sm:px-5 sm:pb-10 sm:pt-16"
    >
      {/* Masthead illustration — capped, top-anchored, and washed down so
          copy stays legible. Lives here rather than on <body> so it can
          never bleed into the sections below (see app/globals.css). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[url('/images/plank-head.webp')] bg-[length:min(1500px,120vw)_auto] bg-top bg-no-repeat"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(20,16,11,0.86)_0%,rgba(20,16,11,0.94)_45%,rgb(20,16,11)_100%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(217,164,65,0.15),transparent_55%)]"
      />
      <div className="site-shell relative flex flex-col items-center gap-2.5 text-center sm:gap-3">
        <span className="rounded-full border border-gold-500/40 bg-wood-950/70 px-3 py-0.5 text-[0.65rem] font-bold uppercase tracking-widest text-gold-300 backdrop-blur-sm">
          Robinhood Chain · live
        </span>

        <div className="flex items-center gap-3 sm:gap-4">
          <Image
            src="/images/plank-logo.webp"
            alt="RobinWood Plank mascot"
            width={96}
            height={140}
            priority
            className="h-16 w-auto drop-shadow-[0_8px_20px_rgba(0,0,0,0.5)] sm:h-20"
          />
          <div className="text-left">
            <h1 className="font-display text-3xl leading-none text-foreground sm:text-5xl md:text-6xl">
              RobinWood{" "}
              <span className="plank-title">($PLANK)</span>
            </h1>
            <p className="lede mt-1 font-display text-lg text-gold-300 sm:text-xl">Plank is Plank.</p>
          </div>
        </div>

        {tradeIsOpen && (
          <span className="inline-flex items-center gap-2 rounded-lg border border-line bg-wood-950/70 px-4 py-2 text-xs font-bold text-cream-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
            Trading is live
          </span>
        )}

        <p className="lede max-w-xl text-balance text-sm text-foreground sm:text-base">
          1,542 RobinWood NFTs · fully minted · buy on the market
        </p>

        <div className="wood-frame relative aspect-[2/1] w-full max-w-3xl overflow-hidden rounded-xl sm:aspect-[3110/2265]">
          <Image
            src="/images/planks-collage.jpg"
            alt="RobinWood Plank collection collage"
            fill
            priority
            sizes="(min-width: 1024px) 768px, 100vw"
            className="object-cover object-top"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent"
          />
        </div>

        <CopyCA />

        {/* CTA hierarchy: Trade = single gold primary; Buy on the market =
            strong secondary; Instant Swap = tertiary. No mint CTA — the
            collection is fully minted out (see MintInfo). */}
        <div className="grid w-full max-w-lg grid-cols-2 gap-2 sm:flex sm:max-w-none sm:justify-center">
          <a
            href="#trade"
            className="col-span-2 flex min-h-12 items-center justify-center rounded-lg bg-gold-500 px-5 text-center text-sm font-bold text-wood-950 sm:col-span-1 sm:min-w-[11rem]"
          >
            Trade $PLANK →
          </a>
          <a
            href="/market"
            className="flex min-h-12 items-center justify-center rounded-lg border border-gold-500/60 bg-wood-950/80 px-4 text-center text-sm font-bold text-gold-300 sm:min-w-[9rem]"
          >
            Buy on the Market
          </a>
          <a
            href="/market?tab=swap"
            className="flex min-h-12 items-center justify-center rounded-lg border border-line px-4 text-center text-sm font-bold text-cream-muted sm:min-w-[9rem]"
          >
            Instant Swap
          </a>
        </div>
        <p className="max-w-md text-[0.7rem] text-foreground/50">
          Official Uniswap widget · verified contract only · Planks are sold out — market only.
        </p>
      </div>
    </section>
  );
}
