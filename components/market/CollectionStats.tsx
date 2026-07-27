import { formatTokenAmount } from "@/lib/trade";
import type { Listing, MarketCollection } from "@/lib/market/types";

type Props = {
  collection: MarketCollection;
  listings: Listing[];
  offers: Listing[];
  /** Total minted supply, if known. */
  totalSupply?: number;
};

/**
 * Floor / listed / items / best offer strip. Every major marketplace leads
 * with these, and without a floor price a user has no way to judge whether a
 * given ask is cheap — the single element whose absence most makes a page
 * fail to read as a marketplace.
 *
 * Everything here is computed from orders we already hold; nothing is
 * estimated or filled in with a placeholder.
 */
export default function CollectionStats({
  collection,
  listings,
  offers,
  totalSupply,
}: Props) {
  const floorWei = listings.reduce<bigint | null>((min, l) => {
    const v = BigInt(l.priceWei);
    return min === null || v < min ? v : min;
  }, null);

  const bestOfferWei = offers.reduce<bigint | null>((max, o) => {
    const v = BigInt(o.priceWei);
    return max === null || v > max ? v : max;
  }, null);

  const stats: { label: string; value: string }[] = [
    { label: "Floor", value: floorWei === null ? "—" : `${formatTokenAmount(floorWei, 18, 4)} Ξ` },
    { label: "Listed", value: String(listings.length) },
    { label: "Items", value: totalSupply ? totalSupply.toLocaleString() : "—" },
    {
      label: "Best offer",
      value: bestOfferWei === null ? "—" : `${formatTokenAmount(bestOfferWei, 18, 4)} Ξ`,
    },
  ];

  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-gold-500/20 bg-gold-500/20 sm:grid-cols-4">
      {stats.map((s) => (
        <div key={s.label} className="bg-wood-900/90 px-3 py-2 text-center">
          <dt className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">
            {s.label}
          </dt>
          <dd className="font-display text-base text-gold-300 tabular-nums sm:text-lg">
            {s.value}
          </dd>
        </div>
      ))}
      <span className="sr-only">{collection.name} collection statistics</span>
    </dl>
  );
}
