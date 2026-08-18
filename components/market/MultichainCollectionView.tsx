"use client";

import { useCallback, useEffect, useState } from "react";
import ListingCard from "@/components/market/ListingCard";
import BuyConfirm from "@/components/market/BuyConfirm";
import ForeignSweepConfirm from "@/components/market/ForeignSweepConfirm";
import { useWallet } from "@/lib/wallet-context";
import { connectWallet } from "@/lib/wallet";
import { chainDisplayName, FOREIGN_FEE_BPS } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { isCrossChainBuyable, venueLabel, type Listing, type MarketCollection } from "@/lib/market/types";

type Props = {
  chainSlug: string;
  collectionSlug: string;
};

const SWEEP_SIZE_OPTIONS = [3, 5, 10];

/**
 * Browse + buy + sweep surface for ONE tracked multichain collection (see
 * plank_multichain_collections) -- deliberately a NEW page, not an
 * extension of MarketView.tsx, which is scoped to Marketplank's own single
 * RobinWood collection. See app/api/market/multichain/listings/route.ts's
 * header for why this can't live inside /market or /discover's existing,
 * documented contracts.
 *
 * Reuses the SAME ListingCard/BuyConfirm/foreign-fulfill machinery already
 * built and proven for the single-collection surface -- the cross-chain
 * buy/sweep flow is identical regardless of which collection or chain a
 * listing came from, so nothing here reimplements that logic.
 */
export default function MultichainCollectionView({ chainSlug, collectionSlug }: Props) {
  const { address: account, adoptAccount } = useWallet();
  const [collection, setCollection] = useState<MarketCollection | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [buyTarget, setBuyTarget] = useState<Listing | null>(null);
  const [buyBusy, setBuyBusy] = useState(false);

  const [sweepCount, setSweepCount] = useState(SWEEP_SIZE_OPTIONS[0]);
  const [sweepPreview, setSweepPreview] = useState<Listing[] | null>(null);
  const [sweepBusy, setSweepBusy] = useState(false);

  const chainLabel = `${chainDisplayName(chainSlug)} via OpenSea`;

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      // Collection identity comes from the SAME response as the listings.
      // An earlier version looked it up in /api/market/multichain by
      // matching contractAddress against collectionSlug -- those are
      // different identifiers entirely (an OpenSea slug like "gribbits" is
      // never a 0x address), so the lookup silently never matched and every
      // card fell back to an EMPTY image src. Real-browser loading caught
      // it: 120 console errors and an art-less grid. One source, no
      // cross-referencing by mismatched key.
      const res = await fetch(
        `/api/market/multichain/listings?chainSlug=${chainSlug}&collectionSlug=${encodeURIComponent(collectionSlug)}&limit=40`
      );
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        collection: { slug: string; name: string; imageUrl: string | null; contractAddress: string };
        listings: Listing[];
      };
      // MarketCollection carries Robinhood-Chain-specific bookkeeping
      // (feeBps/royaltyBps/royaltyRecipient) that has no meaning for a
      // foreign collection -- real royalty is whatever the real Seaport
      // order's own consideration embeds (OpenSea's own enforcement), not
      // something this app tracks or sets. Zeroed here deliberately, not
      // a gap: ListingCard/BuyConfirm only read collection.name/image for
      // a cross-chain listing's display, never these fields.
      setCollection({
        slug: data.collection.slug,
        name: data.collection.name,
        contractAddress: data.collection.contractAddress,
        tokenStandard: "ERC721",
        image: data.collection.imageUrl ?? "",
        trustBadges: [],
        feeBps: 0,
        royaltyBps: 0,
        royaltyRecipient: "0x0000000000000000000000000000000000000000",
      });
      setListings(data.listings ?? []);
    } catch {
      setLoadError("Could not load this collection's listings right now.");
    } finally {
      setLoading(false);
    }
  }, [chainSlug, collectionSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const requireAccount = useCallback(async () => {
    if (account) return account;
    try {
      const addr = await connectWallet();
      adoptAccount(addr);
      return addr;
    } catch {
      return null;
    }
  }, [account, adoptAccount]);

  const handleBuy = useCallback(
    async (listing: Listing) => {
      setError(null);
      if (!isCrossChainBuyable(listing)) return;
      const who = await requireAccount();
      if (!who) return;
      setBuyTarget(listing);
    },
    [requireAccount]
  );

  const confirmBuy = useCallback(async () => {
    if (!buyTarget) return;
    setError(null);
    try {
      setBuyBusy(true);
      setStatus("Confirm in wallet…");
      const { buyForeignListingNow } = await import("@/lib/market/multichain/trading/foreign-fulfill");
      await buyForeignListingNow({
        chainSlug: buyTarget.foreignChainSlug!,
        orderHash: buyTarget.foreignOrderHash!,
      });
      setBuyTarget(null);
      setStatus("Purchase confirmed.");
      await load();
    } catch (e) {
      console.error("Cross-chain buy failed:", e);
      setError(e instanceof Error ? e.message : "Purchase failed.");
    } finally {
      setBuyBusy(false);
      setStatus(null);
    }
  }, [buyTarget, load]);

  const openSweepPreview = useCallback(async () => {
    setError(null);
    const who = await requireAccount();
    if (!who) return;
    const cheapest = [...listings]
      .filter((l) => isCrossChainBuyable(l))
      .sort((a, b) => (BigInt(a.priceWei) < BigInt(b.priceWei) ? -1 : 1))
      .slice(0, sweepCount);
    if (cheapest.length === 0) {
      setError("No cross-chain-buyable listings available to sweep right now.");
      return;
    }
    setSweepPreview(cheapest);
  }, [listings, sweepCount, requireAccount]);

  const confirmSweep = useCallback(async () => {
    if (!sweepPreview || sweepPreview.length === 0) return;
    setError(null);
    try {
      setSweepBusy(true);
      setStatus("Confirm in wallet…");
      const { sweepForeignListings } = await import("@/lib/market/multichain/trading/foreign-fulfill");
      const result = await sweepForeignListings({ chainSlug, collectionSlug, count: sweepPreview.length });
      setSweepPreview(null);
      setStatus(`Swept ${result.attempted} item(s).`);
      await load();
    } catch (e) {
      console.error("Cross-chain sweep failed:", e);
      setError(e instanceof Error ? e.message : "Sweep failed.");
    } finally {
      setSweepBusy(false);
      setStatus(null);
    }
  }, [sweepPreview, chainSlug, collectionSlug, load]);

  if (loading) {
    return <p className="p-6 text-center text-foreground/50">Loading {chainDisplayName(chainSlug)} listings…</p>;
  }
  if (loadError || !collection) {
    return <p className="p-6 text-center text-red-300">{loadError ?? "Collection not found."}</p>;
  }

  const buyableCount = listings.filter((l) => isCrossChainBuyable(l)).length;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-gold-300">{collection.name}</h2>
          <p className="text-xs text-foreground/50">
            {listings.length} listing{listings.length === 1 ? "" : "s"} on {chainDisplayName(chainSlug)}
          </p>
        </div>
        {buyableCount > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={sweepCount}
              onChange={(e) => setSweepCount(Number(e.target.value))}
              className="min-h-11 rounded-md border border-line bg-panel px-2 text-sm text-foreground"
              aria-label="Sweep size"
            >
              {SWEEP_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  Sweep {n}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void openSweepPreview()}
              className="min-h-11 rounded-md bg-gold-500 px-3 text-sm font-bold text-wood-950 hover:bg-gold-400"
            >
              Sweep floor
            </button>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-red-500/35 bg-red-950/25 px-3 py-2.5 text-sm text-red-100">
          {error}
        </p>
      )}

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {listings.map((listing) => (
          <ListingCard
            key={listing.id}
            listing={listing}
            collection={collection}
            onBuy={(l) => void handleBuy(l)}
          />
        ))}
      </ul>

      {buyTarget && (
        <BuyConfirm
          listing={buyTarget}
          collection={collection}
          verifiedPriceWei={buyTarget.priceWei}
          busy={buyBusy || status !== null}
          error={error}
          onConfirm={confirmBuy}
          onCancel={() => {
            setError(null);
            setBuyTarget(null);
          }}
          crossChain={{ chainLabel: `${chainDisplayName(chainSlug)} via ${venueLabel(buyTarget)}`, feeBps: FOREIGN_FEE_BPS }}
        />
      )}

      {sweepPreview && (
        <ForeignSweepConfirm
          items={sweepPreview}
          collectionName={collection.name}
          chainLabel={chainLabel}
          feeBps={FOREIGN_FEE_BPS}
          busy={sweepBusy || status !== null}
          error={error}
          onConfirm={confirmSweep}
          onCancel={() => {
            setError(null);
            setSweepPreview(null);
          }}
        />
      )}
    </div>
  );
}
