import Image from "next/image";
import type { Listing, MarketCollection } from "@/lib/market/types";
import { formatTokenAmount, shortAddress } from "@/lib/trade";

type Props = {
  listing: Listing;
  collection: MarketCollection;
  onBuy?: (listing: Listing) => void;
  onOffer?: (listing: Listing) => void;
};

const TRUST_LABEL: Record<string, string> = {
  "lp-burned": "LP burned",
  "ownership-renounced": "Ownership renounced",
  verified: "Verified",
};

/** 2 columns on mobile, up to 5 on desktop via the parent grid — matches Gallery.tsx. */
export default function ListingCard({ listing, collection, onBuy, onOffer }: Props) {
  return (
    <li className="dense-card flex flex-col overflow-hidden p-0">
      <div className="relative aspect-square w-full bg-wood-900">
        <Image
          src={collection.image}
          alt={`${collection.name} #${listing.tokenId}`}
          fill
          sizes="(min-width: 1024px) 20vw, 50vw"
          className="object-cover"
        />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2.5 sm:p-3">
        <p className="truncate text-xs font-bold text-foreground sm:text-sm">
          {collection.name} #{listing.tokenId}
        </p>
        <p className="text-[0.65rem] text-foreground/50">Seller {shortAddress(listing.seller)}</p>
        {collection.trustBadges.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {collection.trustBadges.slice(0, 2).map((b) => (
              <span
                key={b}
                className="rounded-full border border-emerald-500/30 bg-emerald-950/30 px-1.5 py-0.5 text-[0.55rem] font-bold uppercase tracking-wide text-emerald-300"
              >
                {TRUST_LABEL[b] ?? b}
              </span>
            ))}
          </div>
        )}
        <p className="mt-auto font-display text-base text-gold-300 sm:text-lg">
          {formatTokenAmount(listing.priceWei, 18, 4)} ETH
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => onBuy?.(listing)}
            className="min-h-9 rounded-md bg-gold-500 text-xs font-bold text-wood-950 transition hover:bg-gold-400 sm:text-sm"
          >
            Buy
          </button>
          <button
            type="button"
            onClick={() => onOffer?.(listing)}
            className="min-h-9 rounded-md border border-gold-500/40 text-xs font-bold text-gold-300 transition hover:border-gold-400 sm:text-sm"
          >
            Offer
          </button>
        </div>
      </div>
    </li>
  );
}
