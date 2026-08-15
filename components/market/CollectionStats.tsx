"use client";

import { useEffect, useState } from "react";
import { formatTokenAmount } from "@/lib/trade";
import type { Listing, MarketCollection } from "@/lib/market/types";
import { swrJson } from "@/lib/market/swr-fetch";
import EthUsdValue from "@/components/market/EthUsdValue";

type Props = {
  collection: MarketCollection;
  listings: Listing[];
  offers: Listing[];
  /** Total minted supply, if known. */
  totalSupply?: number;
};

/**
 * Floor / listed / items / best offer / record sale strip.
 * Live book fields come from orders we hold; highest sale is from full
 * on-chain activity (same catalog as the Activity tab / EventCountdown).
 */
export default function CollectionStats({
  collection,
  listings,
  offers,
  totalSupply,
}: Props) {
  const [recordWei, setRecordWei] = useState<string | null>(null);
  const [volumeWei, setVolumeWei] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    swrJson<{
      highestWei?: string | null;
      highestPlatform?: string | null;
      totalVolumeWei?: string | null;
    }>("/api/market/sales-stats", {
      ttlMs: 60_000,
      swrMs: 300_000,
      session: true,
    })
      .then((data) => {
        if (cancelled) return;
        setRecordWei(data.highestWei ?? null);
        setVolumeWei(data.totalVolumeWei ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setRecordWei(null);
        setVolumeWei(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const floorWei = listings.reduce<bigint | null>((min, l) => {
    const v = BigInt(l.priceWei);
    return min === null || v < min ? v : min;
  }, null);

  const bestOfferWei = offers.reduce<bigint | null>((max, o) => {
    const v = BigInt(o.priceWei);
    return max === null || v > max ? v : max;
  }, null);

  // Finalized-mockup order and labels: Floor price · Items · Listed · Best
  // offer · Volume · Highest sale.
  //
  // "Volume" is every royalty-paid secondary sale of this collection on
  // Robinhood Chain, whichever venue settled it — the catalog gates on the
  // EIP-2981 royalty leg, not on who executed the trade, so OpenSea fills
  // already count. It is deliberately not labelled "Marketplank volume":
  // claiming another venue's trades as our own would be a lie, and excluding
  // them would understate the collection.
  // "Floor price" spans every venue too, for the same reason and one more:
  // this chip sits directly above a grid that DISPLAYS foreign listings, so a
  // floor that ignored the cheapest visible card would contradict the page in
  // front of the reader. It is the real floor of the collection, not the floor
  // of our own book.
  //
  // /discover and the trending rail deliberately do NOT match this — see the
  // note in lib/market/trending.ts. Those numbers can legitimately differ.
  const stats: { label: string; value: string; wei?: string | bigint | null }[] = [
    {
      label: "Floor price",
      value: floorWei === null ? "—" : `${formatTokenAmount(floorWei, 18, 4)} Ξ`,
      wei: floorWei,
    },
    { label: "Items", value: totalSupply ? totalSupply.toLocaleString() : "—" },
    {
      label: "Listed",
      value: totalSupply
        ? `${listings.length.toLocaleString()} / ${totalSupply.toLocaleString()}`
        : String(listings.length),
    },
    {
      label: "Best offer",
      value: bestOfferWei === null ? "—" : `${formatTokenAmount(bestOfferWei, 18, 4)} WETH`,
      wei: bestOfferWei,
    },
    {
      label: "Volume",
      value: volumeWei == null ? "…" : `${formatTokenAmount(volumeWei, 18, 3)} Ξ`,
      wei: volumeWei,
    },
    {
      label: "Highest sale",
      value: recordWei == null ? "…" : `${formatTokenAmount(recordWei, 18, 4)} Ξ`,
      wei: recordWei,
    },
  ];

  return (
    <dl className="flex gap-px overflow-x-auto rounded-xl border border-line bg-gold-500/20 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:grid sm:grid-cols-6 sm:overflow-hidden">
      {stats.map((s) => (
        <div
          key={s.label}
          className="min-w-[7rem] flex-1 bg-panel px-3 py-2 text-center sm:min-w-0"
        >
          <dt className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">
            {s.label}
          </dt>
          <dd className="font-display text-base text-gold-300 tabular-nums sm:text-lg">
            {s.value}
            {s.wei && <EthUsdValue wei={s.wei} className="block font-sans text-[0.62rem] text-foreground/50" />}
          </dd>
        </div>
      ))}
      <span className="sr-only">{collection.name} collection statistics</span>
    </dl>
  );
}
