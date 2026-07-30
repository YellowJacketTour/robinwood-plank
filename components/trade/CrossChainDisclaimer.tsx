import { CHAIN } from "@/lib/constants";
import { explorerTokenUrl } from "@/lib/trade";
import { getSourceChainExplorerUrl } from "@/lib/crosschain-wallet";

type SourceChainOption = { chainId: number; name: string };

/**
 * Owner-approved cross-chain safety copy, adapted for 0x's one-step flow
 * (ZeroXCrossChainPanel.tsx — one signed transaction, not the older
 * bridge-then-swap two-step). Mirrors the bullet points already approved for
 * CrossChainPanel.tsx's disclaimer (multi-chain, minutes not seconds, a
 * third party executes settlement, what happens if it fails) but never
 * promises the two-transaction recovery story that flow has, since 0x's is
 * genuinely one signature. Shown above the panel, before any quote/funds
 * commitment.
 */
export default function CrossChainDisclaimer({
  sourceChains,
}: {
  sourceChains: SourceChainOption[];
}) {
  return (
    <div className="space-y-2 rounded-xl border border-amber-400/40 bg-amber-400/10 p-3">
      <p className="text-sm font-bold text-amber-100">Before you buy cross-chain</p>
      <ul className="list-disc space-y-1 pl-4 text-[0.75rem] text-amber-50/90">
        <li>
          One signed transaction, but it still spans two blockchains — your source chain and{" "}
          {CHAIN.name}.
        </li>
        <li>
          0x&apos;s routers execute the destination-chain leg, not plank.love — settlement is
          usually fast, but the time shown is an estimate, not a guarantee.
        </li>
        <li>
          Once you sign, your source-chain transaction is the full record of what you sent. If
          $PLANK doesn&apos;t arrive after a reasonable wait, check that transaction on its source
          chain&apos;s explorer first, then follow up with 0x referencing that hash — plank.love
          never holds funds mid-transit.
        </li>
        <li>Always compare the destination amount against the real $PLANK contract below.</li>
      </ul>
      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-[0.7rem]">
        <a
          href={explorerTokenUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="font-bold text-amber-200 underline underline-offset-2 hover:text-amber-100"
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
              className="font-bold text-amber-200 underline underline-offset-2 hover:text-amber-100"
            >
              {c.name} explorer ↗
            </a>
          );
        })}
      </div>
    </div>
  );
}
