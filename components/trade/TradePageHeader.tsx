import Image from "next/image";
import { CHAIN } from "@/lib/constants";

/**
 * /trade masthead. Mirrors the site's page-header convention (SectionHead)
 * but sized for a dedicated route: one strong display title, a short plain
 * promise, and the real chain — no repeated navigation (DESIGN.md).
 */
export default function TradePageHeader() {
  return (
    <header className="wood-grain-surface relative overflow-hidden rounded-xl border border-line px-4 py-6 text-center sm:px-8 sm:py-9">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(217,164,65,0.14),transparent_60%)]"
      />
      <div className="relative flex flex-col items-center gap-2.5 sm:gap-3">
        <span className="inline-flex items-center gap-2 rounded-full border border-gold-500/40 bg-black/25 px-3.5 py-1 text-[0.65rem] font-bold uppercase tracking-widest text-cream-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          {CHAIN.name} · official Uniswap · verified CA
        </span>

        <div className="flex items-center gap-3">
          <Image
            src="/images/plank-head.webp"
            alt=""
            width={1200}
            height={1050}
            className="h-10 w-auto drop-shadow-[0_6px_14px_rgba(0,0,0,0.5)] sm:h-12"
          />
          <h1 className="font-display text-3xl leading-none text-cream sm:text-5xl">
            Trade <span className="plank-title">$PLANK</span>
          </h1>
        </div>

        <p className="lede max-w-xl text-sm text-cream-muted sm:text-base">
          Buy and sell $PLANK straight from the official widget below — no bridges, no
          unofficial pairs, always the real contract on {CHAIN.name}.
        </p>
      </div>
    </header>
  );
}
