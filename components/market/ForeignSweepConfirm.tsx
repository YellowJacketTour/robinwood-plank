"use client";

import { formatTokenAmount, shortAddress } from "@/lib/trade";
import { BUY_GAS_RESERVE_ETH } from "@/lib/constants";
import type { Listing } from "@/lib/market/types";

type Props = {
  items: Listing[];
  collectionName: string;
  chainLabel: string;
  feeBps: number;
  busy: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Cross-chain sibling of SweepConfirm -- same visual language and
 * busy/cancel discipline, but NOT built on SweepItem/planSweep (both
 * Robinhood-Chain-specific: planSweep's validateListingOrder assumes a
 * Robinhood-Chain order shape). foreign-fulfill.ts's sweepForeignListings
 * does its own freshness re-derivation per item server-side immediately
 * before sending, the cross-chain equivalent of what planSweep/
 * assertSweepTotal do for the native path.
 */
export default function ForeignSweepConfirm({
  items,
  collectionName,
  chainLabel,
  feeBps,
  busy,
  error,
  onConfirm,
  onCancel,
}: Props) {
  const subtotal = items.reduce((sum, item) => sum + BigInt(item.priceWei), BigInt(0));
  const fee = (subtotal * BigInt(feeBps)) / BigInt(10_000);
  const total = subtotal + fee;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm cross-chain sweep"
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

        <p className="text-[0.65rem] font-bold text-[#58BDF0]">Settles on {chainLabel}</p>

        <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line bg-panel px-3 py-2 text-xs">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-foreground">
                #{item.tokenId}
                <span className="ml-1.5 text-[0.6rem] text-foreground/45">{shortAddress(item.maker)}</span>
              </span>
              <span className="shrink-0 tabular-nums text-foreground">
                {formatTokenAmount(item.priceWei, 18, 4)} Ξ
              </span>
            </li>
          ))}
        </ul>

        <dl className="space-y-1 rounded-lg border border-line bg-panel px-3 py-2 text-xs">
          <div className="flex justify-between">
            <dt className="text-foreground/60">
              {items.length} item{items.length === 1 ? "" : "s"}
            </dt>
            <dd className="tabular-nums text-foreground">{collectionName}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-foreground/60">Marketplank fee (added)</dt>
            <dd className="tabular-nums text-foreground">
              {(feeBps / 100).toFixed(2)}% · {formatTokenAmount(fee.toString(), 18, 4)} Ξ
            </dd>
          </div>
          <div className="flex justify-between border-t border-line pt-1">
            <dt className="font-bold text-foreground">You pay (up to)</dt>
            <dd className="font-display tabular-nums text-gold-300">{formatTokenAmount(total.toString(), 18, 6)} Ξ</dd>
          </div>
        </dl>

        <p className="text-center text-[0.6rem] text-foreground/40">
          Every price re-verified against a fresh signed order immediately before sending. An item
          sold mid-sweep is skipped, not charged. Plus network gas — keep ~{BUY_GAS_RESERVE_ETH} Ξ free.
        </p>

        {error && (
          <p role="alert" className="rounded-lg border border-red-500/35 bg-red-950/25 px-3 py-2.5 text-sm text-red-100">
            {error}
          </p>
        )}

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
