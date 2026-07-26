"use client";

import { buildUniswapSwapUrl } from "@/lib/trade";
import CopyCA from "@/components/CopyCA";

type Props = {
  amountEth?: string;
  className?: string;
};

/**
 * Deep-link straight into the official Uniswap app with the verified $PLANK CA.
 * Uniswap's own interface executes the swap — we never build or send the transaction.
 */
export default function UniswapOfficialWindow({ amountEth, className = "" }: Props) {
  const buyUrl = buildUniswapSwapUrl({
    direction: "buy",
    amountEth: amountEth && Number(amountEth) > 0 ? amountEth : undefined,
  });
  const sellUrl = buildUniswapSwapUrl({ direction: "sell" });

  return (
    <div className={`wood-ledger overflow-hidden ${className}`} id="uniswap">
      <div className="border-b border-[#c4922e]/40 bg-[#2a1a0f]/90 px-3 py-2.5 sm:px-3.5">
        <h3 className="font-display text-lg leading-tight text-gold-300 sm:text-xl">
          Trade $PLANK
        </h3>
        <p className="mt-0.5 text-[0.7rem] leading-snug text-foreground/70 sm:text-xs">
          Opens the official Uniswap app with the verified contract preloaded.
        </p>
      </div>

      <div className="space-y-2.5 px-3 py-2.5 sm:px-3.5">
        <div className="grid gap-2 sm:grid-cols-2">
          <a
            href={buyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-12 items-center justify-center rounded-lg bg-gold-500 px-3 text-center text-sm font-black text-wood-950 shadow-[0_6px_18px_-6px_rgba(217,164,65,0.55)] transition hover:bg-gold-400"
          >
            Buy on Uniswap ↗
          </a>
          <a
            href={sellUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-12 items-center justify-center rounded-lg border-2 border-gold-500/55 bg-[#2a1a0f] px-3 text-center text-sm font-black text-gold-300 transition hover:border-gold-400 hover:bg-gold-500/10"
          >
            Sell on Uniswap ↗
          </a>
        </div>

        <CopyCA />
      </div>
    </div>
  );
}
