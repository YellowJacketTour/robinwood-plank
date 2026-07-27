"use client";

import { useState } from "react";
import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";
import MarketNav from "@/components/market/MarketNav";
import ListingGrid from "@/components/market/ListingGrid";
import SwapPanel from "@/components/market/SwapPanel";
import MyPositions from "@/components/market/MyPositions";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import type { Listing, MarketTab } from "@/lib/market/types";

/**
 * Wired to a real order-relay API once one exists (SPEC.md §5). Empty for now —
 * this component only renders at all when MARKET_ENABLED is true, and that flag
 * doesn't flip until the contracts backing it are deployed and audited.
 */
const LISTINGS: Listing[] = [];
const OFFER_LISTINGS: Listing[] = [];

export default function MarketView() {
  const [tab, setTab] = useState<MarketTab>("buy-sell");

  return (
    <div className="space-y-5">
      <Reveal>
        <SectionHead
          eyebrow="RobinWood Chain · Marketplank"
          title="Marketplank"
          lede="List, buy, sell, and make offers on RobinWood."
        />
      </Reveal>

      <Reveal delayMs={40}>
        <MarketNav active={tab} onChange={setTab} />
      </Reveal>

      <Reveal delayMs={70}>
        {tab === "buy-sell" && (
          <ListingGrid
            listings={LISTINGS}
            collections={MARKET_COLLECTIONS}
            emptyMessage="No active listings yet — be the first to list a plank."
          />
        )}
        {tab === "offers" && (
          <ListingGrid
            listings={OFFER_LISTINGS}
            collections={MARKET_COLLECTIONS}
            emptyMessage="No open offers yet."
          />
        )}
        {tab === "swap" && <SwapPanel />}
        {tab === "positions" && <MyPositions />}
      </Reveal>
    </div>
  );
}
