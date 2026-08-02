import type { MarketTab } from "@/lib/market/types";

/**
 * Canonical Marketplank navigation contract. Labels may be restyled, but IDs
 * are public URL state and must remain stable for shared links and history.
 */
export const MARKET_TABS: ReadonlyArray<{ id: MarketTab; label: string }> = [
  { id: "buy-sell", label: "Buy & Sell" },
  { id: "swap", label: "Instant Swap" },
  { id: "offers", label: "Offers" },
  { id: "activity", label: "Activity" },
  { id: "my-nfts", label: "My NFTs" },
  { id: "positions", label: "My Listings" },
];
