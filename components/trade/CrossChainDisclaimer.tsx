"use client";

import { ChevronDown, ShieldAlert } from "lucide-react";
import { CHAIN } from "@/lib/constants";
import { explorerTokenUrl } from "@/lib/trade";
import { getSourceChainExplorerUrl } from "@/lib/crosschain-wallet";

type SourceChainOption = { chainId: number; name: string };

/**
 * Owner-approved cross-chain safety copy, adapted for 0x's one-step flow
 * (ZeroXCrossChainPanel.tsx — one signed transaction, not the older
 * bridge-then-swap two-step). ZeroXCrossChainPanel carries its own explicit
 * non-atomic-settlement disclosure (shown right before the "Send" button,
 * plus a lifecycle indicator once submitted) — this panel-level copy
 * deliberately does NOT repeat that risk. It covers what the panel doesn't:
 * framing this as a distinct mode before the user even opens the panel
 * (multi-chain, not instant, don't navigate away mid-flow) and durable
 * explorer links for both ends of the trip.
 *
 * Collapsed by default (native <details>) — same substance as before, none
 * of it removed, just not a wall of amber text the user has to scroll past
 * before they've typed an amount. The summary row alone still communicates
 * "read this."
 */
export default function CrossChainDisclaimer({
  sourceChains,
}: {
  sourceChains: SourceChainOption[];
}) {
  // Same border/background language as ZeroXCrossChainPanel's own Fees
  // details block and the non-atomic risk callout below it — these three
  // surfaces are visually separate components/containers (this one is
  // mounted a level up, by TradeModeSwitch) but are meant to read as one
  // "risk & fees" system rather than three unrelated cards. See
  // docs/TRADE_PAGE_SPEC.md §"three stacked disclosure blocks".
  return (
    <details className="group rounded-lg border border-gold-500/20 bg-wood-950/40 px-3 py-2 text-foreground">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[0.72rem] font-bold uppercase tracking-wide text-gold-300">
        <span className="flex min-w-0 items-center gap-1.5">
          <ShieldAlert size={13} className="shrink-0 text-gold-400" />
          What to know before you buy cross-chain
        </span>
        <ChevronDown size={14} className="shrink-0 text-foreground/50 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2.5 space-y-2.5">
        <ul className="list-disc space-y-1 pl-4 text-[0.72rem] leading-snug text-foreground/70">
          <li>
            One signed transaction, but it still spans two blockchains — your source chain and{" "}
            {CHAIN.name} — executed by 0x&apos;s routers, not plank.love.
          </li>
          <li>Usually fast, but not instant: don&apos;t close this tab while a step is in progress.</li>
          <li>Always compare the destination amount against the real $PLANK contract below.</li>
          <li>The panel below shows live settlement status and its own risk details once you quote.</li>
        </ul>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.68rem]">
          <a
            href={explorerTokenUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="font-bold text-gold-300 underline underline-offset-2 hover:text-gold-200"
          >
            $PLANK on {CHAIN.name} explorer ↗
          </a>
          {sourceChains.map((c) => {
            const url = getSourceChainExplorerUrl(c.chainId);
            if (!url) return null;
            return (
              <a
                key={c.chainId}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-bold text-gold-300 underline underline-offset-2 hover:text-gold-200"
              >
                {c.name} explorer ↗
              </a>
            );
          })}
        </div>
      </div>
    </details>
  );
}
