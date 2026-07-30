"use client";

import { useEffect, useState } from "react";
import ListingCard from "@/components/market/ListingCard";
import { getRarityMap } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import type { Listing, MarketCollection } from "@/lib/market/types";

type Props = {
  listings: Listing[];
  collections: MarketCollection[];
  onBuy?: (listing: Listing) => void;
  onOffer?: (listing: Listing) => void;
  buyLabel?: string;
  /** "offer" styles the card as an incoming bid, not something for sale. */
  variant?: "listing" | "offer";
  /** Token IDs the viewer owns — offers they can't fill are disabled. */
  ownedTokenIds?: Set<string>;
  /** Opens the item detail view. Omit to leave cards inert. */
  onSelect?: (tokenId: string) => void;
  emptyMessage?: string;
  /** Listings at exactly this price get the "Floor" badge. */
  floorPriceWei?: string;
};

export default function ListingGrid({
  listings,
  collections,
  onBuy,
  onOffer,
  buyLabel,
  variant = "listing",
  ownedTokenIds,
  onSelect,
  emptyMessage = "No listings yet.",
  floorPriceWei,
}: Props) {
  // One shared fetch (module-cached) for every card in every grid on the
  // page — never N requests for N cards.
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void getRarityMap().then((map) => {
      if (!cancelled) setRarity(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (listings.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-gold-500/30 bg-wood-900/90 px-4 py-8 text-center text-sm text-foreground/60">
        {emptyMessage}
      </p>
    );
  }

  return (
    // Fluid auto-fill instead of a fixed breakpoint ladder: the column count
    // scales continuously with actual available width (2-up on a phone,
    // 10+ across on a wide desktop monitor) instead of plateauing at a
    // handful of columns and leaving the rest of a wide screen empty.
    <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] sm:gap-3 xl:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
      {listings.map((listing) => {
        const collection = collections.find((c) => c.slug === listing.collectionSlug);
        if (!collection) return null;
        return (
          <ListingCard
            key={listing.id}
            listing={listing}
            collection={collection}
            onBuy={onBuy}
            onOffer={onOffer}
            buyLabel={buyLabel}
            variant={variant}
            onSelect={onSelect}
            isFloor={Boolean(floorPriceWei) && listing.priceWei === floorPriceWei}
            rarity={listing.tokenId ? rarity.get(listing.tokenId) : undefined}
            // A collection-wide bid (no tokenId) is fillable with any token
            // the viewer owns; an item bid needs that specific one.
            canFill={
              variant !== "offer" ||
              !ownedTokenIds ||
              (listing.tokenId ? ownedTokenIds.has(listing.tokenId) : ownedTokenIds.size > 0)
            }
          />
        );
      })}
    </ul>
  );
}
