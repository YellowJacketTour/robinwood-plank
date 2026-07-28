"use client";

import { useMemo, useState } from "react";
import { makeListingInput, makeListingPostBody } from "@/lib/market/bulk-list";
import { buildListing } from "@/lib/market/seaport";
import { formatTokenAmount, parseTokenAmount } from "@/lib/trade";
import type { MarketCollection } from "@/lib/market/types";

type Props = {
  account: string;
  collection: MarketCollection;
  onListed: () => void;
};

const DURATIONS = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
];

/** Full-screen step on mobile, inline panel on desktop — see SPEC.md §4. */
export default function ListForm({ account, collection, onListed }: Props) {
  const [tokenId, setTokenId] = useState("");
  const [priceEth, setPriceEth] = useState("");
  const [durationDays, setDurationDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  /**
   * What actually lands in the seller's wallet. seaport-js deducts the fee
   * from the consideration rather than adding it to the buyer's price, so
   * this mirrors that exact arithmetic (floor division, same as on-chain).
   */
  const netProceeds = useMemo(() => {
    const wei = parseTokenAmount(priceEth, 18);
    if (wei === null || wei <= BigInt(0)) return null;
    const fee = (wei * BigInt(Math.round(collection.feeBps))) / BigInt(10_000);
    return formatTokenAmount(wei - fee, 18, 6);
  }, [priceEth, collection.feeBps]);

  const submit = async () => {
    setError(null);
    const priceWei = parseTokenAmount(priceEth, 18);
    if (!tokenId.trim()) {
      setError("Enter the token ID you're listing.");
      return;
    }
    if (priceWei === null || priceWei <= BigInt(0)) {
      setError("Enter a valid ETH price.");
      return;
    }

    try {
      setBusy(true);
      setStatus("Sign the listing in your wallet…");
      const expiresAt = new Date(Date.now() + durationDays * 86_400_000).toISOString();

      // Shared with the bulk flow (lib/market/bulk-list.ts) so single and
      // bulk listings are the same order shape by construction.
      const executed = await buildListing(
        account,
        makeListingInput(collection, tokenId, priceWei, expiresAt)
      );

      setStatus("Publishing listing…");
      const res = await fetch("/api/market/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          makeListingPostBody(collection, tokenId, account, priceWei, expiresAt, executed)
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Could not publish the listing.");

      setStatus(null);
      setTokenId("");
      setPriceEth("");
      onListed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Listing failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wood-ledger space-y-3 p-3">
      <label className="block">
        <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">
          {collection.name} token ID
        </span>
        <input
          type="text"
          inputMode="numeric"
          placeholder="e.g. 1106"
          value={tokenId}
          onChange={(e) => setTokenId(e.target.value.replace(/[^0-9]/g, ""))}
          className="mt-1 min-h-11 w-full rounded-lg border border-gold-500/30 bg-wood-900/70 px-2.5 text-foreground outline-none focus:border-gold-400"
        />
      </label>

      <label className="block">
        <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">
          Price (ETH)
        </span>
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.0"
          value={priceEth}
          onChange={(e) => setPriceEth(e.target.value.replace(/[^0-9.]/g, ""))}
          className="mt-1 min-h-11 w-full rounded-lg border border-gold-500/30 bg-wood-900/70 px-2.5 text-foreground outline-none focus:border-gold-400"
        />
      </label>

      <label className="block">
        <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">
          Expires
        </span>
        <select
          value={durationDays}
          onChange={(e) => setDurationDays(Number(e.target.value))}
          className="mt-1 min-h-11 w-full rounded-lg border border-gold-500/30 bg-wood-900/70 px-2.5 text-foreground"
        >
          {DURATIONS.map((d) => (
            <option key={d.days} value={d.days}>
              {d.label}
            </option>
          ))}
        </select>
      </label>

      {/* The fee comes out of the seller's proceeds, not on top of the buyer's
          price — so quoting only the rate would leave a seller guessing what
          actually lands in their wallet. */}
      <p className="text-center text-[0.65rem] text-foreground/50">
        {collection.feeBps > 0 ? (
          <>
            {(collection.feeBps / 100).toFixed(2)}% fee · you receive{" "}
            <span className="text-foreground/75">{netProceeds ?? "—"} Ξ</span>
          </>
        ) : (
          "No marketplace fee — you receive the full price"
        )}
      </p>

      <button
        type="button"
        disabled={busy}
        onClick={submit}
        className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? (status ?? "Working…") : "List for sale"}
      </button>

      {error && (
        <p className="text-center text-xs text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
