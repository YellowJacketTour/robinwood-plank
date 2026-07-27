import ListingCard from "@/components/market/ListingCard";
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
  emptyMessage?: string;
};

export default function ListingGrid({
  listings,
  collections,
  onBuy,
  onOffer,
  buyLabel,
  variant = "listing",
  ownedTokenIds,
  emptyMessage = "No listings yet.",
}: Props) {
  if (listings.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-gold-500/30 bg-wood-900/40 px-4 py-8 text-center text-sm text-foreground/60">
        {emptyMessage}
      </p>
    );
  }

  return (
    <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5">
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
