"use client";

import Link from "next/link";
import { chainDisplayName } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { GLOBAL_MARKET_ENABLED } from "@/lib/constants";

type Props = {
  variant: "native" | "hub" | "collection";
  chainSlug?: string;
  collectionName?: string;
};

/** Bidirectional path between RobinWood /market and global collections. Not a hover menu. */
export default function MarketBreadcrumb({ variant, chainSlug, collectionName }: Props) {
  if (variant === "native") {
    // While the global surface is gated, /market must not advertise a door to
    // it. MarketMenu already hides its Global tile, chain chips and
    // known-limitations link on this flag; this breadcrumb was the one route
    // in that still pointed a visitor at the unopened marketplace.
    if (!GLOBAL_MARKET_ENABLED) return null;
    return (
      <nav aria-label="Market location" className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-bold text-foreground/70">RobinWood Market</span>
        <span className="text-foreground/30" aria-hidden>
          ·
        </span>
        <Link href="/market/multichain" className="font-bold text-gold-300 hover:text-gold-200">
          Global collections →
        </Link>
      </nav>
    );
  }
  if (variant === "hub") {
    return (
      <nav aria-label="Market location" className="flex flex-wrap items-center gap-2 text-xs">
        <Link href="/market" className="font-bold text-gold-300 hover:text-gold-200">
          ← RobinWood Market
        </Link>
        <span className="text-foreground/30" aria-hidden>
          /
        </span>
        <span className="font-bold text-foreground/70">Global collections</span>
      </nav>
    );
  }
  return (
    <nav aria-label="Market location" className="flex flex-wrap items-center gap-2 text-xs">
      <Link href="/market" className="font-bold text-gold-300 hover:text-gold-200">
        ← RobinWood
      </Link>
      <span className="text-foreground/30" aria-hidden>
        /
      </span>
      <Link href="/market/multichain" className="font-bold text-gold-300 hover:text-gold-200">
        Global
      </Link>
      {chainSlug ? (
        <>
          <span className="text-foreground/30" aria-hidden>
            /
          </span>
          <Link
            href={`/market/multichain?chains=${encodeURIComponent(chainSlug)}`}
            className="font-bold text-gold-300 hover:text-gold-200"
          >
            {chainDisplayName(chainSlug)}
          </Link>
        </>
      ) : null}
      {collectionName ? (
        <>
          <span className="text-foreground/30" aria-hidden>
            /
          </span>
          <span className="truncate font-bold text-foreground/70">{collectionName}</span>
        </>
      ) : null}
    </nav>
  );
}
