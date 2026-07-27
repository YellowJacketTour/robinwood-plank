"use client";

import { useState } from "react";
import { buildOffer } from "@/lib/market/seaport";
import { parseTokenAmount } from "@/lib/trade";
import type { MarketCollection } from "@/lib/market/types";

type Props = {
  account: string;
  collection: MarketCollection;
  /** Omit for a collection-wide offer. */
  tokenId?: string;
  onSubmitted: () => void;
  onClose: () => void;
};

const DURATIONS = [1, 3, 7, 30];

/** Bottom sheet on mobile, inline panel on desktop — same shell as ListForm. */
export default function OfferForm({ account, collection, tokenId, onSubmitted, onClose }: Props) {
  const [priceEth, setPriceEth] = useState("");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const wei = parseTokenAmount(priceEth, 18);
    if (wei === null || wei <= BigInt(0)) {
      setError("Enter an amount.");
      return;
    }
    try {
      setBusy(true);
      const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      const executed = await buildOffer(account, {
        offerWei: wei.toString(),
        considerationTokenAddress: collection.contractAddress,
        considerationTokenId: tokenId,
        expiresAt,
        feeBps: collection.feeBps,
      });
      const res = await fetch("/api/market/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "offer",
          collectionSlug: collection.slug,
          tokenId,
          maker: account,
          priceWei: wei.toString(),
          expiresAt,
          rawOrder: executed,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Offer failed.");
      onSubmitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Offer failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      role="dialog"
      aria-modal="true"
    >
      <div className="wood-ledger w-full max-w-sm space-y-3 rounded-b-none p-4 sm:rounded-b-xl">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-gold-300">
            {tokenId ? `Offer · #${tokenId}` : `Offer · any ${collection.name}`}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-full text-foreground/60 hover:text-gold-300"
          >
            ✕
          </button>
        </div>

        <div className="flex min-h-12 items-center gap-2 rounded-lg border border-gold-500/30 bg-wood-900/70 px-2.5">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.0"
            value={priceEth}
            onChange={(e) => setPriceEth(e.target.value.replace(/[^0-9.]/g, ""))}
            className="min-w-0 flex-1 bg-transparent py-2.5 text-lg font-semibold text-foreground outline-none"
            autoFocus
          />
          {/* Bids are WETH, not ETH — Seaport cannot pull native ETH from an
              offerer, so saying "ETH" here would be wrong about what the
              bidder actually needs to hold. */}
          <span className="text-xs font-bold text-gold-300">WETH</span>
        </div>

        <div className="flex gap-1.5">
          {DURATIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`min-h-9 flex-1 rounded-md text-xs font-bold ${
                days === d ? "bg-gold-500 text-wood-950" : "border border-gold-500/30 text-foreground/70"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>

        <p className="text-center text-[0.65rem] text-foreground/50">
          {collection.feeBps > 0 ? `${(collection.feeBps / 100).toFixed(2)}% marketplace fee` : "No marketplace fee"}
        </p>

        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-50"
        >
          {busy ? "Signing…" : "Make offer"}
        </button>
        {error && (
          <p className="text-center text-xs text-red-300" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
