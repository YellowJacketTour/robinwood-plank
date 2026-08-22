"use client";

import { useState } from "react";

type Props = {
  chainLabel: string;
  tokenId: string;
  currencySymbol: string;
  amountEth: string;
  onAmountChange: (value: string) => void;
  busy: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * True only for the Solana branch (see MultichainCollectionView's
   * confirmOffer) -- Magic Eden's /instructions/buy bid settles in native
   * SOL/lamports straight from the connected wallet, not a wrapped ERC-20
   * the way every EVM foreign chain's offer does (Seaport can't pull
   * native gas-token balance, hence WETH/WBNB/WAVAX there). Swaps the
   * descriptive copy so it doesn't claim an "approve a wrapped token" step
   * that doesn't happen on Solana.
   */
  nativeCurrency?: boolean;
};

/**
 * Make-offer checkout step -- same interposed-confirm discipline as every
 * other signer action in this module (BuyConfirm, ForeignSweepConfirm,
 * ForeignSendConfirm). Denominated in WETH/WBNB/WAVAX, never native ETH:
 * Seaport cannot pull native gas-token balance from an offerer at
 * fulfillment time, same constraint lib/market/seaport.ts's buildOffer
 * documents for the native path -- surfaced here explicitly so a user
 * isn't surprised their wallet needs wrapped tokens, not just ETH balance.
 */
export default function ForeignOfferConfirm({
  chainLabel,
  tokenId,
  currencySymbol,
  amountEth,
  onAmountChange,
  busy,
  error,
  onConfirm,
  onCancel,
  nativeCurrency,
}: Props) {
  const [touched, setTouched] = useState(false);
  const amountValid = Number(amountEth) > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center" role="dialog" aria-modal="true" aria-label="Make an offer">
      <div className="wood-ledger w-full max-w-sm space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-gold-300">Offer on #{tokenId}</h3>
          <button type="button" onClick={() => !busy && onCancel()} aria-label="Cancel" className="flex h-8 w-8 items-center justify-center rounded-full text-foreground/60 hover:text-gold-300">
            ✕
          </button>
        </div>

        <p className="text-[0.65rem] font-bold text-[#58BDF0]">On {chainLabel}</p>
        <p className="text-[0.65rem] text-foreground/40">
          {nativeCurrency
            ? `Offers settle in native ${currencySymbol} straight from your wallet balance — no wrapping or approval step.`
            : `Offers settle in ${currencySymbol} (Seaport can't pull native gas-token balance) — your wallet needs a ${currencySymbol} balance and will be prompted to approve it.`}
        </p>

        <div className="space-y-1">
          <label htmlFor="offer-amount" className="block text-[0.55rem] font-black uppercase tracking-wide text-foreground/45">
            Offer amount ({currencySymbol})
          </label>
          <input
            id="offer-amount"
            type="number"
            step="0.0001"
            min="0"
            value={amountEth}
            onChange={(e) => onAmountChange(e.target.value)}
            onBlur={() => setTouched(true)}
            disabled={busy}
            placeholder="0.05"
            className="min-h-11 w-full rounded-md border border-line bg-panel px-3 text-sm text-foreground placeholder:text-foreground/30"
          />
          {touched && !amountValid && <p className="text-[0.6rem] text-red-300">Enter an amount greater than 0.</p>}
        </div>

        {error && (
          <p role="alert" className="rounded-lg border border-red-500/35 bg-red-950/25 px-3 py-2.5 text-sm text-red-100">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={!amountValid || busy}
          onClick={onConfirm}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 text-sm font-bold text-wood-950 transition hover:bg-emerald-400 disabled:opacity-60"
        >
          {busy && <span className="spinner-gold" aria-hidden="true" />}
          {busy ? "Confirm in wallet…" : "Make offer"}
        </button>
      </div>
    </div>
  );
}
