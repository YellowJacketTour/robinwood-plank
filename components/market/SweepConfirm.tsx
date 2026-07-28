"use client";

import { formatTokenAmount, shortAddress } from "@/lib/trade";
import { BUY_GAS_RESERVE_ETH } from "@/lib/constants";
import type { SweepItem } from "@/lib/market/sweep";
import type { MarketCollection } from "@/lib/market/types";

type Props = {
  items: SweepItem[];
  collection: MarketCollection;
  /** Sum of the items' signature-derived prices — re-checked again at send. */
  verifiedTotalWei: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Sweep checkout — sibling of BuyConfirm with the same busy/cancel discipline.
 * Every price shown is re-derived from its signed order in this browser, and
 * the same derivation runs once more inside sweepFloor before the wallet
 * prompt; if any order drifted, the send aborts instead of re-pricing.
 */
export default function SweepConfirm({
  items,
  collection,
  verifiedTotalWei,
  busy,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm sweep"
    >
      <div className="wood-ledger w-full max-w-sm space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-gold-300">Sweep floor</h3>
          <button
            type="button"
            onClick={() => !busy && onCancel()}
            aria-label="Cancel"
            className="flex h-8 w-8 items-center justify-center rounded-full text-foreground/60 hover:text-gold-300"
          >
            ✕
          </button>
        </div>

        <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-gold-500/20 bg-wood-900/60 px-3 py-2 text-xs">
          {items.map((item) => (
            <li key={item.listing.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-foreground">
                #{item.derived.tokenId}
                <span className="ml-1.5 text-[0.6rem] text-foreground/45">
                  {shortAddress(item.derived.maker)}
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-foreground">
                {formatTokenAmount(item.derived.priceWei, 18, 4)} Ξ
              </span>
            </li>
          ))}
        </ul>

        <dl className="space-y-1 rounded-lg border border-gold-500/20 bg-wood-900/60 px-3 py-2 text-xs">
          <div className="flex justify-between">
            <dt className="text-foreground/60">
              {items.length} plank{items.length === 1 ? "" : "s"}
            </dt>
            <dd className="tabular-nums text-foreground">{collection.name}</dd>
          </div>
          <div className="flex justify-between border-t border-gold-500/15 pt-1">
            <dt className="font-bold text-foreground">You pay</dt>
            <dd className="font-display tabular-nums text-gold-300">
              {formatTokenAmount(verifiedTotalWei, 18, 6)} Ξ
            </dd>
          </div>
        </dl>

        <p className="text-center text-[0.6rem] text-foreground/40">
          Prices verified against each signed order in this browser. A plank sold mid-sweep is
          skipped, not charged. Plus network gas — keep ~{BUY_GAS_RESERVE_ETH} Ξ free.
        </p>

        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-50"
        >
          {busy ? "Confirm in wallet…" : "Sweep"}
        </button>
      </div>
    </div>
  );
}
