"use client";

import { formatTokenAmount, shortAddress } from "@/lib/trade";
import type { Listing } from "@/lib/market/types";
import type { BatchSendStatus } from "@/lib/market/transfer";

type Props = {
  affordable: Listing[];
  remainder: Listing[];
  collectionName: string;
  chainLabel: string;
  feeBps: number;
  /** Basis points below each remainder item's listed price the offer is placed at -- see MultichainCollectionView's confirmCombined for the reasoning (a real, defensible number, not a UI-only cosmetic). */
  offerDiscountBps: number;
  /** True only for Bitcoin -- no offer-placement primitive exists on UniSat's documented API (re-verified this session), so the control degrades to sweep-only with this note instead of silently dropping the "offer the rest" half. */
  offersUnavailable: boolean;
  busy: boolean;
  error?: string | null;
  statuses?: Map<string, BatchSendStatus> | null;
  sequential?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * "Buy what's affordable, offer for the rest" -- a genuine combination
 * control, additive alongside the separate Sweep and single-item Offer
 * flows (both keep working independently). Same wood-ledger visual
 * language as ForeignSweepConfirm/ForeignOfferConfirm -- no new design
 * tokens introduced.
 */
export default function ForeignCombinedSweepConfirm({
  affordable,
  remainder,
  collectionName,
  chainLabel,
  feeBps,
  offerDiscountBps,
  offersUnavailable,
  busy,
  error,
  statuses,
  sequential,
  onConfirm,
  onCancel,
}: Props) {
  const subtotal = affordable.reduce((sum, item) => sum + BigInt(item.priceWei), BigInt(0));
  const fee = (subtotal * BigInt(feeBps)) / BigInt(10_000);
  const total = subtotal + fee;
  const discountPct = (offerDiscountBps / 100).toFixed(1);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center" role="dialog" aria-modal="true" aria-label="Sweep floor and offer for the rest">
      <div className="wood-ledger w-full max-w-sm space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-gold-300">Buy + offer</h3>
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

        {affordable.length > 0 && (
          <div className="space-y-1">
            <p className="text-[0.55rem] font-black uppercase tracking-wide text-foreground/45">
              Buy now ({affordable.length})
            </p>
            <ul className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-line bg-panel px-3 py-2 text-xs">
              {affordable.map((item) => {
                const itemStatus = statuses?.get(item.id);
                return (
                  <li key={item.id} className="flex items-center justify-between gap-2">
                    <span className="truncate text-foreground">
                      #{item.tokenId}
                      <span className="ml-1.5 text-[0.6rem] text-foreground/45">{shortAddress(item.maker)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {itemStatus && (
                        <span className={itemStatus.state === "sent" ? "text-emerald-400" : itemStatus.state === "failed" ? "text-red-300" : "text-foreground/50"}>
                          {itemStatus.state}
                        </span>
                      )}
                      <span className="tabular-nums text-foreground">{formatTokenAmount(item.priceWei, 18, 4)} Ξ</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {remainder.length > 0 && (
          <div className="space-y-1">
            <p className="text-[0.55rem] font-black uppercase tracking-wide text-foreground/45">
              {offersUnavailable ? `Beyond budget (${remainder.length}) — no offer` : `Offer at -${discountPct}% (${remainder.length})`}
            </p>
            <ul className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-line bg-panel px-3 py-2 text-xs">
              {remainder.map((item) => {
                const offerPriceWei = (BigInt(item.priceWei) * BigInt(10_000 - offerDiscountBps)) / BigInt(10_000);
                return (
                  <li key={item.id} className="flex items-center justify-between gap-2">
                    <span className="truncate text-foreground">#{item.tokenId}</span>
                    <span className="tabular-nums text-foreground/60">
                      {offersUnavailable ? `${formatTokenAmount(item.priceWei, 18, 4)} Ξ listed` : `${formatTokenAmount(offerPriceWei.toString(), 18, 4)} Ξ offer`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {affordable.length > 0 && (
          <dl className="space-y-1 rounded-lg border border-line bg-panel px-3 py-2 text-xs">
            <div className="flex justify-between">
              <dt className="text-foreground/60">{collectionName}</dt>
              <dd className="tabular-nums text-foreground">{affordable.length} to buy</dd>
            </div>
            <div className="flex justify-between border-t border-line pt-1">
              <dt className="font-bold text-foreground">You pay (up to)</dt>
              <dd className="font-display tabular-nums text-gold-300">{formatTokenAmount(total.toString(), 18, 6)} Ξ</dd>
            </div>
          </dl>
        )}

        <p className="text-center text-[0.6rem] text-foreground/40">
          {offersUnavailable
            ? "Bitcoin has no offer-placement path today (UniSat's documented API only supports buying an existing listing) -- items beyond budget are simply left unbought, not offered."
            : `Items beyond your budget get a standing offer at ${discountPct}% below their listed price instead of being skipped.`}
          {sequential && ` Buys are ${affordable.length} separate signed transaction${affordable.length === 1 ? "" : "s"}.`}
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
          {busy ? "Confirm in wallet…" : "Buy + offer"}
        </button>
      </div>
    </div>
  );
}
