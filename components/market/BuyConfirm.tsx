"use client";

import Image from "next/image";
import { withImageWidth } from "@/lib/ipfs";
import { formatTokenAmount, shortAddress } from "@/lib/trade";
import { BUY_GAS_RESERVE_ETH } from "@/lib/constants";
import type { Listing, MarketCollection } from "@/lib/market/types";
import EthUsdValue from "@/components/market/EthUsdValue";

type Props = {
  listing: Listing;
  collection: MarketCollection;
  /** Price re-derived from the signed order, not the listing metadata. */
  verifiedPriceWei: string;
  busy: boolean;
  /** Why the last attempt failed, shown inside this dialog. A buyer whose
   *  purchase fails is looking HERE, not at the page behind the modal — a real
   *  one hit an error, found nothing on screen, and only saw the reason by
   *  opening the browser console. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Checkout step. Every major marketplace interposes one between clicking Buy
 * and the wallet prompt, and its absence is the single biggest trust-killer —
 * being asked to sign an unexplained transaction.
 *
 * The price shown here is the one re-derived from the signed order in the
 * buyer's own browser, so what they read is provably what they will sign.
 */
export default function BuyConfirm({
  listing,
  collection,
  verifiedPriceWei,
  busy,
  error,
  onConfirm,
  onCancel,
}: Props) {
  // Ask the proxy for a thumbnail tier, and skip Next's optimizer, exactly as
  // ListingCard/ItemDetail/MyNfts do. `/api/ipfs/image?…` is a route, not a
  // static asset: routing it through /_next/image returns 400 ("url" parameter
  // is not allowed), which rendered a broken thumbnail on the one screen where
  // a buyer is confirming they want to spend money. Every other Image call site
  // in the market already pairs withImageWidth with unoptimized; this was the
  // only one that did not.
  const image = withImageWidth(listing.imageUrl, 64) || collection.image;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm purchase"
    >
      <div className="wood-ledger w-full max-w-sm space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-gold-300">Confirm</h3>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="flex h-8 w-8 items-center justify-center rounded-full text-foreground/60 hover:text-gold-300"
          >
            ✕
          </button>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-wood-900">
            <Image
              src={image}
              alt={`${collection.name} #${listing.tokenId}`}
              fill
              sizes="64px"
              className="object-cover"
              unoptimized={Boolean(listing.imageUrl)}
            />
          </div>
          <div className="min-w-0">
            <p className="truncate font-display text-base text-foreground">
              {collection.name} #{listing.tokenId}
            </p>
            <p className="truncate text-[0.65rem] text-foreground/45">
              from {shortAddress(listing.maker)}
            </p>
          </div>
        </div>

        <dl className="space-y-1 rounded-lg border border-line bg-panel px-3 py-2 text-xs">
          <div className="flex justify-between">
            <dt className="text-foreground/60">Price</dt>
            <dd className="text-right tabular-nums text-foreground">
              <span className="block">{formatTokenAmount(verifiedPriceWei, 18, 6)} Ξ</span>
              <EthUsdValue wei={verifiedPriceWei} className="block text-[0.65rem] text-foreground/50" />
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-foreground/60">Marketplace fee</dt>
            <dd className="tabular-nums text-foreground">
              {collection.feeBps > 0
                ? `${(collection.feeBps / 100).toFixed(2)}% (included)`
                : "None"}
            </dd>
          </div>
          <div className="flex justify-between border-t border-line pt-1">
            <dt className="font-bold text-foreground">You pay</dt>
            <dd className="text-right font-display tabular-nums text-gold-300">
              <span className="block">{formatTokenAmount(verifiedPriceWei, 18, 6)} Ξ</span>
              <EthUsdValue wei={verifiedPriceWei} className="block font-sans text-xs text-foreground/55" />
            </dd>
          </div>
        </dl>

        <p className="text-center text-[0.6rem] text-foreground/40">
          Plus network gas. Keep ~{BUY_GAS_RESERVE_ETH} Ξ free.
        </p>

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-red-500/35 bg-red-950/25 px-3 py-2.5 text-sm text-red-100"
          >
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-50"
        >
          {busy ? "Confirm in wallet…" : "Buy now"}
        </button>
      </div>
    </div>
  );
}
