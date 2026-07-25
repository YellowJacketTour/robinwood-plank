"use client";

import { CHAIN, CONTRACT_ADDRESS, TOKEN } from "@/lib/constants";
import { buildUniswapSwapUrl, explorerTokenUrl, shortAddress } from "@/lib/trade";

type Props = {
  /** Optional ETH amount to prefill buy input */
  amountEth?: string;
  className?: string;
};

/**
 * Official Uniswap interface deep-link panel — verified $PLANK on Robinhood Chain.
 * Opens app.uniswap.org with chain + exact contract (no fake pairs).
 */
export default function UniswapOfficialWindow({ amountEth, className = "" }: Props) {
  const buyUrl = buildUniswapSwapUrl({
    direction: "buy",
    amountEth: amountEth && Number(amountEth) > 0 ? amountEth : undefined,
  });
  const sellUrl = buildUniswapSwapUrl({ direction: "sell" });
  const tokenUrl = explorerTokenUrl();

  return (
    <div
      className={`wood-ledger overflow-hidden ${className}`}
      id="uniswap"
    >
      <div className="border-b border-[#c4922e]/40 bg-[#2a1a0f]/90 px-3 py-2.5 sm:px-3.5">
        <p className="text-[0.55rem] font-extrabold uppercase tracking-[0.22em] text-gold-300/90">
          Official Uniswap · verified pair
        </p>
        <h3 className="font-display text-lg leading-tight text-gold-300 sm:text-xl">
          Trade on Uniswap
        </h3>
        <p className="mt-0.5 text-[0.7rem] leading-snug text-foreground/70 sm:text-xs">
          Opens the real Uniswap app on <strong className="text-gold-300">{CHAIN.name}</strong>{" "}
          with the verified <strong className="text-gold-300">${TOKEN.symbol}</strong> contract —
          ETH ↔ {TOKEN.symbol} only.
        </p>
      </div>

      <div className="space-y-2 px-3 py-2.5 sm:px-3.5">
        <div className="rounded-lg border border-[#c4922e]/30 bg-[#1b120a]/85 px-2.5 py-2">
          <p className="text-[0.55rem] font-bold uppercase tracking-wider text-gold-300/75">
            Verified contract
          </p>
          <a
            href={tokenUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 block break-all font-mono text-[0.7rem] text-emerald-300 underline-offset-2 hover:underline sm:text-xs"
            title={CONTRACT_ADDRESS}
          >
            {CONTRACT_ADDRESS}
          </a>
          <p className="mt-1 text-[0.65rem] text-foreground/50">
            Chain {CHAIN.id} · {shortAddress(CONTRACT_ADDRESS, 6)} · never trade another CA
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <a
            href={buyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-12 items-center justify-center rounded-lg bg-gold-500 px-3 text-center text-sm font-black text-wood-950 shadow-[0_6px_18px_-6px_rgba(217,164,65,0.55)] transition hover:bg-gold-400"
          >
            Buy ${TOKEN.symbol} on Uniswap ↗
          </a>
          <a
            href={sellUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-12 items-center justify-center rounded-lg border-2 border-gold-500/55 bg-[#2a1a0f] px-3 text-center text-sm font-black text-gold-300 transition hover:border-gold-400 hover:bg-gold-500/10"
          >
            Sell ${TOKEN.symbol} on Uniswap ↗
          </a>
        </div>

        <p className="text-center text-[0.6rem] leading-snug text-foreground/45">
          app.uniswap.org · chain={CHAIN.uniswapSlug} · input NATIVE / output verified CA
        </p>
      </div>
    </div>
  );
}
