"use client";

import { useState } from "react";
import { formatTokenAmount } from "@/lib/trade";
import type { SendFeeQuote } from "@/lib/market/send-fee";
import type { BatchSendStatus } from "@/lib/market/transfer";

type Props = {
  chainLabel: string;
  tokenIds: string[];
  feeQuote: SendFeeQuote | null;
  feeQuoteError: string | null;
  recipient: string;
  onRecipientChange: (value: string) => void;
  busy: boolean;
  error?: string | null;
  statuses: Map<string, BatchSendStatus> | null;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Send/batch-send confirm step for the multichain surface -- same
 * checkout-before-wallet-prompt discipline as BuyConfirm/ForeignSweepConfirm
 * (see BuyConfirm.tsx's own comment on why every major marketplace
 * interposes this step). Chain-agnostic: the caller supplies which chain
 * via chainLabel/tokenIds, this component has no chain logic of its own.
 */
export default function ForeignSendConfirm({
  chainLabel,
  tokenIds,
  feeQuote,
  feeQuoteError,
  recipient,
  onRecipientChange,
  busy,
  error,
  statuses,
  onConfirm,
  onCancel,
}: Props) {
  const [touched, setTouched] = useState(false);
  const canConfirm = recipient.trim().length > 0 && !!feeQuote && !busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm send"
    >
      <div className="wood-ledger w-full max-w-sm space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-gold-300">
            {tokenIds.length > 1 ? `Send ${tokenIds.length} items` : "Send"}
          </h3>
          <button
            type="button"
            onClick={() => !busy && onCancel()}
            aria-label="Cancel"
            className="flex h-8 w-8 items-center justify-center rounded-full text-foreground/60 hover:text-gold-300"
          >
            ✕
          </button>
        </div>

        <p className="text-[0.65rem] font-bold text-[#58BDF0]">On {chainLabel}</p>

        <ul className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-line bg-panel px-3 py-2 text-xs">
          {tokenIds.map((id) => (
            <li key={id} className="flex items-center justify-between gap-2">
              <span className="text-foreground">#{id}</span>
              {statuses?.get(id) ? (
                <span
                  className={
                    statuses.get(id)!.state === "sent"
                      ? "text-emerald-400"
                      : statuses.get(id)!.state === "failed"
                        ? "text-red-300"
                        : "text-foreground/50"
                  }
                >
                  {statuses.get(id)!.state}
                </span>
              ) : null}
            </li>
          ))}
        </ul>

        <div className="space-y-1">
          <label htmlFor="send-recipient" className="block text-[0.55rem] font-black uppercase tracking-wide text-foreground/45">
            Recipient wallet
          </label>
          <input
            id="send-recipient"
            type="text"
            value={recipient}
            onChange={(e) => onRecipientChange(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="0x..."
            disabled={busy}
            className="min-h-11 w-full rounded-md border border-line bg-panel px-3 text-sm text-foreground placeholder:text-foreground/30"
          />
          {touched && recipient.trim().length === 0 && (
            <p className="text-[0.6rem] text-red-300">Enter a wallet address.</p>
          )}
        </div>

        <dl className="space-y-1 rounded-lg border border-line bg-panel px-3 py-2 text-xs">
          <div className="flex justify-between">
            <dt className="text-foreground/60">Send fee ({tokenIds.length} item{tokenIds.length === 1 ? "" : "s"})</dt>
            <dd className="tabular-nums text-foreground">
              {feeQuoteError ? "—" : feeQuote ? `${formatTokenAmount(feeQuote.totalFeeWei.toString(), 18, 6)} Ξ` : "Estimating…"}
            </dd>
          </div>
          {feeQuote && tokenIds.length > 1 && (
            <div className="flex justify-between text-[0.6rem] text-foreground/45">
              <dt>vs. {tokenIds.length} separate sends</dt>
              <dd className="tabular-nums line-through">
                {formatTokenAmount(feeQuote.equivalentSingleSendsFeeWei.toString(), 18, 6)} Ξ
              </dd>
            </div>
          )}
        </dl>

        {feeQuoteError && (
          <p role="alert" className="rounded-lg border border-red-500/35 bg-red-950/25 px-3 py-2.5 text-sm text-red-100">
            {feeQuoteError}
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-lg border border-red-500/35 bg-red-950/25 px-3 py-2.5 text-sm text-red-100">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={!canConfirm}
          onClick={onConfirm}
          className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-50"
        >
          {busy ? "Confirm in wallet…" : "Send"}
        </button>
      </div>
    </div>
  );
}
