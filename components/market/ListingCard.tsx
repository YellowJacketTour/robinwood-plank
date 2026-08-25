import { useState } from "react";
import Image from "next/image";
import { ExternalLink } from "lucide-react";
import {
  isCrossChainBuyable,
  isForeignListing,
  isMarketplankRelistRequired,
  MARKETPLANK_RELIST_MESSAGE,
  venueLabel,
  type Listing,
  type ListingVenue,
  type MarketCollection,
} from "@/lib/market/types";

/**
 * Badge colour per venue, plus ours. Each foreign venue gets its own brand
 * colour so the badge is recognisable at a glance rather than reading as a
 * generic "not us" tag; ours keeps the site gold.
 */
const VENUE_BADGE_CLASS: Record<ListingVenue | "marketplank", string> = {
  opensea: "bg-[#58BDF0]/15 text-[#58BDF0]",
  pulp: "bg-[#F0803C]/15 text-[#F0803C]",
  magiceden: "bg-[#E42575]/15 text-[#E42575]",
  unisat: "bg-[#F7931A]/15 text-[#F7931A]",
  "ordinals-wallet": "bg-[#F7931A]/15 text-[#F7931A]",
  ordnet: "bg-[#FF6B35]/15 text-[#FF9B73]",
  "cryptopunks-native": "bg-gold-500/15 text-gold-300",
  satflow: "bg-[#F7931A]/15 text-[#F7931A]",
  okx: "bg-[#000000]/40 text-[#B8FF33]",
  marketplank: "bg-gold-500/15 text-gold-300",
};
import { formatTokenAmount, formatTokenAmountCompact, shortAddress } from "@/lib/trade";
import { tierColor, tierGlow, tierAnimationClass, tierCardStyle } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import { withImageWidth } from "@/lib/ipfs";
import { preferHighestResImageUrl } from "@/lib/market/collection-art";
import EthUsdValue from "@/components/market/EthUsdValue";
import { formatUsd } from "@/lib/eth-price";
import { chainDisplayName } from "@/lib/market/multichain/trading/foreign-chain-registry";
import ChainIcon from "@/components/market/ChainIcon";
import { displayTokenLabel, shortTokenId } from "@/lib/market/token-label";

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
  /** Real per-chain native currency symbol this listing's priceWei is actually denominated in (e.g. "BTC" on Bitcoin Ordinals, "SOL" on Solana, "WETH" on foreign EVM chains) -- see lib/market/multichain/trading/foreign-chain-registry.ts's nativeCurrencySymbol. Defaults to "ETH" for Marketplank's own native Robinhood Chain listings (ListingGrid.tsx's only caller), which is genuinely correct there and unchanged from this card's prior hardcoded behavior. Still used for the aria-label/screen-reader text even once ChainIcon replaces the visible glyph. */
  currencySymbol?: string;
  /** Real chain slug for ChainIcon's own recognizable per-chain mark (real Bitcoin ₿, Solana bars, etc.) instead of a plain-text ticker abbreviation -- flagged live 2026-08-20 ("cant we get the currency symbol instead of writing BTC or avax or any of the shorthand tickers"). Defaults to "robinhood" (Marketplank's own chain) to match currencySymbol's own "ETH" default. */
  chainSlug?: string;
  /** Real chain-aware USD equivalent, precomputed by the caller via lib/multi-asset-price.ts (never fabricated). Omit to keep this card's own ETH-only EthUsdValue fetch (ListingGrid.tsx's native-chain case, where ETH is genuinely correct) -- explicit undefined vs. explicit null both mean "no USD figure," they just come from different reasons (not fetched yet vs. this currency has no price feed). */
  usdValue?: number | null;
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
  currencySymbol = "ETH",
  chainSlug = "robinhood",
  usdValue,
}: Props) {
  const isOffer = variant === "offer";
  // Presentational only -- swaps a shimmer placeholder for the art once the
  // real image paints, instead of the art popping in and shifting nothing
  // (aspect-square already reserves the space) but reading as "loaded" a
  // beat sooner than it did. Purely visual; no data this card reads depends
  // on it.
  const [imageLoaded, setImageLoaded] = useState(false);
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
      // Tier-tinted wash + border (tierCardStyle) and an escalating glow
      // ring (tierGlow) on top of the quiet base frame -- the same
      // whole-card treatment Gallery.tsx applies for RobinWood's own
      // tokens, now shared by any card carrying real rarity data
      // (RobinWood or a foreign collection indexed via
      // scripts/index-foreign-rarity.ts). Common gets no glow -- the
      // neutral baseline every other tier stands out against.
      className={`dense-card hover-glow-gold flex flex-col overflow-hidden p-0 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-line-strong ${
        isOffer ? "border-emerald-500/40" : ""
      } ${rarity ? tierAnimationClass(rarity.tier) : ""}`}
      style={rarity ? { ...tierCardStyle(rarity.tier), boxShadow: tierGlow(rarity.tier) } : undefined}
    >
      <div
        className={`relative aspect-square w-full bg-wood-900 ${
          selectable ? "cursor-pointer" : ""
        }`}
        role={selectable ? "button" : undefined}
        tabIndex={selectable ? 0 : undefined}
        aria-label={selectable ? `View ${displayTokenLabel({ tokenId: listing.tokenId, tokenName: listing.tokenName, rarityName: rarity?.name })}` : undefined}
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
        {/* Shimmer veil behind the art until it paints -- CSS-only,
            no layout shift since the aspect-square parent already reserves
            the space. Fades out via opacity once onLoad fires. */}
        <div
          aria-hidden="true"
          className={`skeleton-shimmer img-loading-veil absolute inset-0 ${imageLoaded ? "opacity-0" : "opacity-100"}`}
        />
        <Image
          // The token's own art, not the collection logo — a grid of identical
          // logos reads as broken. Falls back only if resolution failed.
          src={withImageWidth(preferHighestResImageUrl(listing.imageUrl) || listing.imageUrl, 512) || collection.image}
          alt={`${collection.name} ${displayTokenLabel({ tokenId: listing.tokenId, tokenName: listing.tokenName, rarityName: rarity?.name })}`}
          fill
          sizes="(min-width: 1024px) 20vw, 50vw"
          className={`object-contain transition-opacity duration-200 ${imageLoaded ? "opacity-100" : "opacity-0"}`}
          unoptimized
          onLoad={() => setImageLoaded(true)}
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
        {/* Chain badge removed from the artwork corner -- flagged live
            2026-08-20 ("i like the icon on price line, because thats the
            price. take it off the artists work"): the price line's own
            ChainIcon is the one place currency identity belongs, since it's
            actually attached to the number it describes. Repeating it here
            over the art was redundant, not clarifying. */}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2.5 sm:p-3">
        {trustLabels.length > 0 && (
          <p className="sr-only">Collection trust: {trustLabels.join(", ")}</p>
        )}
        <div className="min-w-0 leading-tight">
          <p
            className="truncate text-xs font-bold text-foreground sm:text-sm"
            title={listing.tokenId ? displayTokenLabel({ tokenId: listing.tokenId, tokenName: listing.tokenName, rarityName: rarity?.name }) : "Any plank"}
          >
            {listing.tokenId ? displayTokenLabel({ tokenId: listing.tokenId, tokenName: listing.tokenName, rarityName: rarity?.name }) : "Any plank"}
          </p>
          {listing.tokenId && (
            <p className="truncate text-[0.55rem] text-foreground/40">
              {shortTokenId(listing.tokenId)}
              {rarity ? ` · Rank ${rarity.rank}` : ""}
            </p>
          )}
        </div>
        <div className="mt-auto flex flex-col gap-1.5 pt-1">
          {/* Always stacked (Price full-width, action full-width below) --
              flagged live 2026-08-20 with real measured evidence: this grid
              is auto-fill with a 180-200px column floor, so card width
              barely changes across breakpoints (only column COUNT does). A
              conditional sm:flex-row here looked fine on a couple of
              widths tested but still squeezed price+icon into the same
              ~45px sliver at other real column counts (measured -14px
              overlap between the icon and the Buy button at 1253px/5-col).
              Always-stacked is the one layout proven safe at every width
              actually tested (360/640/1253/1440), not just the ones this
              session happened to check first -- and it gives the buy
              action a full-width, more-tappable target as a side benefit. */}
          <div className="min-w-0">
            <span className="block text-[0.55rem] font-black uppercase tracking-[0.12em] text-foreground/45">
              Price
            </span>
            <p
              className={`min-w-0 text-[clamp(0.95rem,4vw,1.25rem)] font-extrabold tabular-nums ${
                isOffer ? "text-emerald-300" : "text-gold-300"
              }`}
              aria-label={`${formatTokenAmount(listing.priceWei, 18, 4)} ${currencySymbol}`}
            >
              <span aria-hidden="true" className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                <span
                  className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
                  title={`${formatTokenAmount(listing.priceWei, 18, 8)} ${currencySymbol}`}
                >
                  {formatTokenAmountCompact(listing.priceWei, 18, 4)}
                </span>
                <ChainIcon chainSlug={chainSlug} size={20} className="inline-block shrink-0" />
              </span>
            </p>
            {usdValue === undefined ? (
              <EthUsdValue wei={listing.priceWei} className="block text-[clamp(0.6rem,2.4vw,0.75rem)] tabular-nums text-foreground/55" />
            ) : (
              usdValue != null && (
                <span className="block text-[clamp(0.6rem,2.4vw,0.75rem)] tabular-nums text-foreground/55">≈ {formatUsd(usdValue)}</span>
              )
            )}
          </div>
          {isForeignListing(listing) && !isCrossChainBuyable(listing) ? (
            /**
             * Foreign listing with no genuine fulfillment path: link out,
             * never a Buy button. PulpMarket's API exposes no signature at
             * all, and a Robinhood-Chain-native OpenSea row routes through a
             * conduit our own order-validation deliberately fails closed on
             * — a Buy here would be us promising a fill we cannot guarantee,
             * the exact failure that made stale listings revert for buyers.
             * A different label, a different colour and an outbound arrow
             * mean nobody clicks expecting one flow and lands in another.
             *
             * Keyed on isForeignListing && !isCrossChainBuyable, never on one
             * venue literal: a comparison against "opensea" would drop every
             * other foreign venue (or a legitimately buyable cross-chain
             * OpenSea row) into the wrong branch.
             */
            <a
              href={listing.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-11 w-full items-center justify-center gap-1 rounded-md border border-[#58BDF0]/40 px-2 text-xs font-bold text-[#58BDF0] transition hover:border-[#58BDF0] sm:px-3 sm:text-sm"
            >
              View
              <ExternalLink size={12} strokeWidth={2.5} aria-hidden />
              <span className="sr-only">on {venueLabel(listing)}, opens in a new tab</span>
            </a>
          ) : relistRequired ? (
            <span
              role="status"
              title={MARKETPLANK_RELIST_MESSAGE}
              className="flex min-h-11 w-full items-center justify-center rounded-md border border-red-400/60 bg-red-950/40 px-2 text-center text-[0.62rem] font-bold leading-tight text-red-100"
            >
              <span>
                <span className="block uppercase tracking-wide">Relist required</span>
                <span className="mt-0.5 block text-[0.55rem] font-semibold text-red-100/75">
                  Unlist + relist to buy
                </span>
              </span>
            </span>
          ) : (
            <button
              type="button"
              disabled={!canFill}
              onClick={() => onBuy?.(listing)}
              title={
                !canFill
                  ? "You don't own a plank this bid can take."
                  : isCrossChainBuyable(listing)
                    ? // Fee stated in THIS trade's own terms, not a blanket
                      // number — surface-contracts.md's fee rule ("never
                      // present one fee model as if it applied to all of
                      // them") extended from vault copy to this cross-chain
                      // path, since the foreign fee (1.8%, MarketplankForeignFeeRouter)
                      // is genuinely different from the native Marketplank
                      // fee model this same button uses elsewhere.
                      `Settles on ${chainDisplayName(listing.foreignChainSlug!)} via ${venueLabel(listing)}. A 1.8% Marketplank fee is added on top of the listed price.`
                    : undefined
              }
              className={`min-h-11 w-full rounded-md px-2 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-100 sm:px-3 sm:text-sm ${
                isOffer
                  ? "bg-emerald-500 text-wood-950 hover:bg-emerald-400"
                  : "bg-gold-500 text-wood-950 hover:bg-gold-400"
              }`}
            >
              {buyLabel ?? "Buy"}
            </button>
          )}
        </div>
        {!isOffer && (
          /**
           * Labelled on BOTH venues, not just the foreign one. Marking only
           * OpenSea would make "unmarked" mean "ours" — an inference, and
           * inferences fail for anyone landing mid-scroll. Explicit costs a
           * little more ink and removes the ambiguity entirely.
           *
           * A cross-chain-buyable row adds the chain name too ("OpenSea ·
           * Base") — venue alone would leave a real Buy button next to a
           * price with no indication it settles on a different chain than
           * the one the wallet is currently connected to.
           */
          // Softer, non-alert styling -- flagged live 2026-08-20 ("the
          // unisat bitcoin ordinals text looks like a warning"): the old
          // uppercase/tracking-wider/font-black pill used near-identical
          // typography to the actual Relist-required warning a few lines
          // up, so a purely informational "where this is listed" tag read
          // as a caution notice. Normal case, lighter weight, same
          // per-venue brand color (still a real, useful at-a-glance
          // signal, just not shouting). The chain name suffix is now ONLY
          // shown for the cross-chain-buyable case, where it's genuinely
          // safety-relevant (settles on a different chain than the one
          // connected) -- for every other row the price line's own
          // ChainIcon already says which chain this is, so repeating it
          // here was the same redundancy already fixed on the artwork
          // corner badge.
          <span
            className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[0.6rem] font-semibold ${
              VENUE_BADGE_CLASS[listing.venue ?? "marketplank"]
            }`}
          >
            {venueLabel(listing)}
            {isCrossChainBuyable(listing) && listing.foreignChainSlug ? ` · ${chainDisplayName(listing.foreignChainSlug)}` : ""}
          </span>
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
                  isForeignListing(listing)
                    ? `Creates a separate Marketplank offer; it does not modify the ${venueLabel(listing)} listing.`
                    : undefined
                }
                className="min-h-11 flex-1 rounded-md border border-line-strong text-xs font-bold text-gold-300 transition hover:border-gold-400 sm:text-sm"
              >
                {isForeignListing(listing) ? "Make offer" : "Offer"}
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
