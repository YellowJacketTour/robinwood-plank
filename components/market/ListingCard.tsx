import Image from "next/image";
import type { Listing, MarketCollection } from "@/lib/market/types";
import { formatTokenAmount, shortAddress } from "@/lib/trade";
import { tierColor } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";

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
  /** Opens the item detail view. Omit to leave the card inert. */
  onSelect?: (tokenId: string) => void;
  /** True marks this card as at the current floor price — the "Floorboard". */
  isFloor?: boolean;
  /** Same tier/rank math as the Gallery page — one shared source of truth, fetched once per grid. */
  rarity?: RarityLookup;
};

const TRUST_BADGE: Record<string, { icon: string; label: string }> = {
  "lp-burned": { icon: "🔥", label: "LP burned" },
  "ownership-renounced": { icon: "🔒", label: "Ownership renounced" },
  verified: { icon: "✓", label: "Verified collection" },
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
  onSelect,
  isFloor = false,
  rarity,
}: Props) {
  const isOffer = variant === "offer";
  // Collection-wide bids have no token to open a detail view for.
  const selectable = Boolean(onSelect && listing.tokenId);
  const trustLabels = collection.trustBadges.map(
    (badge) => TRUST_BADGE[badge]?.label ?? badge
  );
  return (
    <li
      // Finalized mockup card: uniform quiet frame, rarity communicated by
      // the tier pill alone; the card lifts on hover instead of glowing.
      className={`dense-card flex flex-col overflow-hidden p-0 transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-gold-500/50 ${
        isOffer ? "border-emerald-500/40" : ""
      }`}
    >
      <div
        className={`relative aspect-square w-full bg-wood-900 ${
          selectable ? "cursor-pointer" : ""
        }`}
        role={selectable ? "button" : undefined}
        tabIndex={selectable ? 0 : undefined}
        aria-label={selectable ? `View #${listing.tokenId}` : undefined}
        onClick={selectable ? () => onSelect!(listing.tokenId) : undefined}
        onKeyDown={
          selectable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect!(listing.tokenId);
                }
              }
            : undefined
        }
      >
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
        {isFloor && (
          <span
            className="card-overlay legible-text absolute bottom-2 right-2 rounded-md bg-black/90 px-2 py-1 text-[0.55rem] font-black uppercase tracking-wide text-gold-300"
            title="Floorboard — cheapest listing"
          >
            Floor
          </span>
        )}
        {rarity && (
          // Tier-colored text on a guaranteed-dark backing (.tier-badge) —
          // not the tier's own fill as a background, which goes illegible
          // against similarly-light/pastel artwork (confirmed live).
          <span
            className="tier-badge absolute left-2 top-2 rounded-full px-2 py-1 text-[0.55rem] font-black uppercase tracking-wide"
            style={{ color: tierColor(rarity.tier) }}
            title={`Rank #${rarity.rank} · ${rarity.percentile.toFixed(0)}th percentile`}
          >
            {rarity.tier}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2.5 sm:p-3">
        {trustLabels.length > 0 && (
          <p className="sr-only">Collection trust: {trustLabels.join(", ")}</p>
        )}
        <div className="min-w-0 leading-tight">
          <p className="truncate text-xs font-bold text-foreground sm:text-sm">
            {listing.tokenId ? (rarity?.name ?? `#${listing.tokenId}`) : "Any plank"}
          </p>
          {listing.tokenId && (
            <p className="truncate text-[0.55rem] text-foreground/40">
              #{listing.tokenId}
              {rarity ? ` · Rank ${rarity.rank}` : ""}
            </p>
          )}
        </div>
        <div className="mt-auto flex items-end justify-between gap-2 pt-1">
          <div className="min-w-0">
            <span className="block text-[0.55rem] font-black uppercase tracking-[0.12em] text-foreground/45">
              Price
            </span>
            <p
              className={`whitespace-nowrap text-sm font-extrabold tabular-nums sm:text-lg ${
                isOffer ? "text-emerald-300" : "text-gold-300"
              }`}
              aria-label={`${formatTokenAmount(listing.priceWei, 18, 4)} ETH`}
            >
              <span aria-hidden="true">
                {formatTokenAmount(listing.priceWei, 18, 4)} Ξ
              </span>
            </p>
          </div>
          <button
            type="button"
            disabled={!canFill}
            onClick={() => onBuy?.(listing)}
            title={canFill ? undefined : "You don't own a plank this bid can take."}
            className={`min-h-11 min-w-16 rounded-md px-2 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-40 sm:min-w-[4.25rem] sm:px-3 sm:text-sm ${
              isOffer
                ? "bg-emerald-500 text-wood-950 hover:bg-emerald-400"
                : "bg-gold-500 text-wood-950 hover:bg-gold-400"
            }`}
          >
            {buyLabel ?? "Buy"}
          </button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-[0.6rem] text-foreground/45" title={listing.maker}>
            {isOffer ? "Bidder " : "Maker "}
            {shortAddress(listing.maker)}
          </p>
          {collection.trustBadges.includes("verified") && (
            <span className="shrink-0 text-[0.6rem] font-bold text-emerald-300">Verified ✓</span>
          )}
        </div>
        {(onOffer || selectable) && (
          <div className="flex gap-1.5">
            {onOffer && (
              <button
                type="button"
                onClick={() => onOffer(listing)}
                className="min-h-11 flex-1 rounded-md border border-gold-500/40 text-xs font-bold text-gold-300 transition hover:border-gold-400 sm:text-sm"
              >
                Offer
              </button>
            )}
            {selectable && (
              <button
                type="button"
                onClick={() => onSelect!(listing.tokenId)}
                className="min-h-11 flex-1 rounded-md border border-gold-500/25 text-xs font-bold text-foreground/65 transition hover:border-gold-400 hover:text-gold-300"
              >
                Details
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
