"use client";

import { useEffect, useMemo, useState } from "react";
import { buildOffer } from "@/lib/market/seaport";
import { fetchTraitIndex, getTokenIdsForTrait, traitFloorWei } from "@/lib/market/traits";
import type { TraitIndexResponse } from "@/lib/market/traits";
import { parseTokenAmount, formatTokenAmount } from "@/lib/trade";
import type { Listing, MarketCollection } from "@/lib/market/types";

type Props = {
  account: string;
  collection: MarketCollection;
  /** Set for a single-token offer; omit WITH traitMode for a trait-floor bid. */
  tokenId?: string;
  /**
   * TRAIT-FLOOR BID mode: pick a trait, see how many planks qualify and the
   * current floor among live listings, then bid on any one of them. The bid is
   * a Seaport criteria order whose fulfillability is proven end-to-end in
   * test/contracts/SeaportCriteriaFulfill.test.ts. Collection-wide ("any")
   * offers remain disabled.
   */
  traitMode?: boolean;
  /** Live listings — used only to show the trait's current floor price. */
  listings?: Array<Pick<Listing, "tokenId" | "priceWei">>;
  onSubmitted: () => void;
  onClose: () => void;
};

const DURATIONS = [1, 3, 7, 30];

/** Bottom sheet on mobile, inline panel on desktop — same shell as ListForm. */
export default function OfferForm({
  account,
  collection,
  tokenId,
  traitMode,
  listings,
  onSubmitted,
  onClose,
}: Props) {
  const [priceEth, setPriceEth] = useState("");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Trait mode state — options come from the server's verified index only.
  const [index, setIndex] = useState<TraitIndexResponse | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [traitType, setTraitType] = useState("");
  const [traitValue, setTraitValue] = useState("");

  // Consistent with the item detail modal — Escape dismisses either.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!traitMode) return;
    let cancelled = false;
    fetchTraitIndex(collection)
      .then((res) => {
        if (cancelled) return;
        setIndex(res);
        const firstType = res.traits ? Object.keys(res.traits)[0] : undefined;
        if (firstType) {
          setTraitType(firstType);
          const firstValue = Object.keys(res.traits![firstType])[0];
          if (firstValue) setTraitValue(firstValue);
        }
      })
      .catch((e) => {
        if (!cancelled) setIndexError(e instanceof Error ? e.message : "Could not load traits.");
      });
    return () => {
      cancelled = true;
    };
  }, [traitMode, collection]);

  const traitTypes = useMemo(
    () => (index?.traits ? Object.keys(index.traits).sort() : []),
    [index]
  );
  const traitValues = useMemo(() => {
    if (!index?.traits || !traitType) return [];
    return Object.keys(index.traits[traitType] ?? {}).sort();
  }, [index, traitType]);
  const qualifyingIds = useMemo(
    () => (index && traitType && traitValue ? getTokenIdsForTrait(index, traitType, traitValue) : []),
    [index, traitType, traitValue]
  );
  const floorWei = useMemo(
    () => (listings && qualifyingIds.length > 0 ? traitFloorWei(listings, qualifyingIds) : null),
    [listings, qualifyingIds]
  );

  const submit = async () => {
    setError(null);
    const wei = parseTokenAmount(priceEth, 18);
    if (wei === null || wei <= BigInt(0)) {
      setError("Enter an amount.");
      return;
    }
    if (traitMode && (!traitType || !traitValue || qualifyingIds.length === 0)) {
      setError("Pick a trait first.");
      return;
    }
    try {
      setBusy(true);
      const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      const executed = await buildOffer(account, {
        offerWei: wei.toString(),
        considerationTokenAddress: collection.contractAddress,
        considerationTokenId: traitMode ? undefined : tokenId,
        criteriaTokenIds: traitMode ? qualifyingIds : undefined,
        expiresAt,
        feeBps: collection.feeBps,
      });
      const res = await fetch("/api/market/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "offer",
          collectionSlug: collection.slug,
          rawOrder: executed,
          // TRAIT bid: only the LABEL travels — the server resolves the
          // token-id snapshot from its own verified index and requires the
          // signed order's Merkle root to match it exactly.
          ...(traitMode ? { trait: { traitType, value: traitValue } } : {}),
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

  const traitReady = !traitMode || Boolean(index?.complete && index.traits);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      role="dialog"
      aria-modal="true"
    >
      <div className="wood-ledger w-full max-w-sm space-y-3 rounded-b-none p-4 sm:rounded-b-xl">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-gold-300">
            {traitMode
              ? "Bid on a trait floor"
              : tokenId
                ? `Offer · #${tokenId}`
                : `Offer · any ${collection.name}`}
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

        {traitMode && (
          <div className="space-y-2">
            {indexError && (
              <p className="text-center text-xs text-red-300" role="alert">
                {indexError}
              </p>
            )}
            {!indexError && !index && (
              <p className="text-center text-xs text-foreground/60">Loading traits…</p>
            )}
            {index && !index.complete && (
              <p className="text-center text-xs text-foreground/60" role="status">
                Trait index is still building ({index.scanned}
                {index.totalSupply ? ` / ${index.totalSupply}` : ""} planks scanned) — trait
                bids open once every plank is indexed.
              </p>
            )}
            {index?.complete && index.traits && (
              <>
                <div className="flex gap-2">
                  <label className="flex-1">
                    <span className="mb-1 block text-[0.65rem] font-bold text-foreground/60">
                      Trait
                    </span>
                    <select
                      value={traitType}
                      onChange={(e) => {
                        const next = e.target.value;
                        setTraitType(next);
                        const values = Object.keys(index.traits![next] ?? {}).sort();
                        setTraitValue(values[0] ?? "");
                      }}
                      className="min-h-10 w-full rounded-md border border-gold-500/30 bg-wood-950 px-2 text-xs text-foreground"
                    >
                      {traitTypes.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex-1">
                    <span className="mb-1 block text-[0.65rem] font-bold text-foreground/60">
                      Value
                    </span>
                    <select
                      value={traitValue}
                      onChange={(e) => setTraitValue(e.target.value)}
                      className="min-h-10 w-full rounded-md border border-gold-500/30 bg-wood-950 px-2 text-xs text-foreground"
                    >
                      {traitValues.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="text-center text-[0.7rem] text-foreground/70">
                  {qualifyingIds.length} plank{qualifyingIds.length === 1 ? "" : "s"} qualify
                  {floorWei
                    ? ` · floor ${formatTokenAmount(floorWei, 18, 6)} ETH`
                    : " · none listed right now"}
                </p>
                <p className="text-center text-[0.6rem] text-foreground/40">
                  Your bid can be accepted by the seller of ANY qualifying plank — including
                  the floor one. The qualifying set is snapshotted now and locked into your
                  signed bid.
                </p>
              </>
            )}
          </div>
        )}

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
          disabled={busy || !traitReady}
          onClick={submit}
          className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-50"
        >
          {busy ? "Signing…" : traitMode ? "Bid on trait floor" : "Make offer"}
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
