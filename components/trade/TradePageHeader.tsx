import Image from "next/image";
import { CHAIN, CONTRACT_ADDRESS } from "@/lib/constants";
import { explorerTokenUrl, shortAddress } from "@/lib/trade";

/**
 * /trade masthead. Mirrors the site's page-header convention (SectionHead)
 * but sized for a dedicated route: one strong display title, a short plain
 * promise, and the real chain — no repeated navigation (DESIGN.md). This is
 * the money page, so the plank character gets real presence instead of a
 * small icon — the hand-drawn art is the brand, never an abstract board
 * (DESIGN.md "Plank character art").
 */
export default function TradePageHeader() {
  return (
    <header className="wood-grain-surface relative overflow-hidden rounded-xl border border-line-strong bg-panel-soft px-4 py-7 text-center sm:px-8 sm:py-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(233,180,63,0.16),transparent_60%)]"
      />
      {/* Faint brand watermark, well under DESIGN.md's contrast floor —
          texture, not a competing focal point. */}
      <Image
        src="/images/plank-logo.webp"
        alt=""
        aria-hidden="true"
        width={640}
        height={640}
        className="pointer-events-none absolute -right-12 -top-16 hidden h-64 w-64 opacity-[0.08] sm:block sm:h-80 sm:w-80"
      />

      <div className="relative flex flex-col items-center gap-3 sm:gap-3.5">
        <span className="inline-flex items-center gap-2 rounded-full border border-gold-500/40 bg-black/25 px-3.5 py-1 text-[0.65rem] font-bold uppercase tracking-widest text-cream-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          {CHAIN.name} · official Uniswap
        </span>

        <div className="flex items-center gap-3 sm:gap-4">
          <Image
            src="/images/plank-head.webp"
            alt=""
            width={1200}
            height={1050}
            className="h-14 w-auto drop-shadow-[0_10px_20px_rgba(0,0,0,0.55)] sm:h-[4.5rem]"
          />
          <h1 className="font-display text-3xl leading-none text-cream sm:text-5xl">
            Trade <span className="plank-title">$PLANK</span>
          </h1>
        </div>

        <p className="lede max-w-xl text-sm text-cream-muted sm:text-base">
          Buy and sell $PLANK straight from the official widget below — no bridges, no
          unofficial pairs, always the real contract on {CHAIN.name}.
        </p>

        <a
          href={explorerTokenUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-0.5 inline-flex min-h-9 items-center gap-1.5 rounded-full border border-gold-500/35 bg-black/20 px-3 py-1 font-mono text-[0.68rem] font-bold text-gold-300 underline-offset-2 hover:bg-gold-500/10 hover:underline"
          title={CONTRACT_ADDRESS}
        >
          Verified CA · {shortAddress(CONTRACT_ADDRESS)} ↗
        </a>
      </div>
    </header>
  );
}
