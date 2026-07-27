import Image from "next/image";
import type { Listing, MarketCollection } from "@/lib/market/types";
import { formatTokenAmount, shortAddress } from "@/lib/trade";

type Props = {
  listing: Listing;
  collection: MarketCollection;
  onBuy?: (listing: Listing) => void;
  onOffer?: (listing: Listing) => void;
  buyLabel?: string;
  /** "offer" is an incoming bid — visually distinct from something for sale. */
  variant?: "listing" | "offer";
  /** False disables the action when the viewer can't fill this order. */
  canFill?: boolean;
};

const TRUST_ICON: Record<string, string> = {
  "lp-burned": "🔥",
  "ownership-renounced": "🔒",
  verified: "✓",
};

/** 2 columns on mobile, up to 5 on desktop via the parent grid — matches Gallery.tsx. */
export default function ListingCard({
  listing,
  collection,
  onBuy,
  onOffer,
  buyLabel,
  variant = "listing",
  canFill = true,
}: Props) {
  const isOffer = variant === "offer";
  return (
    <li
      className={`dense-card flex flex-col overflow-hidden p-0 ${
        isOffer ? "border-emerald-500/40" : ""
      }`}
    >
      <div className="relative aspect-square w-full bg-wood-900">
        <Image
          // The token's own art, not the collection logo — a grid of identical
          // logos reads as broken. Falls back only if resolution failed.
          src={listing.imageUrl || collection.image}
          alt={`${collection.name} #${listing.tokenId}`}
          fill
          sizes="(min-width: 1024px) 20vw, 50vw"
          className="object-cover"
          unoptimized={Boolean(listing.imageUrl)}
        />
        {collection.trustBadges.length > 0 && (
          <span
            className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-[0.65rem] text-emerald-300"
            title={collection.trustBadges.join(", ")}
          >
            {TRUST_ICON[collection.trustBadges[0]] ?? "✓"}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-2.5 sm:p-3">
        <p className="truncate text-xs font-bold text-foreground sm:text-sm">
          {listing.tokenId ? `#${listing.tokenId}` : "Any plank"}
        </p>
        <p className="truncate text-[0.6rem] text-foreground/45" title={listing.maker}>
          {isOffer ? "bid by " : ""}
          {shortAddress(listing.maker)}
        </p>
        <p
          className={`mt-auto font-display text-base sm:text-lg ${
            isOffer ? "text-emerald-300" : "text-gold-300"
          }`}
        >
          {formatTokenAmount(listing.priceWei, 18, 4)} Ξ
        </p>
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={!canFill}
            onClick={() => onBuy?.(listing)}
            title={canFill ? undefined : "You don't own a plank this bid can take."}
            className={`min-h-9 flex-1 rounded-md text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-40 sm:text-sm ${
              isOffer
                ? "bg-emerald-500 text-wood-950 hover:bg-emerald-400"
                : "bg-gold-500 text-wood-950 hover:bg-gold-400"
            }`}
          >
            {buyLabel ?? "Buy"}
          </button>
          {onOffer && (
            <button
              type="button"
              onClick={() => onOffer(listing)}
              className="min-h-9 flex-1 rounded-md border border-gold-500/40 text-xs font-bold text-gold-300 transition hover:border-gold-400 sm:text-sm"
            >
              Offer
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
