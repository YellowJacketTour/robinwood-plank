"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { formatTokenAmount } from "@/lib/trade";
import { collectionFloorWei } from "@/lib/market/floors";
import { swrJson } from "@/lib/market/swr-fetch";
import type { Listing } from "@/lib/market/types";

/**
 * Live secondary-market snapshot for the sold-out mint panel — replaces the
 * old static art frame with real Buy & Sell book data (DESIGN.md: never
 * hardcode floor/listed/sale figures). Reuses the same order book + sales
 * catalog endpoints and floor helper the Buy & Sell tab uses.
 */
export default function MarketSnapshot() {
  const [floorWei, setFloorWei] = useState<bigint | null>(null);
  const [listed, setListed] = useState<number | null>(null);
  const [highestWei, setHighestWei] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    swrJson<{ items: Listing[] }>("/api/market/orders?collection=robinwood&kind=listing", {
      ttlMs: 20_000,
      swrMs: 120_000,
      session: true,
    })
      .then((data) => {
        if (cancelled) return;
        const items = data.items || [];
        setFloorWei(collectionFloorWei(items));
        setListed(items.length);
      })
      .catch(() => {
        /* leave dashes — never fabricate a floor */
      });

    swrJson<{ highestWei?: string | null }>("/api/market/sales-stats", {
      ttlMs: 60_000,
      swrMs: 300_000,
      session: true,
    })
      .then((data) => {
        if (!cancelled) setHighestWei(data.highestWei ?? null);
      })
      .catch(() => {
        /* leave dashes */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="dense-card wood-grain-surface relative flex min-h-[280px] items-end overflow-hidden">
      <Image
        src="/images/collection/plank-knightwood.png"
        alt=""
        aria-hidden="true"
        fill
        sizes="360px"
        className="object-cover object-[center_22%] opacity-60"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-t from-wood-950/95 via-wood-950/25 to-transparent"
      />
      <div className="relative w-full p-5">
        <p className="text-[0.65rem] font-black uppercase tracking-[0.14em] text-gold-300">
          Marketplank · live
        </p>
        <h3 className="mt-1 font-display text-xl text-foreground">Secondary market snapshot</h3>
        <div className="mt-3.5 mb-4 flex gap-4">
          <div className="flex-1">
            <span className="block text-[0.6rem] font-black uppercase tracking-wide text-foreground/55">
              Floor
            </span>
            <strong className="mt-1 block font-display text-base font-normal text-gold-300">
              {floorWei != null ? `${formatTokenAmount(floorWei, 18, 4)} Ξ` : "—"}
            </strong>
          </div>
          <div className="flex-1">
            <span className="block text-[0.6rem] font-black uppercase tracking-wide text-foreground/55">
              Listed
            </span>
            <strong className="mt-1 block font-display text-base font-normal text-gold-300">
              {listed != null ? listed.toLocaleString() : "—"}
            </strong>
          </div>
          <div className="flex-1">
            <span className="block text-[0.6rem] font-black uppercase tracking-wide text-foreground/55">
              Highest sale
            </span>
            <strong className="mt-1 block font-display text-base font-normal text-gold-300">
              {highestWei ? `${formatTokenAmount(highestWei, 18, 4)} Ξ` : "—"}
            </strong>
          </div>
        </div>
        <Link
          href="/market"
          className="inline-flex min-h-9 items-center rounded-lg border border-line-strong px-3 text-xs font-bold text-gold-300 transition hover:border-gold-400"
        >
          Open Market ↗
        </Link>
      </div>
    </div>
  );
}
