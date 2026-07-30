"use client";

import { useEffect, useState } from "react";
import { formatTokenAmount } from "@/lib/trade";
import type { Listing, MarketCollection } from "@/lib/market/types";
import { swrJson } from "@/lib/market/swr-fetch";

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

  useEffect(() => {
    let cancelled = false;
    swrJson<{ highestWei?: string | null; highestPlatform?: string | null }>(
      "/api/market/sales-stats",
      {
        ttlMs: 60_000,
        swrMs: 300_000,
        session: true,
      }
    )
      .then((data) => {
        if (!cancelled) setRecordWei(data.highestWei ?? null);
      })
      .catch(() => {
        if (!cancelled) setRecordWei(null);
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
  // offer · Highest sale.
  const stats: { label: string; value: string }[] = [
    {
      label: "Floor price",
      value: floorWei === null ? "—" : `${formatTokenAmount(floorWei, 18, 4)} Ξ`,
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
    },
    {
      label: "Highest sale",
      value: recordWei == null ? "…" : `${formatTokenAmount(recordWei, 18, 4)} Ξ`,
    },
  ];

  return (
    <dl className="flex gap-px overflow-x-auto rounded-lg border border-line bg-gold-500/20 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:grid sm:grid-cols-5 sm:overflow-hidden">
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
          </dd>
        </div>
      ))}
      <span className="sr-only">{collection.name} collection statistics</span>
    </dl>
  );
}
