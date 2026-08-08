import Image from "next/image";
import { ExternalLink } from "lucide-react";
import {
  isMarketplankRelistRequired,
  MARKETPLANK_RELIST_MESSAGE,
  type Listing,
  type MarketCollection,
} from "@/lib/market/types";
import { formatTokenAmount, shortAddress } from "@/lib/trade";
import { tierColor } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import { withImageWidth } from "@/lib/ipfs";
import EthUsdValue from "@/components/market/EthUsdValue";

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
  // This state is for listings for sale. Incoming offers have their own
  // acceptance validation and should not inherit a sale-card warning.
  const relistRequired = !isOffer && isMarketplankRelistRequired(listing);
  // Collection-wide bids have no token to open a detail view for.
  const selectable = Boolean(onSelect && listing.tokenId);
  const trustLabels = collection.trustBadges.map(
    (badge) => TRUST_BADGE[badge]?.label ?? badge
  );
  return (
    <li
      // Finalized mockup card: uniform quiet frame, rarity communicated by
      // the tier pill alone; the card lifts on hover instead of glowing.
      className={`dense-card flex flex-col overflow-hidden p-0 transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-line-strong ${
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
          src={withImageWidth(listing.imageUrl, 256) || collection.image}
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
            <EthUsdValue wei={listing.priceWei} className="block text-[0.62rem] tabular-nums text-foreground/50" />
          </div>
          {listing.venue === "opensea" ? (
            /**
             * Foreign listing: link out, never a Buy button. The order routes
             * through a conduit we do not control, so a Buy here would be us
             * promising a fill we cannot guarantee — the exact failure that
             * made stale listings revert for buyers. A different label, a
             * different colour and an outbound arrow mean nobody clicks
             * expecting one flow and lands in another.
             */
            <a
              href={listing.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-11 min-w-16 items-center justify-center gap-1 rounded-md border border-[#58BDF0]/40 px-2 text-xs font-bold text-[#58BDF0] transition hover:border-[#58BDF0] sm:min-w-[4.25rem] sm:px-3 sm:text-sm"
            >
              View
              <ExternalLink size={12} strokeWidth={2.5} aria-hidden />
              <span className="sr-only">on OpenSea, opens in a new tab</span>
            </a>
          ) : (
            <button
              type="button"
              disabled={!canFill || relistRequired}
              onClick={() => onBuy?.(listing)}
              title={
                relistRequired
                  ? MARKETPLANK_RELIST_MESSAGE
                  : canFill
                    ? undefined
                    : "You don't own a plank this bid can take."
              }
              className={`min-h-11 rounded-md px-2 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-100 sm:px-3 sm:text-sm ${
                relistRequired
                  ? "min-w-28 border border-red-400/60 bg-red-950/40 text-red-100"
                  : isOffer
                    ? "min-w-16 bg-emerald-500 text-wood-950 hover:bg-emerald-400 sm:min-w-[4.25rem]"
                    : "min-w-16 bg-gold-500 text-wood-950 hover:bg-gold-400 sm:min-w-[4.25rem]"
              }`}
            >
              {relistRequired ? "Relist required" : buyLabel ?? "Buy"}
            </button>
          )}
        </div>
        {!isOffer && (
          /**
           * Labelled on BOTH venues, not just the foreign one. Marking only
           * OpenSea would make "unmarked" mean "ours" — an inference, and
           * inferences fail for anyone landing mid-scroll. Explicit costs a
           * little more ink and removes the ambiguity entirely.
           */
          <span
            className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[0.55rem] font-black uppercase tracking-wider ${
              listing.venue === "opensea"
                ? "bg-[#58BDF0]/15 text-[#58BDF0]"
                : "bg-gold-500/15 text-gold-300"
            }`}
          >
            {listing.venue === "opensea" ? "OpenSea" : "Marketplank"}
          </span>
        )}
        {relistRequired && (
          <div
            role="status"
            className="space-y-0.5 rounded-md border border-red-400/55 bg-red-950/35 px-2.5 py-2 text-red-100"
          >
            <p className="text-[0.72rem] font-black uppercase tracking-[0.08em]">Relist required</p>
            <p className="text-[0.68rem] font-bold leading-snug text-red-100/85">
              {MARKETPLANK_RELIST_MESSAGE}
            </p>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-[0.6rem] text-foreground/45" title={listing.maker}>
            {isOffer ? "Bidder " : "Maker "}
            {shortAddress(listing.maker)}
          </p>
        </div>
        {(onOffer || selectable) && (
          <div className="flex gap-1.5">
            {onOffer && (
              <button
                type="button"
                onClick={() => onOffer(listing)}
                title={
                  listing.venue === "opensea"
                    ? "Creates a separate Marketplank offer; it does not modify the OpenSea listing."
                    : undefined
                }
                className="min-h-11 flex-1 rounded-md border border-line-strong text-xs font-bold text-gold-300 transition hover:border-gold-400 sm:text-sm"
              >
                {listing.venue === "opensea" ? "Make offer" : "Offer"}
              </button>
            )}
            {selectable && (
              <button
                type="button"
                onClick={() => onSelect!(listing.tokenId)}
                className="min-h-11 flex-1 rounded-md border border-line text-xs font-bold text-foreground/65 transition hover:border-gold-400 hover:text-gold-300"
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
